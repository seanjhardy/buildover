# Plan: Swap Picovoice → openWakeWord + Pre-Detection Audio Buffer

## Overview

Replace the Picovoice/Porcupine wake-word engine with **openWakeWord running via ONNX Runtime in the browser**, and introduce a **rolling PCM audio ring-buffer** so that the audio spoken during/immediately after "Hey Jarvis" is captured and fed into Groq Whisper — solving the "wake word swallows the first words of your command" problem.

---

## Background: Why the "Hey Jarvis, do X" problem exists

Current flow:
1. Porcupine detects the wake word → stops its own mic stream
2. `activateMic()` is called on Composer → `MediaRecorder.start()` is called
3. By the time MediaRecorder is running and the first 1-second timeslice arrives, the words spoken immediately after "Hey Jarvis" are **gone**

The fix: maintain a **separate, always-on ring buffer of raw PCM audio** that runs in parallel with the wake word detector. When detection fires, we encode the last N seconds of that buffer into a WAV blob and **prepend it** to the MediaRecorder session so Groq sees the full phrase from the very start.

---

## Key Technical Decisions

### 1. Model format: convert .tflite → .onnx
The `openwakeword-wasm-browser` npm package uses `onnxruntime-web` under the hood and requires **ONNX** models, not TFLite. The `hey_jarvis_v0.1.tflite` file must be converted once by the user:

```bash
pip install tf2onnx
python -m tf2onnx.convert --tflite models/hey_jarvis_v0.1.tflite --output public/openwakeword/models/hey_jarvis_v0.1.onnx
```

