/**
 * useAudioRingBuffer — always-on PCM audio ring buffer.
 *
 * Maintains a rolling window of the last `bufferSeconds` of raw microphone
 * audio as Float32 PCM at 16 kHz. When the wake word is detected, call
 * `extractBlob(seconds)` to encode the most recent N seconds as a standard
 * 16-bit mono WAV blob. This blob can then be passed to `useTranscription`
 * as a seed so that Groq Whisper sees the audio spoken immediately after
 * (or even slightly before) the wake word trigger — solving the problem
 * where the first words of a command are lost during MediaRecorder startup.
 *
 * Architecture
 * ────────────
 * A separate getUserMedia stream (16 kHz mono) is opened when `start()` is
 * called. This stream is independent of the WakeWordEngine's stream and the
 * Composer's MediaRecorder stream — the browser allows multiple concurrent
 * streams from the same physical device.
 *
 * A ScriptProcessorNode (widely supported; AudioWorkletNode is the modern
 * replacement but requires serving an extra worker script) captures 4096-
 * sample chunks and pushes them into a circular buffer of Float32Arrays.
 * The buffer is capped at `bufferSeconds` worth of audio (default: 5s).
 *
 * WAV encoding
 * ────────────
 * `extractBlob(seconds)` concatenates the tail of the ring buffer,
 * down-samples if needed (the AudioContext runs at 16 kHz to match
 * openWakeWord's pipeline, so no resampling is required), and encodes as
 * a standard RIFF/WAV file (PCM, 16-bit, mono). The resulting Blob has
 * MIME type "audio/wav" and is accepted directly by Groq's Whisper API.
 */

import { useCallback, useEffect, useRef } from "react";

const SAMPLE_RATE = 16_000; // Hz — matches openWakeWord's pipeline
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096; // samples per callback

interface UseAudioRingBufferOptions {
  /** Total seconds of audio to keep in the ring buffer. Default: 5 */
  bufferSeconds?: number;
}

interface UseAudioRingBufferReturn {
  /** Open the mic and begin buffering audio. */
  start: () => Promise<void>;
  /** Stop the mic and clear the buffer. */
  stop: () => void;
  /**
   * Encode the most recent `seconds` of buffered PCM audio as a WAV Blob
   * and then immediately clear the buffer so the next call starts fresh.
   * Returns null if there is no buffered audio yet.
   * Safe to call at any time (including after stop()).
   */
  extractBlob: (seconds: number) => Blob | null;
  /** Discard all buffered audio without stopping the mic. */
  clear: () => void;
}

// ── WAV encoding helpers ─────────────────────────────────────────────────────

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Encode a Float32 PCM array as a 16-bit mono WAV Blob.
 * Samples should be in the range [-1, 1]; values outside this range are clamped.
 */
function float32ToWav(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const byteCount = numSamples * 2; // 16-bit = 2 bytes per sample
  const buffer = new ArrayBuffer(44 + byteCount);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + byteCount, true);      // file size - 8
  writeString(view, 8, "WAVE");

  // fmt sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);                  // sub-chunk size (PCM = 16)
  view.setUint16(20, 1, true);                   // audio format: PCM
  view.setUint16(22, 1, true);                   // channels: mono
  view.setUint32(24, sampleRate, true);           // sample rate
  view.setUint32(28, sampleRate * 2, true);       // byte rate (sr * channels * bps/8)
  view.setUint16(32, 2, true);                   // block align (channels * bps/8)
  view.setUint16(34, 16, true);                  // bits per sample

  // data sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, byteCount, true);

  // Convert float32 [-1,1] → int16 [-32768, 32767]
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAudioRingBuffer(
  opts: UseAudioRingBufferOptions = {},
): UseAudioRingBufferReturn {
  const bufferSeconds = opts.bufferSeconds ?? 5;
  // Maximum number of Float32 samples to keep (capped ring buffer).
  const maxSamples = SAMPLE_RATE * bufferSeconds;

  // The ring buffer is a flat Float32Array that we write into circularly.
  // writePos points to the next write position. isFull tracks whether we've
  // wrapped around at least once (so we know the entire buffer is valid data).
  const bufferRef = useRef<Float32Array>(new Float32Array(maxSamples));
  const writePosRef = useRef(0);
  const isFullRef = useRef(false);

  // Web Audio refs for cleanup.
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (contextRef.current) {
      void contextRef.current.close().catch(() => { /* ignore */ });
      contextRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    // Always do a clean teardown before starting a new session.
    stop();

    // Reset buffer state on each new start.
    bufferRef.current = new Float32Array(maxSamples);
    writePosRef.current = 0;
    isFullRef.current = false;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    streamRef.current = stream;

    // AudioContext respects the sampleRate constraint when supported.
    // If the browser ignores it (e.g. macOS forces 48 kHz), we still capture
    // audio — just at a different rate. For wake-word pre-buffering purposes
    // this is fine since we only need a few seconds and Whisper is flexible.
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    contextRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated in favour of AudioWorkletNode, but it
    // is universally supported and avoids the need to serve a separate worker
    // script file. The ring-buffer write happens in the main thread at low
    // frequency (every 4096/16000 ≈ 256 ms) so it doesn't cause jank.
    const processor = ctx.createScriptProcessor(
      SCRIPT_PROCESSOR_BUFFER_SIZE,
      1, // input channels
      1, // output channels
    );
    processorRef.current = processor;

    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      // getChannelData returns a view into an internal buffer — copy it before
      // the event object is recycled.
      const chunk = e.inputBuffer.getChannelData(0);
      const buf = bufferRef.current;
      const maxLen = buf.length;
      let pos = writePosRef.current;

      for (let i = 0; i < chunk.length; i++) {
        buf[pos] = chunk[i];
        pos++;
        if (pos >= maxLen) {
          pos = 0;
          isFullRef.current = true;
        }
      }
      writePosRef.current = pos;
    };

    // Connect: source → processor → destination (silent; we only need the
    // onaudioprocess side-effect).
    source.connect(processor);
    processor.connect(ctx.destination);
  }, [maxSamples, stop]);

  const clear = useCallback(() => {
    writePosRef.current = 0;
    isFullRef.current = false;
    // Zero out the buffer so stale samples can't leak into the next extract.
    bufferRef.current.fill(0);
  }, []);

  const extractBlob = useCallback(
    (seconds: number): Blob | null => {
      const buf = bufferRef.current;
      const writePos = writePosRef.current;
      const isFull = isFullRef.current;

      // How many samples are actually available?
      const available = isFull ? buf.length : writePos;
      if (available === 0) return null;

      const desired = Math.min(
        Math.round(seconds * SAMPLE_RATE),
        available,
      );

      // Extract the `desired` most recent samples in chronological order.
      const samples = new Float32Array(desired);
      // Start position in the circular buffer.
      let readPos = (writePos - desired + buf.length) % buf.length;

      for (let i = 0; i < desired; i++) {
        samples[i] = buf[readPos];
        readPos = (readPos + 1) % buf.length;
      }

      // Clear immediately so the next wake-word trigger starts with a
      // fresh buffer and doesn't replay audio from this session.
      clear();

      return float32ToWav(samples, SAMPLE_RATE);
    },
    [clear],
  );

  // Clean up on unmount.
  useEffect(() => () => stop(), [stop]);

  return { start, stop, extractBlob, clear };
}
