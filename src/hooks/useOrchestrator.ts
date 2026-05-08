import { useCallback, useEffect, useRef, useState } from "react";
import {
  orchestratorSocket,
  type OrchestratorConnection,
} from "../lib/orchestratorSocket.js";
import type { OrchestratorEvent, OrchestratorNav } from "../types.js";

export interface UseOrchestratorOptions {
  // Called when the orchestrator wants to navigate the workspace.
  onNavigate: (nav: OrchestratorNav) => void;
}

export interface QueuedOrchestratorMessage {
  id: string;
  text: string;
}

export interface UseOrchestratorReturn {
  connection: OrchestratorConnection;
  isThinking: boolean;
  // Last assistant text shown in the bar. Tool-call activity also surfaces
  // here as a transient status string until the next assistant_text arrives.
  display: string;
  // Messages the user has fired but the orchestrator hasn't started yet. The
  // currently-running message is NOT in this list; it's displayed via the
  // bar's status/text.
  queue: QueuedOrchestratorMessage[];
  send: (text: string, activeRepoPath: string | null) => void;
  interrupt: () => void;
  reset: () => void;
}

const IDLE_GREETING = "Tap the mic to talk.";

export function useOrchestrator(
  opts: UseOrchestratorOptions,
): UseOrchestratorReturn {
  const [connection, setConnection] =
    useState<OrchestratorConnection>("connecting");
  const [display, setDisplay] = useState<string>(IDLE_GREETING);
  const [isThinking, setIsThinking] = useState(false);
  const [queue, setQueue] = useState<QueuedOrchestratorMessage[]>([]);

  const onNavigateRef = useRef(opts.onNavigate);
  onNavigateRef.current = opts.onNavigate;

  useEffect(() => {
    const offConn = orchestratorSocket.onConnection(setConnection);
    const offEvent = orchestratorSocket.onEvent((event: OrchestratorEvent) => {
      switch (event.type) {
        case "turn_start":
          setIsThinking(true);
          setDisplay("Routing…");
          // Pop the head of the queue: that message is now the active one
          // being processed. The bar will show its progress via assistant
          // text and tool-call events, so it no longer belongs in "queued".
          setQueue((q) => q.slice(1));
          break;
        case "turn_end":
          setIsThinking(false);
          break;
        case "assistant_text": {
          // The orchestrator is prompted to reply in <=8 words, but if it
          // ever runs long we hard-clamp here so a single rambling reply
          // can't blow out the bar.
          const t = event.text.trim();
          if (t) setDisplay(clampDisplayText(t));
          break;
        }
        case "tool_call":
          setDisplay(toolCallSummary(event.name, event.input));
          break;
        case "nav":
          onNavigateRef.current(event.nav);
          break;
        case "error":
          setDisplay(`Error: ${event.message}`);
          setIsThinking(false);
          break;
      }
    });
    return () => {
      offConn();
      offEvent();
    };
  }, []);

  const send = useCallback((text: string, activeRepoPath: string | null) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setQueue((q) => [...q, { id, text: trimmed }]);
    // Reflect the dispatch immediately in the bar so the user sees
    // confirmation that the message was sent (otherwise the bar still says
    // "Tap the mic to talk." until the orchestrator's first tool call,
    // which can take a couple of seconds).
    setDisplay(`→ ${clampDisplayText(trimmed)}`);
    orchestratorSocket.send({
      type: "user_message",
      text: trimmed,
      activeRepoPath,
    });
  }, []);

  const interrupt = useCallback(() => {
    orchestratorSocket.send({ type: "interrupt" });
    setQueue([]);
    setIsThinking(false);
  }, []);

  const reset = useCallback(() => {
    orchestratorSocket.send({ type: "reset" });
    setDisplay(IDLE_GREETING);
    setQueue([]);
    setIsThinking(false);
  }, []);

  return {
    connection,
    isThinking,
    display,
    queue,
    send,
    interrupt,
    reset,
  };
}

function toolCallSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "list_repos":
      return "Looking through your repos…";
    case "open_repo":
      return `Opening ${trunc(input.path)}…`;
    case "list_chats":
      return "Checking existing chats…";
    case "switch_to_chat":
      return `Switching to chat ${trunc(input.chatId)}…`;
    case "create_chat":
      return `Creating new chat: ${trunc(input.prompt, 80)}`;
    default:
      return `Calling ${name}…`;
  }
}

function trunc(v: unknown, n = 40): string {
  const s = typeof v === "string" ? v : String(v ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Collapse multi-line replies and clamp to ~140 chars so the bar can't be
// hijacked by a verbose model. The system prompt aims for <=8 words; this
// is the safety net.
function clampDisplayText(t: string): string {
  const oneLine = t.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 140) return oneLine;
  return oneLine.slice(0, 139) + "…";
}
