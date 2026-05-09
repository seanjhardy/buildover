import React, { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { agentSocket, type Connection } from "../lib/agentSocket.js";
import type {
  AgentEvent,
  Attachment,
  ChatEvent,
  ChatRecord,
  ChatStatus,
  ContentBlock,
  McpServerInfo,
  Model,
  PermissionMode,
} from "../types.js";

// The sentinel error message written by recoverStaleChat on server restart.
// We suppress this from the chat turn list — the sidebar "Interrupted" state
// already communicates it, and the server auto-retries without user action.
const SERVER_RESTART_ERROR_MSG = "Turn was interrupted by a server restart.";

// ---------------------------------------------------------------------------
// Client-side turn cache
// ---------------------------------------------------------------------------
// Switching between chats would otherwise trigger a full server-side replay
// (withReplay: true) every time, sending the entire chat history over the
// WebSocket and causing visible lag spikes.  We cache the hydrated turns per
// chatId so that revisiting a chat is instant — the server replay still runs
// in the background and any newer events overwrite the cache as they arrive.
// ---------------------------------------------------------------------------
interface CachedChat {
  turns: ChatTurn[];
  sessionId?: string;
  tools: string[];
  mcpServers: McpServerInfo[];
  cwd?: string;
  status: ChatStatus | null;
  chatPermissionMode?: PermissionMode;
}
const chatCache = new Map<string, CachedChat>();
const MAX_CACHE_SIZE = 20;

export type ChatTurn =
  | { kind: "user"; id: string; text: string; attachments?: Attachment[] }
  | { kind: "assistant"; id: string; content: ContentBlock[] }
  | { kind: "tool_results"; id: string; content: ContentBlock[] }
  | {
      kind: "result";
      id: string;
      subtype: string;
      durationMs: number;
      totalCostUsd?: number;
      numTurns: number;
    };

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions: unknown[];
}

interface SendOptions {
  model: Model;
  permissionMode: PermissionMode;
  attachments?: Attachment[];
}

interface UseAgentReturn {
  turns: ChatTurn[];
  connection: Connection;
  isStreaming: boolean;
  sessionId: string | undefined;
  tools: string[];
  mcpServers: McpServerInfo[];
  cwd: string | undefined;
  status: ChatStatus | null;
  pendingPermission: PendingPermission | undefined;
  chatPermissionMode: PermissionMode | undefined;
  send: (text: string, opts: SendOptions) => void;
  respondPermission: (
    requestId: string,
    result:
      | {
          behavior: "allow";
          updatedInput?: Record<string, unknown>;
          updatedPermissions?: unknown[];
        }
      | { behavior: "deny"; message: string; interrupt?: boolean },
  ) => void;
  interrupt: () => void;
  setPermissionMode: (mode: PermissionMode) => void;
}

