/**
 * useWakeWord — always-on wake-word detection via openWakeWord + ONNX Runtime.
 *
 * Runs entirely in-browser using onnxruntime-web (WASM). No audio is ever
 * sent over the network during the listening phase. When the wake word is
 * detected, `onDetected` is called and the hook pauses itself so the full
 * transcription pipeline can take over. Call `start()` again to re-arm.
 *
 * Requirements
 * ────────────
 *  • Four ONNX model files served from /public/openwakeword/models/:
 *      melspectrogram.onnx
 *      embedding_model.onnx
 *      silero_vad.onnx
 *      hey_jarvis_v0.1.onnx   (converted from hey_jarvis_v0.1.tflite via tf2onnx)
 *
 *  • No API key or COOP/COEP headers required.
 *
 * Model conversion (one-time, run from project root):
 *   pip install tf2onnx
 *   python -m tf2onnx.convert \
 *     --tflite models/hey_jarvis_v0.1.tflite \
 *     --output public/openwakeword/models/hey_jarvis_v0.1.onnx
 *
 * Download the three shared pipeline models from the openWakeWord GitHub
 * releases page and place them in public/openwakeword/models/.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import WakeWordEngine from "openwakeword-wasm-browser";
import * as ort from "onnxruntime-web";

export type WakeWordState =
  | "idle"       // not initialised / disabled
  | "starting"   // models loading
  | "listening"  // actively listening for wake word
  | "error";     // initialisation or runtime error

interface UseWakeWordOptions {
  /** Called exactly once per detection. The hook pauses itself afterward
   *  so you can hand off to the full transcription pipeline. Call start()
   *  again when you want to resume listening. */
  onDetected: () => void;
}

interface UseWakeWordReturn {
  state: WakeWordState;
  error: string | null;
  /** Start (or restart) listening. No-op if already listening. */
  start: () => Promise<void>;
  /** Stop listening and release the mic. */
  stop: () => Promise<void>;
  /** Whether the Web Audio API is available in this browser. */
  isSupported: boolean;
}

function checkSupported(): boolean {
  return (
    typeof AudioContext !== "undefined" ||
    typeof (window as { webkitAudioContext?: unknown }).webkitAudioContext !==
      "undefined"
  );
}

const BASE_ASSET_URL = "/openwakeword/models";
// onnxruntime-web looks for its .wasm files relative to the script URL at
// runtime. Since Vite bundles the JS into /assets/, the runtime can't find
// the .wasm files in node_modules. We copy them to public/ort/ at build time
// and tell the engine exactly where they live via ortWasmPath.
const ORT_WASM_PATH = "/ort/";

export function useWakeWord({
  onDetected,
}: UseWakeWordOptions): UseWakeWordReturn {
  const [state, setState] = useState<WakeWordState>("idle");
  const [error, setError] = useState<string | null>(null);
  const supported = checkSupported();

  const engineRef = useRef<InstanceType<typeof WakeWordEngine> | null>(null);
  // Keep a stable ref so we don't need to rebuild the engine on every render.
  const onDetectedRef = useRef(onDetected);
  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  const stop = useCallback(async () => {
    if (engineRef.current) {
      try {
        await engineRef.current.stop();
      } catch {
        // Best-effort cleanup.
      }
      engineRef.current = null;
    }
    setState("idle");
  }, []);

  const start = useCallback(async () => {
    if (!supported) {
      setError("Wake word detection requires the Web Audio API.");
      setState("error");
      return;
    }

    // Tear down any existing instance first.
    await stop();

    setState("starting");
    setError(null);

    try {
      const engine = new WakeWordEngine({
        baseAssetUrl: BASE_ASSET_URL,
        // Point onnxruntime-web at our self-hosted WASM files in public/ort/.
        // Without this it tries to load from the CDN or relative to the
        // bundled JS path, both of which fail in a Vite dev/prod setup.
        ortWasmPath: ORT_WASM_PATH,
        keywords: ["hey_jarvis"],
        detectionThreshold: 0.5,
        // 2-second cooldown prevents accidental double-triggers.
        cooldownMs: 2000,
      });

      engineRef.current = engine;

      // Disable multi-threading so onnxruntime-web uses the single-threaded
      // WASM backend. The threaded variant requires SharedArrayBuffer, which
      // in turn requires COOP/COEP headers. Single-threaded is slightly slower
      // but works in any browser context without special headers, and is more
      // than fast enough for wake-word inference (~80ms chunks).
      ort.env.wasm.numThreads = 1;

      // Load ONNX models (fetched from /public/openwakeword/models/).
      await engine.load();

      // Register detection callback before starting the mic.
      engine.on("detect", () => {
        // Pause immediately so we don't re-trigger while the user speaks.
        void stop();
        onDetectedRef.current();
      });

      engine.on("error", (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setState("error");
        engineRef.current = null;
      });

      // Start the AudioWorklet + mic stream.
      await engine.start();
      setState("listening");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setState("error");
      engineRef.current = null;
    }
  }, [stop, supported]);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  return { state, error, start, stop, isSupported: supported };
}
