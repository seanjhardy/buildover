import { useEffect, useRef, useState } from "react";

export type TranscriptionState =
  | "idle"
  | "recording"
  | "transcribing"
  | "error";

interface Options {
  onTranscript: (text: string, isFinal: boolean) => void;
  intervalMs?: number;
}

export function useTranscription(opts: Options) {
  const intervalMs = opts.intervalMs ?? 4000;

  const [state, setState] = useState<TranscriptionState>("idle");
  const [error, setError] = useState<string | null>(null);

  const onTranscriptRef = useRef(opts.onTranscript);
  onTranscriptRef.current = opts.onTranscript;

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<number | null>(null);
  const inflightRef = useRef<AbortController | null>(null);
  const mimeRef = useRef<string>("audio/webm");
  // Text from the seed blob (pre-detection audio). Prepended to all
  // subsequent recorder transcripts so Whisper's rolling output is combined
  // with the words spoken before/during the wake word trigger.
  const seedTextRef = useRef<string>("");

  const cleanupTracks = () => {
    if (intervalRef.current != null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    inflightRef.current?.abort();
    inflightRef.current = null;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    chunksRef.current = [];
  };

  useEffect(() => () => cleanupTracks(), []);

  const sendChunks = async (isFinal: boolean) => {
    if (chunksRef.current.length === 0) return;
    // Cumulative resend: combine all chunks so far into a single self-contained
    // file. This is wasteful but Whisper produces stable transcripts that we
    // simply replace on each tick.
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    inflightRef.current?.abort();
    const ac = new AbortController();
    inflightRef.current = ac;
    try {
      const r = await fetch(
        `/api/transcribe?mime=${encodeURIComponent(mimeRef.current)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: blob,
          signal: ac.signal,
        },
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Transcription failed (${r.status})`);
      }
      const j = (await r.json()) as { text: string };
      // Prepend seed text (words before/during the wake word trigger) so that
      // recorder transcripts are combined with the pre-detection audio text.
      const seed = seedTextRef.current;
      const recText = j.text ?? "";
      const combined = seed
        ? seed + (recText && !/\s$/.test(seed) ? " " : "") + recText
        : recText;
      onTranscriptRef.current(combined, isFinal);
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  };

  const start = async (seedBlob?: Blob) => {
    setError(null);
    seedTextRef.current = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : MediaRecorder.isTypeSupported("audio/mp4")
            ? "audio/mp4"
            : "";
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      mimeRef.current = recorder.mimeType || "audio/webm";
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      // 1s timeslice keeps chunk granularity small enough for periodic sends.
      recorder.start(1000);
      setState("recording");

      intervalRef.current = window.setInterval(() => {
        void sendChunks(false);
      }, intervalMs);

      // If a seed blob is provided (e.g. pre-detection audio captured by the
      // ring buffer before the wake word fired), transcribe it immediately and
      // emit the result as an initial partial transcript. This ensures that
      // words spoken during or immediately after the wake word phrase are not
      // lost during MediaRecorder startup.
      // The seed is transcribed independently (it's a WAV blob, which has a
      // different container format from the WebM chunks the recorder produces,
      // so they cannot be concatenated). Subsequent recorder polls will
      // continue appending to the transcript from that point forward.
      if (seedBlob) {
        void (async () => {
          try {
            const seedMime = seedBlob.type || "audio/wav";
            const r = await fetch(
              `/api/transcribe?mime=${encodeURIComponent(seedMime)}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: seedBlob,
              },
            );
            if (r.ok) {
              const j = (await r.json()) as { text: string };
              if (j.text) {
                // Store so sendChunks can prepend it to all subsequent polls.
                seedTextRef.current = j.text;
                // Emit immediately so the composer shows text right away.
                onTranscriptRef.current(j.text, false);
              }
            }
          } catch {
            // Non-fatal: if seed transcription fails, recording continues
            // normally from the MediaRecorder output.
          }
        })();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
      cleanupTracks();
    }
  };

  const stop = async () => {
    if (state !== "recording") return;
    setState("transcribing");

    if (intervalRef.current != null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      });
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    // Cancel any in-flight partial transcription so the final one wins.
    inflightRef.current?.abort();
    inflightRef.current = null;

    await sendChunks(true);
    chunksRef.current = [];
    setState((s) => (s === "error" ? s : "idle"));
  };

  const cancel = () => {
    cleanupTracks();
    seedTextRef.current = "";
    setState("idle");
    setError(null);
  };

  return { state, error, start, stop, cancel };
}
