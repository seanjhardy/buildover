import React, { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { agentSocket, type Connection } from "../lib/agentSocket.js";
import type {
  AgentEvent,
  Attachment,
  ChatBranch,
  ChatEvent,
  ChatRecord,
  ChatStatus,
  ContentBlock,
  ContextUsage,
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
  contextUsage?: ContextUsage | null;
  branchInfo: Map<string, BranchInfo>;
  slashCommands: string[];
}

// One entry per fork point (keyed by the parentMessageId — the user_message.id
// where the fork was created). Variants[0] is always the currently active trunk.
export interface BranchInfo {
  parentMessageId: string;
  // All available variants. variants[0] = trunk ("" id), rest = saved branches.
  variants: Array<{ branchId: string; label: string }>;
}

// Derive branch navigation metadata from a ChatRecord.
// For each unique parentMessageId across record.branches, we collect all the
// stored alternative branches. The active trunk for that fork point is always
// represented as variants[0] with branchId="" (sentinel for "current trunk").
function computeBranchInfo(record: ChatRecord): Map<string, BranchInfo> {
  const branches = record.branches;
  if (!branches || branches.length === 0) return new Map();

  // Group stored branches by parentMessageId.
  const grouped = new Map<string, ChatBranch[]>();
  for (const b of branches) {
    const arr = grouped.get(b.parentMessageId) ?? [];
    arr.push(b);
    grouped.set(b.parentMessageId, arr);
  }

  const result = new Map<string, BranchInfo>();
  for (const [parentMessageId, bList] of grouped) {
    // Sort branches oldest-first so numbering is stable.
    const sorted = [...bList].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    result.set(parentMessageId, {
      parentMessageId,
      // variants[0] = the currently active trunk (branchId="" sentinel).
      variants: [
        { branchId: "", label: "Current" },
        ...sorted.map((b, i) => ({ branchId: b.id, label: `Version ${i + 1}` })),
      ],
    });
  }
  return result;
}
const chatCache = new Map<string, CachedChat>();
const MAX_CACHE_SIZE = 20;

export type ChatTurn =
  | { kind: "user"; id: string; text: string; attachments?: Attachment[]; checkpointId?: string }
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

export interface PendingAttention {
  attentionId: string;
  message: string;
  summary?: string;
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
  pendingAttention: PendingAttention | undefined;
  chatPermissionMode: PermissionMode | undefined;
  contextUsage: ContextUsage | null;
  branchInfo: Map<string, BranchInfo>;
  slashCommands: string[];
  send: (text: string, opts: SendOptions) => void;
  revertToCheckpoint: (checkpointId: string) => void;
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
  respondAttention: (attentionId: string, feedback?: string, interrupt?: boolean) => void;
  interrupt: () => void;
  setPermissionMode: (mode: PermissionMode) => void;
  forkMessage: (userMessageId: string, newText: string, attachments: Attachment[] | undefined, opts: SendOptions) => void;
  switchBranch: (parentMessageId: string, targetBranchId: string) => void;
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
  const [pendingAttention, setPendingAttention] =
    useState<PendingAttention | undefined>();
  const [chatPermissionMode, setChatPermissionMode] =
    useState<PermissionMode | undefined>();
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [branchInfo, setBranchInfo] = useState<Map<string, BranchInfo>>(new Map());
  const [slashCommands, setSlashCommands] = useState<string[]>([]);

  // Tracks the number of turn_start events that haven't been matched by a
  // turn_end yet. This lets us guard against stale chat_status events (e.g.
  // "awaiting_input" from turn N) overriding isStreaming that was set true by
  // turn_start for the immediately-queued turn N+1.
  const turnCountRef = useRef(0);

  // Mirror chatId in a ref so the event handler always reads the current value
  // without needing to be re-registered on every chatId change.
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  useEffect(() => agentSocket.onConnection(setConnection), []);

  useEffect(() => {
    // Reset the turn counter whenever we switch to a new chat so stale counts
    // from the previous chat don't bleed into the new one.
    turnCountRef.current = 0;

    if (!repoPath || !chatId) {
      setTurns([]);
      setIsStreaming(false);
      setSessionId(undefined);
      setTools([]);
      setMcpServers([]);
      setCwd(undefined);
      setStatus(null);
      setPendingPermission(undefined);
      setPendingAttention(undefined);
      setChatPermissionMode(undefined);
      setContextUsage(null);
      setBranchInfo(new Map());
      setSlashCommands([]);
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
        // Restore the last known context usage from the in-memory cache so the
        // ring is populated immediately on switch, without waiting for the
        // server replay round-trip.
        setContextUsage(cached.contextUsage ?? null);
        setBranchInfo(cached.branchInfo);
        setSlashCommands(cached.slashCommands ?? []);
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
        setContextUsage(null);
        setBranchInfo(new Map());
        setSlashCommands([]);
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
        branchInfo: new Map(),
        slashCommands: [],
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

    const cachedSetContextUsage: React.Dispatch<React.SetStateAction<ContextUsage | null>> = (action) => {
      setContextUsage((prev) => {
        const next =
          typeof action === "function"
            ? (action as (p: ContextUsage | null) => ContextUsage | null)(prev)
            : action;
        updateCache({ contextUsage: next });
        return next;
      });
    };

    const cachedSetBranchInfo = (info: Map<string, BranchInfo>) => {
      setBranchInfo(info);
      updateCache({ branchInfo: info });
    };

    const cachedSetSlashCommands: React.Dispatch<React.SetStateAction<string[]>> = (action) => {
      setSlashCommands((prev) => {
        const next =
          typeof action === "function" ? (action as (p: string[]) => string[])(prev) : action;
        updateCache({ slashCommands: next });
        return next;
      });
    };

    const handler = (event: AgentEvent) => {
      // Defensive: events may arrive after we've switched chats. The
      // multiplexer routes by chatId so this should be impossible, but guard
      // anyway.
      if (event.chatId !== chatIdRef.current) return;

      // isStreaming is driven exclusively by the turn counter, which is
      // updated by turn_start / turn_end events.  chat_status and chat_replay
      // also call setIsStreaming, but those signals can be stale (e.g. an
      // "awaiting_input" status that arrives after the turn_start for the
      // next queued message, or a "running" status that arrives after
      // turn_end).  We completely ignore those calls by routing all
      // setIsStreaming invocations through a counter-authoritative setter.
      //
      // The rules:
      //   • turn_start → increment counter, set streaming = true
      //   • turn_end   → decrement counter, set streaming = (counter > 0)
      //   • everything else → setIsStreaming is a no-op (passed to
      //     applyAgentEvent but ignored)
      if (event.type === "turn_start") {
        turnCountRef.current += 1;
        setIsStreaming(true);
      } else if (event.type === "turn_end") {
        turnCountRef.current = Math.max(0, turnCountRef.current - 1);
        setIsStreaming(turnCountRef.current > 0);
      } else if (event.type === "pending_attention") {
        // The agent is blocked waiting for user input — hide the streaming
        // indicator. We do NOT touch the turn counter here because the turn is
        // still in progress; turn_end will decrement it when the turn finishes.
        // respondAttention() re-enables streaming when the user responds.
        setIsStreaming(false);
      } else if (event.type === "chat_replay") {
        // A chat_replay is the initial history snapshot sent when we (re)subscribe.
        // Use it to authoritatively sync the turn counter with ground truth:
        //
        //  • Not running → always reset to 0. This fixes the case where turn_end
        //    was lost during a WebSocket disconnect, leaving the counter stuck at 1
        //    and isStreaming permanently true (which silently ate all new messages
        //    into the queue without ever draining them).
        //
        //  • Running, counter is 0 → seed to 1 so isStreaming reflects reality
        //    (turn_start hasn't arrived yet on this connection).
        //
        //  • Running, counter > 0 → a live turn_start already arrived; trust the
        //    counter (a turn_start that beat the replay in a reconnect race).
        const running = event.record.status === "running";
        if (!running) {
          turnCountRef.current = 0;
          setIsStreaming(false);
        } else if (turnCountRef.current === 0) {
          turnCountRef.current = 1;
          setIsStreaming(true);
        }
        // else: running and counter > 0 — live signal already correct, leave it.
      }
      // Note: we intentionally do NOT touch isStreaming for chat_status events.
      // chat_status "running"/"awaiting_input" can arrive out of order relative
      // to turn_start/turn_end, causing phantom spinner-on or spinner-off states.
      // The turn counter (updated only by turn_start/turn_end/chat_replay) is
      // the single source of truth for isStreaming.

      // Pass a no-op setter for isStreaming so that applyAgentEvent's
      // chat_status and chat_replay branches cannot interfere with the
      // counter-authoritative value we set above.
      const noopSetIsStreaming: React.Dispatch<React.SetStateAction<boolean>> = () => {
        // Intentionally empty — isStreaming is managed solely by turn_start /
        // turn_end above.  All other callers (chat_status, chat_replay) are
        // silenced here to prevent out-of-order events from corrupting state.
      };

      applyAgentEvent(event, {
        setTurns: cachedSetTurns,
        setIsStreaming: noopSetIsStreaming,
        setSessionId: cachedSetSessionId,
        setTools: cachedSetTools,
        setMcpServers: cachedSetMcpServers,
        setCwd: cachedSetCwd,
        setStatus: cachedSetStatus,
        setPendingPermission,
        setPendingAttention,
        setChatPermissionMode: cachedSetChatPermissionMode,
        setContextUsage: cachedSetContextUsage,
        setBranchInfo: cachedSetBranchInfo,
        setSlashCommands: cachedSetSlashCommands,
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

  const respondAttention = useCallback(
    (attentionId: string, feedback?: string, interrupt?: boolean) => {
      const id = chatIdRef.current;
      if (!id) return;
      agentSocket.send({
        type: "attention_ack",
        chatId: id,
        attentionId,
        feedback,
        interrupt,
      });
      setPendingAttention((p) =>
        p?.attentionId === attentionId ? undefined : p,
      );
      // If continuing (not stopping), flip back to streaming so the "..."
      // indicator reappears while the agent processes the response.
      if (!interrupt) {
        setIsStreaming(true);
        setStatus("running");
      }
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

  const forkMessage = useCallback(
    (userMessageId: string, newText: string, attachments: Attachment[] | undefined, opts: SendOptions) => {
      if (!repoPath || !chatId) return;
      agentSocket.send({
        type: "fork_message",
        chatId,
        repoPath,
        userMessageId,
        newText,
        attachments,
        model: opts.model,
        permissionMode: opts.permissionMode,
      });
    },
    [repoPath, chatId],
  );

  const switchBranch = useCallback(
    (parentMessageId: string, targetBranchId: string) => {
      const id = chatIdRef.current;
      if (!id || !repoPath) return;
      agentSocket.send({
        type: "switch_branch",
        chatId: id,
        repoPath,
        parentMessageId,
        targetBranchId,
      });
    },
    [repoPath],
  );

  const revertToCheckpoint = useCallback(
    (checkpointId: string) => {
      const id = chatIdRef.current;
      if (!id || !repoPath) return;
      agentSocket.send({
        type: "revert_to_checkpoint",
        chatId: id,
        repoPath,
        checkpointId,
      });
    },
    [repoPath],
  );

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
    pendingAttention,
    chatPermissionMode,
    contextUsage,
    branchInfo,
    slashCommands,
    send,
    revertToCheckpoint,
    respondPermission,
    respondAttention,
    interrupt,
    setPermissionMode,
    forkMessage,
    switchBranch,
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
  setPendingAttention: React.Dispatch<
    React.SetStateAction<PendingAttention | undefined>
  >;
  setChatPermissionMode: React.Dispatch<
    React.SetStateAction<PermissionMode | undefined>
  >;
  setContextUsage: React.Dispatch<React.SetStateAction<ContextUsage | null>>;
  setBranchInfo: (info: Map<string, BranchInfo>) => void;
  setSlashCommands: React.Dispatch<React.SetStateAction<string[]>>;
}

function applyAgentEvent(event: AgentEvent, s: Setters): void {
  switch (event.type) {
    case "chat_replay": {
      // Hydrate synchronously (no startTransition) so that this full-replace
      // setTurns cannot be interleaved with the live "result" event's functional
      // updater — which was the root cause of the duplicate result line.
      // React will batch this with any other synchronous updates in the same
      // event-loop tick, keeping renders efficient without the race condition.
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
      // Restore any in-flight RequestUserAttention the server is blocking on.
      const firstAttn = event.pendingAttentions?.[0];
      s.setPendingAttention(
        firstAttn
          ? {
              attentionId: firstAttn.attentionId,
              message: firstAttn.message,
              summary: firstAttn.summary,
            }
          : undefined,
      );
      // If attention is pending, show "awaiting_input" regardless of what the
      // persisted record says (no permission_request is stored for this tool,
      // so computeStatus would otherwise report "running").
      const hasPendingAttention = (event.pendingAttentions?.length ?? 0) > 0;
      s.setStatus(hasPendingAttention ? "awaiting_input" : event.record.status);
      s.setIsStreaming(!hasPendingAttention && event.record.status === "running");
      // Expose this chat's saved permission mode so App.tsx can sync its UI.
      s.setChatPermissionMode(event.record.permissionMode);
      // Compute branch navigation metadata from the replayed record.
      s.setBranchInfo(computeBranchInfo(event.record));
      break;
    }
    case "chat_forked":
      // A full chat_replay follows immediately — nothing to do here.
      break;
    case "system_init":
      s.setSessionId(event.sessionId || undefined);
      s.setTools(event.tools);
      s.setMcpServers(event.mcpServers);
      s.setCwd(event.cwd);
      s.setSlashCommands(event.slashCommands ?? []);
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
      s.setTurns((prev) => {
        // Deduplicate: scan backwards from the end of the current turn (up to
        // the previous user message) to see if chat_replay already hydrated
        // this result. This prevents a second copy when the deferred
        // startTransition hydration and the live broadcast both fire.
        for (let i = prev.length - 1; i >= 0; i--) {
          const t = prev[i];
          if (t.kind === "user") break; // don't look past the start of this turn
          if (
            t.kind === "result" &&
            t.subtype === event.subtype &&
            t.durationMs === event.durationMs &&
            t.totalCostUsd === event.totalCostUsd &&
            t.numTurns === event.numTurns
          ) {
            return prev; // already present — skip the duplicate
          }
        }
        return [
          ...prev,
          {
            kind: "result",
            id: `result-${Date.now()}`,
            subtype: event.subtype,
            durationMs: event.durationMs,
            totalCostUsd: event.totalCostUsd,
            numTurns: event.numTurns,
          },
        ];
      });
      break;
    case "permission_request":
      // RequestUserAttention is now handled via the pending_attention event —
      // the tool handler blocks on attention_ack, not the permission system.
      // Skip setting pendingPermission for it so the old permission UI doesn't
      // also appear (it would be auto-resolved server-side anyway in bypass mode).
      if (event.toolName === "RequestUserAttention") break;
      s.setPendingPermission({
        requestId: event.requestId,
        toolName: event.toolName,
        input: event.input,
        suggestions: event.suggestions ?? [],
      });
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
    case "pending_attention":
      s.setPendingAttention({
        attentionId: event.attentionId,
        message: event.message,
        summary: event.summary,
      });
      // Pause the streaming indicator — the agent is blocked waiting for the
      // user, not actively generating output.
      s.setIsStreaming(false);
      s.setStatus("awaiting_input");
      // No synthetic turn needed: the SDK's tool_use block in the preceding
      // assistant message already records the call in history, and the
      // AttentionPrompt card shows the message/summary in the UI.
      break;
    case "turn_end":
      s.setIsStreaming(false);
      s.setPendingPermission(undefined);
      s.setPendingAttention(undefined);
      break;
    case "context_usage":
      s.setContextUsage({
        usedTokens: event.usedTokens,
        contextWindowSize: event.contextWindowSize,
        pct: event.pct,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
      });
      break;
    case "chat_status":
      s.setStatus(event.status);
      if (event.sessionId) s.setSessionId(event.sessionId);
      // Running ⇔ a turn is in progress for the agent.
      if (event.status === "running") s.setIsStreaming(true);
      else s.setIsStreaming(false);
      break;
    case "revert_checkpoint":
      // Attach this checkpoint id to the most recent user turn so the "↩ Revert"
      // button appears immediately without waiting for a full chat_replay.
      s.setTurns((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].kind === "user") {
            const updated = [...prev];
            updated[i] = {
              ...(prev[i] as Extract<ChatTurn, { kind: "user" }>),
              checkpointId: event.checkpointId,
            };
            return updated;
          }
        }
        return prev;
      });
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
  // Track whether the current agent turn had a real user message driving it.
  // Auto-compact turns have no user_message — their `result` events should not
  // be rendered as visible result lines (they were already suppressed from live
  // broadcasts, but old records may have them persisted on disk).
  let currentTurnHasUserMessage = false;
  for (const ev of record.events) {
    if (ev.type === "user_message") {
      // user_message is persisted *before* turn_start, so we set the flag here
      // and only clear it after the turn ends (on turn_end).
      currentTurnHasUserMessage = true;
    } else if (ev.type === "turn_end") {
      currentTurnHasUserMessage = false;
    } else if (ev.type === "revert_checkpoint") {
      // Attach this checkpoint to the most recently pushed user turn so the
      // "↩ Revert" button appears below that message in the UI.
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].kind === "user") {
          const u = turns[i] as Extract<ChatTurn, { kind: "user" }>;
          turns[i] = { ...u, checkpointId: ev.checkpointId };
          break;
        }
      }
      continue; // revert_checkpoint is not a visible turn itself
    }
    // Skip result events for turns that had no user message — these are
    // silent auto-compact turns whose results should never be shown.
    if (ev.type === "result" && !currentTurnHasUserMessage) continue;
    const t = chatEventToTurn(ev);
    if (t) turns.push(t);
    if (!initSeen && ev.type === "system_init") {
      initSeen = true;
      s.setSessionId(ev.sessionId || undefined);
      s.setTools(ev.tools);
      s.setMcpServers(ev.mcpServers);
      s.setCwd(ev.cwd);
      s.setSlashCommands(ev.slashCommands ?? []);
    }
  }
  s.setTurns(turns);
  if (record.sessionId) s.setSessionId(record.sessionId);
  // Restore the last known context usage from the persisted record, but only
  // if we don't already have a live value that is higher. A chat_replay can
  // arrive mid-turn on WebSocket reconnect; in that case record.lastContextUsage
  // is from the *previous* turn and must not overwrite the current turn's live
  // reading — that would make the ring appear to reset between messages.
  const recordUsage = record.lastContextUsage ?? null;
  s.setContextUsage((current) => {
    if (current !== null && recordUsage !== null && current.pct >= recordUsage.pct) {
      return current; // keep the higher live value
    }
    return recordUsage;
  });
  // Rebuild branch navigation metadata from the record's branches array.
  s.setBranchInfo(computeBranchInfo(record));
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