export function useAgent(
  repoPath: string | null,
  chatId: string | null,
): UseAgentReturn {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [tools, setTools] = useState<string[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [cwd, setCwd] = useState<string | undefined>();
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | undefined>();
  const [chatPermissionMode, setChatPermissionMode] =
    useState<PermissionMode | undefined>();

  // Mirror chatId in a ref so the event handler always reads the current value
  // without needing to be re-registered on every chatId change.
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  useEffect(() => agentSocket.onConnection(setConnection), []);

  useEffect(() => {
    if (!repoPath || !chatId) {
      setTurns([]);
      setIsStreaming(false);
      setSessionId(undefined);
      setTools([]);
      setMcpServers([]);
      setCwd(undefined);
      setStatus(null);
      setPendingPermission(undefined);
      setChatPermissionMode(undefined);
      return;
    }

    // Immediately restore from cache so switching back to a chat is instant,
    // while the server replay still runs in the background to get fresh state.
    // Wrap in startTransition so React treats the (potentially large) turn list
    // render as interruptible — keeping the UI responsive during reconciliation.
    const cached = chatCache.get(chatId);
    startTransition(() => {
      if (cached) {
        setTurns(cached.turns);
        setSessionId(cached.sessionId);
        setTools(cached.tools);
        setMcpServers(cached.mcpServers);
        setCwd(cached.cwd);
        setStatus(cached.status);
        setChatPermissionMode(cached.chatPermissionMode);
      } else {
        setTurns([]);
        setIsStreaming(false);
        setSessionId(undefined);
        setTools([]);
        setMcpServers([]);
        setCwd(undefined);
        setStatus(null);
        setPendingPermission(undefined);
        setChatPermissionMode(undefined);
      }
    });

    // Build cache-aware setters so every state update is mirrored into the
    // in-memory cache keyed by chatId. This means switching back to an already
    // visited chat shows the previous content immediately instead of waiting
    // for the server replay round-trip.
    const updateCache = (patch: Partial<CachedChat>) => {
      const id = chatIdRef.current;
      if (!id) return;
      const prev = chatCache.get(id) ?? {
        turns: [],
        tools: [],
        mcpServers: [],
        status: null,
      };
      chatCache.set(id, { ...prev, ...patch });
      // Evict oldest entries when the cache grows too large.
      if (chatCache.size > MAX_CACHE_SIZE) {
        const oldest = chatCache.keys().next().value;
        if (oldest) chatCache.delete(oldest);
      }
    };

    const cachedSetTurns: React.Dispatch<React.SetStateAction<ChatTurn[]>> = (
      action,
    ) => {
      setTurns((prev) => {
        const next =
          typeof action === "function" ? (action as (p: ChatTurn[]) => ChatTurn[])(prev) : action;
        updateCache({ turns: next });
        return next;
      });
    };
    const cachedSetSessionId: React.Dispatch<
      React.SetStateAction<string | undefined>
    > = (action) => {
      setSessionId((prev) => {
        const next =
          typeof action === "function"
            ? (action as (p: string | undefined) => string | undefined)(prev)
            : action;
        updateCache({ sessionId: next });
        return next;
      });
    };
    const cachedSetTools: React.Dispatch<React.SetStateAction<string[]>> = (
      action,
    ) => {
      setTools((prev) => {
        const next =
          typeof action === "function" ? (action as (p: string[]) => string[])(prev) : action;
        updateCache({ tools: next });
        return next;
      });
    };
    const cachedSetMcpServers: React.Dispatch<
      React.SetStateAction<McpServerInfo[]>
    > = (action) => {
      setMcpServers((prev) => {
        const next =
          typeof action === "function"
            ? (action as (p: McpServerInfo[]) => McpServerInfo[])(prev)
            : action;
        updateCache({ mcpServers: next });
        return next;
      });
    };
    const cachedSetCwd: React.Dispatch<
      React.SetStateAction<string | undefined>
    > = (action) => {
      setCwd((prev) => {
        const next =
          typeof action === "function"
            ? (action as (p: string | undefined) => string | undefined)(prev)
            : action;
        updateCache({ cwd: next });
        return next;
      });
    };
    const cachedSetStatus: React.Dispatch<
      React.SetStateAction<ChatStatus | null>
    > = (action) => {
      setStatus((prev) => {
        const next =
          typeof action === "function"
            ? (action as (p: ChatStatus | null) => ChatStatus | null)(prev)
            : action;
        updateCache({ status: next });
        return next;
      });
    };
    const cachedSetChatPermissionMode: React.Dispatch<
      React.SetStateAction<PermissionMode | undefined>
    > = (action) => {
      setChatPermissionMode((prev) => {
        const next =
          typeof action === "function"
            ? (action as (p: PermissionMode | undefined) => PermissionMode | undefined)(prev)
            : action;
        updateCache({ chatPermissionMode: next });
        return next;
      });
    };

    const handler = (event: AgentEvent) => {
      // Defensive: events may arrive after we've switched chats. The
      // multiplexer routes by chatId so this should be impossible, but guard
      // anyway.
      if (event.chatId !== chatIdRef.current) return;
      applyAgentEvent(event, {
        setTurns: cachedSetTurns,
        setIsStreaming,
        setSessionId: cachedSetSessionId,
        setTools: cachedSetTools,
        setMcpServers: cachedSetMcpServers,
        setCwd: cachedSetCwd,
        setStatus: cachedSetStatus,
        setPendingPermission,
        setChatPermissionMode: cachedSetChatPermissionMode,
      });
    };

    const unsubscribeListener = agentSocket.onChatEvent(chatId, handler);
    agentSocket.send({
      type: "subscribe",
      chatId,
      repoPath,
      withReplay: true,
    });

    return () => {
      unsubscribeListener();
      // We keep the subscription on the server (other hooks like useChats
      // still want status updates). agentSocket cleans up the server-side
      // subscription only when the last listener for this chat is gone.
    };
  }, [repoPath, chatId]);

  const send = useCallback(
    (text: string, opts: SendOptions) => {
      if (!repoPath || !chatId) return;
      agentSocket.send({
        type: "user_message",
        chatId,
        repoPath,
        text,
        model: opts.model,
        permissionMode: opts.permissionMode,
        attachments: opts.attachments,
      });
    },
    [repoPath, chatId],
  );

  const respondPermission = useCallback<UseAgentReturn["respondPermission"]>(
    (requestId, result) => {
      const id = chatIdRef.current;
      if (!id) return;
      agentSocket.send({
        type: "permission_response",
        chatId: id,
        requestId,
        result,
      });
      setPendingPermission((p) =>
        p?.requestId === requestId ? undefined : p,
      );
    },
    [],
  );

  const interrupt = useCallback(() => {
    const id = chatIdRef.current;
    if (!id) return;
    agentSocket.send({ type: "interrupt", chatId: id });
  }, []);

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    const id = chatIdRef.current;
    if (!id) return;
    agentSocket.send({
      type: "set_permission_mode",
      chatId: id,
      permissionMode: mode,
    });
  }, []);

  return {
    turns,
    connection,
    isStreaming,
    sessionId,
    tools,
    mcpServers,
    cwd,
    status,
    pendingPermission,
    chatPermissionMode,
    send,
    respondPermission,
    interrupt,
    setPermissionMode,
  };
}

