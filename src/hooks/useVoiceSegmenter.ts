import { useCallback, useEffect, useRef, useState } from "react";
import { useTranscription, type TranscriptionState } from "./useTranscription.js";

export interface UseVoiceSegmenterOptions {
  // Called once a complete, cleaned thought has been extracted.
  onSegment: (cleanedText: string) => void;
}

export interface UseVoiceSegmenterReturn {
  state: TranscriptionState;
  // Current pending transcript chunk (everything since the last successful
  // segmentation). Drives the live-text display in the bar.
  pendingText: string;
  // True while we're waiting for Haiku to classify the current pending text.
  classifying: boolean;
  error: string | null;
  // Toggle mic. An optional seedBlob (pre-detection WAV audio) can be passed
  // so that words spoken immediately before/after a wake word are not lost.
  start: (seedBlob?: Blob) => Promise<void>;
  stop: () => Promise<void>;
  // "Send now" — bypass Haiku and emit pending text as-is. No-op if empty.
  flushNow: () => void;
}

// Silence required before we ask Haiku whether the user finished their
// thought. Just under the 4s Whisper interval — once one full Whisper poll
// confirms no growth in the transcript, we consider the user done speaking.
const SILENCE_MS = 3000;
const TICK_MS = 500;
const MIN_PENDING_CHARS = 8;
const MIN_PENDING_WORDS = 3;

export function useVoiceSegmenter(
  opts: UseVoiceSegmenterOptions,
): UseVoiceSegmenterReturn {
  const onSegmentRef = useRef(opts.onSegment);
  onSegmentRef.current = opts.onSegment;

  const [transcript, setTranscript] = useState("");
  const [committedLength, setCommittedLength] = useState(0);
  const [classifying, setClassifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs mirror state so the polling interval (set up once with empty deps)
  // can read current values without a stale closure. Without these the
  // interval kept seeing the first render's empty transcript and never
  // fired the segmenter.
  const transcriptRef = useRef("");
  const committedLengthRef = useRef(0);
  const stateRef = useRef<TranscriptionState>("idle");
  const lastChangeAtRef = useRef<number>(Date.now());
  const lastClassifiedTextRef = useRef<string>("");
  const inflightRef = useRef<AbortController | null>(null);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);
  useEffect(() => {
    committedLengthRef.current = committedLength;
  }, [committedLength]);

  const transcription = useTranscription({
    intervalMs: 4000,
    onTranscript: (text) => {
      // Only treat the transcript as "changed" when it has grown — Whisper
      // sometimes rewrites past portions during silence (punctuation /
      // capitalization tweaks), and reacting to those would reset the
      // silence timer indefinitely and prevent the segmenter from ever
      // firing. New speech always lengthens the transcript.
      if (text.length > transcriptRef.current.length) {
        lastChangeAtRef.current = Date.now();
      }
      setTranscript(text);
    },
  });

  useEffect(() => {
    stateRef.current = transcription.state;
  }, [transcription.state]);

  const pendingText = transcript.slice(
    Math.min(committedLength, transcript.length),
  );

  // Single long-lived interval. Reads everything from refs so it always sees
  // the latest values.
  useEffect(() => {
    const id = window.setInterval(() => {
      void (async () => {
        if (inflightRef.current) return;
        if (stateRef.current !== "recording") return;

        const t = transcriptRef.current;
        const c = committedLengthRef.current;
        const pending = t.slice(Math.min(c, t.length)).trim();

        if (!pending) return;
        if (pending.length < MIN_PENDING_CHARS) return;
        if (pending.split(/\s+/).filter(Boolean).length < MIN_PENDING_WORDS) {
          return;
        }
        if (Date.now() - lastChangeAtRef.current < SILENCE_MS) return;
        if (pending === lastClassifiedTextRef.current) return;

        const ac = new AbortController();
        inflightRef.current = ac;
        setClassifying(true);
        lastClassifiedTextRef.current = pending;

        try {
          const r = await fetch("/api/segment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: pending }),
            signal: ac.signal,
          });
          if (!r.ok) {
            setError(`Segmenter HTTP ${r.status}`);
            return;
          }
          const result = (await r.json()) as {
            complete: boolean;
            cleanedText?: string;
            rateLimited?: boolean;
          };
          if (result.complete && result.cleanedText) {
            // Advance committed pointer to the *current* transcript length
            // — anything that arrived during the classifier round-trip
            // becomes the next pending chunk.
            const newCommitted = transcriptRef.current.length;
            committedLengthRef.current = newCommitted;
            setCommittedLength(newCommitted);
            lastClassifiedTextRef.current = "";
            onSegmentRef.current(result.cleanedText);
          }
          // Otherwise: leave committedLength alone. The rejected text in
          // lastClassifiedTextRef prevents another Haiku call until pending
          // grows beyond it.
        } catch (e) {
          if ((e as { name?: string }).name === "AbortError") return;
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          inflightRef.current = null;
          setClassifying(false);
        }
      })();
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const start = useCallback(async (seedBlob?: Blob) => {
    setError(null);
    setTranscript("");
    setCommittedLength(0);
    transcriptRef.current = "";
    committedLengthRef.current = 0;
    lastChangeAtRef.current = Date.now();
    lastClassifiedTextRef.current = "";
    await transcription.start(seedBlob);
  }, [transcription]);

  const stop = useCallback(async () => {
    inflightRef.current?.abort();
    inflightRef.current = null;
    await transcription.stop();
    // Note: pending text remains visible after stop; user can hit flushNow.
  }, [transcription]);

  const flushNow = useCallback(() => {
    const t = transcriptRef.current;
    const c = committedLengthRef.current;
    const pending = t.slice(Math.min(c, t.length)).trim();
    if (!pending) return;
    const newCommitted = t.length;
    committedLengthRef.current = newCommitted;
    setCommittedLength(newCommitted);
    lastClassifiedTextRef.current = "";
    onSegmentRef.current(pending);
  }, []);

  return {
    state: transcription.state,
    pendingText,
    classifying,
    error: error ?? transcription.error,
    start,
    stop,
    flushNow,
  };
}
