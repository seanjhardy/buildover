import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
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

interface ChatEntry {
  id: string;
  type: "user" | "ai";
  text: string;
}

export function OrchestratorBar({ activeRepoPath, onNavigate, wakeWordTriggerRef }: Props) {
  const orchestrator = useOrchestrator({ onNavigate });

  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  // Track whether we're waiting for an AI response to a user segment
  const pendingUserMessageRef = useRef(false);
  // Track previous isThinking so we can detect the transition → false
  const prevIsThinkingRef = useRef(false);

  const addEntry = useCallback((type: "user" | "ai", text: string) => {
    setHistory((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type,
        text,
      },
    ]);
  }, []);

  const voice = useVoiceSegmenter({
    onSegment: (cleanedText) => {
      orchestrator.send(cleanedText, activeRepoPath);
      addEntry("user", cleanedText);
      pendingUserMessageRef.current = true;
    },
  });

  // Capture AI response when orchestrator finishes a thinking turn
  useEffect(() => {
    const wasThinking = prevIsThinkingRef.current;
    prevIsThinkingRef.current = orchestrator.isThinking;
    if (wasThinking && !orchestrator.isThinking && pendingUserMessageRef.current) {
      pendingUserMessageRef.current = false;
      const d = orchestrator.display;
      // Only surface actual assistant replies, not system status strings
      if (d && d !== "Tap the mic to talk.") {
        addEntry("ai", d);
      }
    }
  }, [orchestrator.isThinking, orchestrator.display, addEntry]);

  // Auto-open the panel whenever recording starts
  useEffect(() => {
    if (voice.state === "recording") {
      setIsOpen(true);
    }
  }, [voice.state]);

  // Zero out the reserved bottom padding — we're floating, not bar-style
  useEffect(() => {
    document.documentElement.style.setProperty("--orch-stack-h", "0px");
  }, []);

  // Expose imperative handle for wake-word triggered activation
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
      setIsOpen(true);
      void voice.start();
    }
  }, [voice]);

  const isRecording = voice.state === "recording";
  const isTranscribing = voice.state === "transcribing";
  const isActive = isRecording || isTranscribing;
  const showPanel =
    isOpen && (isActive || history.length > 0 || orchestrator.isThinking);

  // Auto-scroll to the latest bubble
  const historyEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, voice.pendingText, orchestrator.isThinking]);

  return (
    <>
      {/* Blur backdrop — clicking outside closes panel when not recording */}
      {showPanel && (
        <div
          className="orch-backdrop"
          onClick={() => {
            if (!isActive) setIsOpen(false);
          }}
        />
      )}

      {/* Speech bubble panel */}
      {showPanel && (
        <div className="orch-bubble-panel">
          {orchestrator.queue.length > 0 && (
            <div className="orch-bubble-queue-label">
              {orchestrator.queue.length} more in queue
            </div>
          )}

          <div className="orch-bubble-history">
            {history.map((entry) => (
              <div key={entry.id} className={`orch-bubble orch-bubble--${entry.type}`}>
                {entry.text}
              </div>
            ))}

            {/* Live transcript bubble — shows what's being spoken right now */}
            {isActive && voice.pendingText.trim() && (
              <div className="orch-bubble orch-bubble--user orch-bubble--live">
                {voice.pendingText}
                <span className="orch-bubble-cursor" />
              </div>
            )}

            {/* AI thinking indicator */}
            {orchestrator.isThinking && (
              <div className="orch-bubble orch-bubble--ai orch-bubble--thinking">
                <span className="orch-thinking-dot" />
                <span className="orch-thinking-dot" />
                <span className="orch-thinking-dot" />
              </div>
            )}

            <div ref={historyEndRef} />
          </div>

          {/* Controls row */}
          <div className="orch-bubble-controls">
            {isRecording && (
              <button
                type="button"
                className="orch-bubble-ctrl-btn"
                onClick={voice.flushNow}
                disabled={!voice.pendingText.trim()}
                title="Send pending text now without waiting for silence"
              >
                send now
              </button>
            )}
            <button
              type="button"
              className="orch-bubble-ctrl-btn"
              onClick={() => {
                orchestrator.reset();
                setHistory([]);
              }}
              title="Reset orchestrator session"
            >
              ↺ reset
            </button>
            {!isActive && (
              <button
                type="button"
                className="orch-bubble-ctrl-btn orch-bubble-ctrl-btn--close"
                onClick={() => setIsOpen(false)}
              >
                close
              </button>
            )}
          </div>
        </div>
      )}

      {/* Floating mic button */}
      <button
        type="button"
        className={`orch-fab ${voice.state}${isOpen ? " orch-fab--open" : ""}`}
        onClick={toggleMic}
        aria-label={isRecording ? "Stop listening" : "Start listening"}
        title={isRecording ? "Stop listening" : "Start listening"}
      >
        {/* Connection-status dot in the top-right corner of the FAB */}
        <span className={`orch-fab-dot ${orchestrator.connection}`} aria-hidden />

        {isRecording ? (
          <span className="orch-fab-rec-indicator" />
        ) : isTranscribing ? (
          <span className="orch-fab-spinner" />
        ) : (
          <Mic size={18} color="white" aria-hidden="true" />
        )}
      </button>
    </>
  );
}