interface Setters {
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[]>>;
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setTools: React.Dispatch<React.SetStateAction<string[]>>;
  setMcpServers: React.Dispatch<React.SetStateAction<McpServerInfo[]>>;
  setCwd: React.Dispatch<React.SetStateAction<string | undefined>>;
  setStatus: React.Dispatch<React.SetStateAction<ChatStatus | null>>;
  setPendingPermission: React.Dispatch<
    React.SetStateAction<PendingPermission | undefined>
  >;
  setChatPermissionMode: React.Dispatch<
    React.SetStateAction<PermissionMode | undefined>
  >;
}

function applyAgentEvent(event: AgentEvent, s: Setters): void {
  switch (event.type) {
    case "chat_replay": {
      // Hydrating from a full replay can involve hundreds of turns. Wrap in
      // startTransition so React renders it as an interruptible low-priority
      // update — the UI stays responsive while the reconciliation runs.
      startTransition(() => {
        hydrateFromRecord(event.record, s);
        // Restore any in-flight permission request the server is still waiting on.
        const first = event.pendingPermissions[0];
        s.setPendingPermission(
          first
            ? {
                requestId: first.requestId,
                toolName: first.toolName,
                input: first.input,
                suggestions: first.suggestions ?? [],
              }
            : undefined,
        );
        s.setStatus(event.record.status);
        s.setIsStreaming(event.record.status === "running");
        // Expose this chat's saved permission mode so App.tsx can sync its UI.
        s.setChatPermissionMode(event.record.permissionMode);
      });
      break;
    }
    case "system_init":
      s.setSessionId(event.sessionId || undefined);
      s.setTools(event.tools);
      s.setMcpServers(event.mcpServers);
      s.setCwd(event.cwd);
      break;
    case "user_message_echo":
      s.setTurns((prev) => [
        ...prev,
        {
          kind: "user",
          id: event.id,
          text: event.text,
          attachments: event.attachments,
        },
      ]);
      break;
    case "assistant":
      s.setTurns((prev) => [
        ...prev,
        { kind: "assistant", id: event.uuid, content: event.content },
      ]);
      break;
    case "user_tool_results":
      s.setTurns((prev) => [
        ...prev,
        { kind: "tool_results", id: event.uuid, content: event.content },
      ]);
      break;
    case "result":
      s.setSessionId(event.sessionId || undefined);
      s.setTurns((prev) => [
        ...prev,
        {
          kind: "result",
          id: `result-${Date.now()}`,
          subtype: event.subtype,
          durationMs: event.durationMs,
          totalCostUsd: event.totalCostUsd,
          numTurns: event.numTurns,
        },
      ]);
      break;
    case "permission_request":
      s.setPendingPermission({
        requestId: event.requestId,
        toolName: event.toolName,
        input: event.input,
        suggestions: event.suggestions ?? [],
      });
      // RequestUserAttention prompts should also appear as a persistent
      // turn in the chat history so the message is visible after dismissal.
      if (event.toolName === "RequestUserAttention") {
        const ackInput = event.input as { message?: string; summary?: string };
        const ackMessage = String(ackInput.message ?? "Attention needed.");
        const ackSummary = ackInput.summary ? `\n\n${ackInput.summary}` : "";
        s.setTurns((prev) => [
          ...prev,
          {
            kind: "assistant",
            id: `ack-${event.requestId}`,
            content: [{ type: "text", text: `**Attention needed:** ${ackMessage}${ackSummary}` }],
          },
        ]);
      }
      break;
    case "error":
      // Server-restart interruptions are silently suppressed from the turn list
      // — the retry banner in the chat pane already communicates this clearly.
      if (event.message !== SERVER_RESTART_ERROR_MSG) {
        s.setTurns((prev) => [
          ...prev,
          {
            kind: "assistant",
            id: `err-${Date.now()}`,
            content: [{ type: "text", text: `**Error:** ${event.message}` }],
          },
        ]);
      }
      break;
    case "turn_start":
      s.setIsStreaming(true);
      break;
    case "turn_end":
      s.setIsStreaming(false);
      s.setPendingPermission(undefined);
      break;
    case "chat_status":
      s.setStatus(event.status);
      if (event.sessionId) s.setSessionId(event.sessionId);
      // Running ⇔ a turn is in progress for the agent.
      if (event.status === "running") s.setIsStreaming(true);
      else if (event.status !== "awaiting_input") s.setIsStreaming(false);
      break;
    case "chat_title":
      // Title isn't displayed inside the chat body, but other consumers (the
      // sidebar) handle this event in their own subscriptions.
      break;
  }
}