Three shared pipeline models also need to be placed in `public/openwakeword/models/` (downloadable from the [openWakeWord GitHub releases](https://github.com/dscripka/openWakeWord/releases)):
- `melspectrogram.onnx`
- `embedding_model.onnx`
- `silero_vad.onnx`

### 2. No API key required
openWakeWord is fully open-source. No `VITE_PICOVOICE_ACCESS_KEY` is needed. The COOP/COEP headers in `vite.config.ts` (which were required for Porcupine's SharedArrayBuffer) can be removed as `onnxruntime-web` doesn't need them.

### 3. Audio buffer architecture
The `WakeWordEngine` from `openwakeword-wasm-browser` runs its own `getUserMedia` + `AudioWorklet` pipeline at 16 kHz. We run a **second, parallel `getUserMedia` call** that feeds a ring buffer. The browser allows multiple concurrent streams from the same physical mic.

```
Microphone (physical device)
       │
       ├──────────────────────────────────────────┐
       │                                          │
       ▼                                          ▼
WakeWordEngine (16 kHz AudioWorklet)     useAudioRingBuffer (16 kHz)
  melspec → embed → VAD → classifier       AudioContext + ScriptProcessor
                │                           → Float32 PCM ring buffer (5s)
           onDetected()
                │
                ▼
   1. ringBuffer.extractBlob(3)  ← last 3s as WAV
   2. activateMic(seedBlob)      ← Composer starts recording
   3. useTranscription prepends seedBlob to chunksRef
   4. First Groq poll includes pre-detection audio + new recording
```

---

## Files to Change

### New: `public/openwakeword/models/` (static assets, not code)
User-created directory. Contains the four ONNX files needed by the engine. Vite serves `public/` as-is at the root.

### New: `src/hooks/useAudioRingBuffer.ts`
A standalone hook that:
- Opens a `getUserMedia` stream at 16 kHz mono via `AudioContext`
- Uses a `ScriptProcessorNode` (widely supported, no extra setup) to capture raw `Float32` PCM chunks
- Maintains a circular `Float32Array[]` ring buffer capped at `bufferSeconds` (default 5s)
- Exposes:
  - `start(): Promise<void>` — open stream and begin buffering
  - `stop(): void` — release stream
  - `extractBlob(seconds: number): Blob` — encode the most recent N seconds of PCM as a 16-bit mono WAV blob

The WAV encoding is a ~40-line pure-JS implementation (RIFF header + Int16 PCM samples) — no extra dependencies.

### Modified: `src/hooks/useWakeWord.ts`
Full rewrite of internals, same public interface (`state`, `error`, `start`, `stop`, `isSupported`):
- Remove all Picovoice imports (`@picovoice/porcupine-web`, `@picovoice/web-voice-processor`)
- Remove `VITE_PICOVOICE_ACCESS_KEY` check and `WakeWordKeyword` / `KEYWORD_MAP` types
- Import `WakeWordEngine` from `openwakeword-wasm-browser`
- `isSupported`: `typeof AudioContext !== "undefined"` (no SharedArrayBuffer dependency)
- `start()`: `engine.load()` → `engine.start()` → `setState("listening")`
- Detection: `engine.on('detect', () => { stop(); onDetectedRef.current(); })`
- `stop()`: `engine.stop()`
- The `keyword` prop is removed from the options interface (the model name is now implicit in the ONNX filename at `baseAssetUrl`)

### Modified: `src/hooks/useTranscription.ts`
- `start(seedBlob?: Blob): Promise<void>` — if a `seedBlob` is provided, push it as the first entry in `chunksRef.current` before `recorder.start()`, so the first cumulative Groq poll will include the pre-detection audio.

### Modified: `src/components/Composer.tsx`
- `activateMic(seedBlob?: Blob): void` — the imperative handle passes `seedBlob` through to `transcription.start(seedBlob)`

### Modified: `src/App.tsx`
- Add `useAudioRingBuffer` hook, started/stopped whenever `wakeWordEnabled` toggles
- `onDetected` callback:
  1. `const seedBlob = ringBuffer.extractBlob(3)` — capture last 3 seconds
  2. `micTriggerRef.current?.activateMic(seedBlob)`
- Update `wakeWordTitle` / label strings: "Hey Jarvis" instead of "bumblebee"
- Remove `keyword="bumblebee"` prop from `useWakeWord` call

### Modified: `vite.config.ts`
- Remove the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers (no longer needed)

### Modified: `server/index.ts`
- In `/api/transcribe`, add `wav` to the MIME→extension mapping:
  ```ts
  const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : mime.includes("wav") ? "wav" : "webm";
  ```

### Modified: `package.json`
- Remove: `@picovoice/porcupine-web`, `@picovoice/web-voice-processor`
- Add: `openwakeword-wasm-browser`
- (`onnxruntime-web` is a transitive dep of `openwakeword-wasm-browser`, no direct listing needed)

### Modified: `.env.example`
- Remove the `VITE_PICOVOICE_ACCESS_KEY` line

---

## Detailed Notes

### Ring buffer: why ScriptProcessorNode vs AudioWorkletNode
`ScriptProcessorNode` is deprecated but universally supported and requires zero extra boilerplate (no Worker script file to serve). Since this is an internal buffering node and not in the audio output path, the deprecation has no practical impact here. We can note it as a future upgrade path.

### seedBlob MIME type
The WAV blob uses `audio/wav`. The existing `/api/transcribe` endpoint passes the MIME type to Groq as a query param; Groq's Whisper supports WAV natively. The one-line fix to `server/index.ts` ensures the file gets the `.wav` extension in the FormData upload, which Groq requires for format detection.

### Re-arming the wake word
The existing re-arm logic in `App.tsx` (watching `wakeWord.state` transitions) is unchanged. After `activateMic` is called and the user finishes speaking and the Composer mic goes idle, `wakeWord.start()` is called again. The ring buffer keeps running throughout — it only stops when `wakeWordEnabled` is toggled off.

### At peak: two concurrent getUserMedia streams
1. Ring buffer stream (always on while wake word is enabled)
2. Composer's MediaRecorder stream (active while recording)

`WakeWordEngine`'s own stream is stopped at the moment of detection, so it never overlaps with the recorder.

---

## One-time migration steps for the user

1. **Convert the model:**
   ```bash
   pip install tf2onnx
   python -m tf2onnx.convert --tflite models/hey_jarvis_v0.1.tflite --output public/openwakeword/models/hey_jarvis_v0.1.onnx
   ```

2. **Download the three shared pipeline models** into `public/openwakeword/models/`:
   - `melspectrogram.onnx`
   - `embedding_model.onnx`
   - `silero_vad.onnx`

   Available from the [openWakeWord GitHub releases](https://github.com/dscripka/openWakeWord/releases) page.

3. **`npm install`** after `package.json` is updated (installs `openwakeword-wasm-browser`, removes Picovoice packages).

No `.env` changes needed.

---

## Summary table

| File | Change type | Description |
|---|---|---|
| `src/hooks/useWakeWord.ts` | Rewrite | Porcupine → WakeWordEngine (same public API) |
| `src/hooks/useAudioRingBuffer.ts` | **New** | PCM ring buffer + WAV encoder |
| `src/hooks/useTranscription.ts` | Modify | Add `seedBlob` param to `start()` |
| `src/components/Composer.tsx` | Modify | Pass `seedBlob` through `activateMic()` handle |
| `src/App.tsx` | Modify | Wire ring buffer; pass blob on detection; update UI strings |
| `vite.config.ts` | Modify | Remove COOP/COEP headers |
| `server/index.ts` | Modify | Add `wav` to MIME→ext mapping in `/api/transcribe` |
| `package.json` | Modify | Swap Picovoice deps → `openwakeword-wasm-browser` |
| `.env.example` | Modify | Remove `VITE_PICOVOICE_ACCESS_KEY` |
| `public/openwakeword/models/` | **New dir** | User adds 4 ONNX files here |
