/// <reference types="vite/client" />

interface ImportMetaEnv {
  // No client-side env vars required for openWakeWord (no API key needed).
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Type shim for openwakeword-wasm-browser which ships JS-only (no .d.ts).
declare module "openwakeword-wasm-browser" {
  type WakeWordEventMap = {
    ready: void;
    detect: { keyword: string; score: number; at: number };
    "speech-start": void;
    "speech-end": void;
    error: unknown;
  };

  interface WakeWordEngineOptions {
    baseAssetUrl: string;
    ortWasmPath?: string;
    keywords?: string[];
    detectionThreshold?: number;
    cooldownMs?: number;
  }

  export default class WakeWordEngine {
    constructor(options: WakeWordEngineOptions);
    load(): Promise<void>;
    start(options?: { deviceId?: string; gain?: number }): Promise<void>;
    stop(): Promise<void>;
    setGain(value: number): void;
    runWav(arrayBuffer: ArrayBuffer): Promise<number>;
    setActiveKeywords(names: string[]): void;
    on<K extends keyof WakeWordEventMap>(
      event: K,
      handler: (data: WakeWordEventMap[K]) => void,
    ): () => void;
  }
}