function hydrateFromRecord(record: ChatRecord, s: Setters): void {
  const turns: ChatTurn[] = [];
  let initSeen = false;
  for (const ev of record.events) {
    const t = chatEventToTurn(ev);
    if (t) turns.push(t);
    if (!initSeen && ev.type === "system_init") {
      initSeen = true;
      s.setSessionId(ev.sessionId || undefined);
      s.setTools(ev.tools);
      s.setMcpServers(ev.mcpServers);
      s.setCwd(ev.cwd);
    }
  }
  s.setTurns(turns);
  if (record.sessionId) s.setSessionId(record.sessionId);
}

function chatEventToTurn(ev: ChatEvent): ChatTurn | null {
  switch (ev.type) {
    case "user_message":
      return {
        kind: "user",
        id: ev.id,
        text: ev.text,
        attachments: ev.attachments,
      };
    case "assistant":
      return { kind: "assistant", id: ev.uuid, content: ev.content };
    case "user_tool_results":
      return { kind: "tool_results", id: ev.uuid, content: ev.content };
    case "result":
      return {
        kind: "result",
        id: `r-${ev.ts}`,
        subtype: ev.subtype,
        durationMs: ev.durationMs,
        totalCostUsd: ev.totalCostUsd,
        numTurns: ev.numTurns,
      };
    case "permission_request": {
      // Only RequestUserAttention prompts appear as a persistent chat turn
      // so the message/summary remains visible in the history after dismissal.
      if (ev.toolName !== "RequestUserAttention") return null;
      const ackInput = ev.input as { message?: string; summary?: string };
      const ackMessage = String(ackInput.message ?? "Attention needed.");
      const ackSummary = ackInput.summary ? `\n\n${ackInput.summary}` : "";
      return {
        kind: "assistant",
        id: `ack-${ev.requestId}`,
        content: [{ type: "text", text: `**Attention needed:** ${ackMessage}${ackSummary}` }],
      };
    }
    case "error":
      // Suppress the server-restart sentinel — the retry banner handles it.
      if (ev.message === SERVER_RESTART_ERROR_MSG) return null;
      return {
        kind: "assistant",
        id: `e-${ev.ts}`,
        content: [{ type: "text", text: `**Error:** ${ev.message}` }],
      };
    default:
      return null;
  }
}
