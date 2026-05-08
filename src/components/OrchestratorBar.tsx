import { useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { Mic } from "lucide-react";
import { useOrchestrator } from "../hooks/useOrchestrator.js";
import { useVoiceSegmenter } from "../hooks/useVoiceSegmenter.js";
import type { OrchestratorNav } from "../types.js";

export interface OrchestratorWakeTrigger {
  /** Activate the orchestrator mic, optionally with pre-detection audio. */
  activateMic: (seedBlob?: Blob) => void;
}

interface Props {
  activeRepoPath: string | null;
  onNavigate: (nav: OrchestratorNav) => void;
  /** When provided, exposes an imperative handle so the wake-word hook can
   *  trigger the orchestrator mic programmatically. */
  wakeWordTriggerRef?: React.RefObject<OrchestratorWakeTrigger>;
}

export function OrchestratorBar({ activeRepoPath, onNavigate, wakeWordTriggerRef }: Props) {
  const orchestrator = useOrchestrator({ onNavigate });

  const voice = useVoiceSegmenter({
    onSegment: (cleanedText) => orchestrator.send(cleanedText, activeRepoPath),
  });

  // Expose imperative handle for wake-word triggered activation.
  useImperativeHandle(
    wakeWordTriggerRef,
    () => ({
      activateMic: (seedBlob?: Blob) => {
        if (voice.state !== "recording" && voice.state !== "transcribing") {
          void voice.start(seedBlob);
        }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [voice.state],
  );

  const toggleMic = useCallback(() => {
    if (voice.state === "recording") {
      void voice.stop();
    } else {
      void voice.start();
    }
  }, [voice]);

  const flushDisabled = !voice.pendingText.trim();
  const isRecording = voice.state === "recording";

  // What we show in the message slot:
  // - while recording with pending text → live transcript
  // - while orchestrator is mid-turn or pending segments → that status
  // - otherwise → last assistant text
  const liveText = isRecording && voice.pendingText.trim()
    ? voice.pendingText
    : null;

  const status = liveText
    ? "live"
    : voice.classifying
      ? "classifying"
      : orchestrator.isThinking
        ? "thinking"
        : orchestrator.queue.length > 0
          ? "queued"
          : "idle";

  const message = liveText ?? orchestrator.display;

  // Publish the actual rendered stack height as a CSS variable so the chat
  // pane reserves exactly the right amount of bottom padding. ResizeObserver
  // keeps this in sync as the queue grows/shrinks.
  const stackRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const apply = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      document.documentElement.style.setProperty(
        "--orch-stack-h",
        `${h}px`,
      );
    };
    apply();
    const obs = new ResizeObserver(apply);
    obs.observe(el);
    return () => {
      obs.disconnect();
      // Leave the variable set to the last known height — unmount during a
      // route change shouldn't snap the chat pane back to zero padding.
    };
  }, []);

  return (
    <div className="orchestrator-stack" ref={stackRef}>
      {orchestrator.queue.length > 0 && (
        <div className="orchestrator-queue">
          <div className="orch-queue-header">
            <span>{orchestrator.queue.length} queued for orchestrator</span>
          </div>
          {orchestrator.queue.map((m, i) => (
            <div key={m.id} className="orch-queue-item">
              <span className="orch-queue-num">{i + 1}</span>
              <span className="orch-queue-text">{m.text}</span>
            </div>
          ))}
        </div>
      )}
      <div className={`orchestrator-bar status-${status}`}>
        <div className="orchestrator-bar-left">
          <span
            className={`orch-dot ${orchestrator.connection}`}
            aria-hidden
          />
          <span className="orch-label">orchestrator</span>
        </div>
        <div className="orchestrator-bar-message" title={message}>
          {message}
        </div>
        <div className="orchestrator-bar-right">
          {voice.error && (
            <span className="orch-error" title={voice.error}>
              mic error
            </span>
          )}
          {isRecording && (
            <button
              type="button"
              className="orch-flush-btn"
              onClick={voice.flushNow}
              disabled={flushDisabled}
              title="Send pending text now without waiting for silence"
            >
              send now
            </button>
          )}
          <button
            type="button"
            className="orch-reset-btn"
            onClick={orchestrator.reset}
            title="Reset orchestrator session"
          >
            ↺
          </button>
          <button
            type="button"
            className={`mic-btn ${voice.state}`}
            onClick={toggleMic}
            aria-label={isRecording ? "Stop listening" : "Start listening"}
            title={isRecording ? "Stop listening" : "Start listening"}
          >
            {isRecording ? (
              <span className="mic-rec-dot" />
            ) : voice.state === "transcribing" ? (
              <span className="mic-spinner" />
            ) : (
              <Mic className="mic-icon" size={14} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
