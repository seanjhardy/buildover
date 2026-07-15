import React, { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { agentSocket, type Connection } from "../lib/agentSocket.js";
import { api } from "../lib/api.js";
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
  MessageOrigin,
  Model,
  PermissionMode,
  QueuedChatTurn,
} from "../types.js";

// The sentinel error message written by recoverStaleChat on server restart.
// We suppress this from the chat turn list — the sidebar "Interrupted" state
// already communicates it, and the server auto-retries without user action.
const SERVER_RESTART_ERROR_MSG = "Turn was interrupted by a server restart.";

// User-initiated stops surface as an SDK error ("Claude Code process aborted by
// user"). These aren't real failures, so we never render them — including for
// chats persisted before the server-side suppression landed (retroactive fix).
function isAbortErrorMessage(message: string): boolean {
  return /aborted by user/i.test(message);
}

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
  | {
      kind: "user";
      id: string;
      text: string;
      attachments?: Attachment[];
      checkpointId?: string;
      /** Absent === genuine user input; "subagent"/"system" === injected. */
      origin?: MessageOrigin;
      originLabel?: string;
      /** ISO timestamp of when the user sent this message (persisted or live). */
      ts?: string;
    }
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
  toolUseId?: string; // ID of the tool_use block this permission is for
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

/** A user message held client-side while the agent is mid-turn.
 *  Drained one at a time after each turn ends. Persisted to localStorage per
 *  chat so the queue survives chat switches and full app restarts. */
export interface LocalQueuedMessage {
  id: string;
  text: string;
  opts: SendOptions;
}

const QUEUE_KEY_PREFIX = "buildover.queue.";

function newQueueId(): string {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Load the persisted queue for a chat. Tolerates missing/corrupt data and
// backfills ids for any legacy entries that predate the id field.
function loadQueue(chatId: string | null): LocalQueuedMessage[] {
  if (!chatId) return [];
  try {
    const raw = localStorage.getItem(QUEUE_KEY_PREFIX + chatId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is LocalQueuedMessage =>
          m && typeof m.text === "string" && typeof m.opts === "object",
      )
      .map((m) => ({ ...m, id: m.id ?? newQueueId() }));
  } catch {
    return [];
  }
}

function saveQueue(chatId: string | null, queue: LocalQueuedMessage[]): void {
  if (!chatId) return;
  try {
    if (queue.length === 0) {
      localStorage.removeItem(QUEUE_KEY_PREFIX + chatId);
    } else {
      localStorage.setItem(QUEUE_KEY_PREFIX + chatId, JSON.stringify(queue));
    }
  } catch {
    // localStorage unavailable or over quota — keep the in-memory queue only.
  }
}

const PAUSED_KEY_PREFIX = "buildover.queuePaused.";

function loadPaused(chatId: string | null): boolean {
  if (!chatId) return false;
  try {
    return localStorage.getItem(PAUSED_KEY_PREFIX + chatId) === "1";
  } catch {
    return false;
  }
}

function savePaused(chatId: string | null, paused: boolean): void {
  if (!chatId) return;
  try {
    if (paused) localStorage.setItem(PAUSED_KEY_PREFIX + chatId, "1");
    else localStorage.removeItem(PAUSED_KEY_PREFIX + chatId);
  } catch {
    // localStorage unavailable — keep the in-memory pause state only.
  }
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
  chatContext1m: boolean | undefined;
  contextUsage: ContextUsage | null;
  branchInfo: Map<string, BranchInfo>;
  slashCommands: string[];
  queuedTurns: QueuedChatTurn[];
  localQueue: LocalQueuedMessage[];
  /** When true, the queue is held: messages persist but are not auto-sent
   *  when the current turn ends. */
  queuePaused: boolean;
  toggleQueuePaused: () => void;
  /** Queue a message in a paused state (long-press send). */
  enqueuePaused: (text: string, opts: SendOptions) => void;
  removeQueued: (id: string) => void;
  /** Remove a server-side usage-queued turn by id. */
  removeUsageQueuedTurn: (id: string) => void;
  /** Move a queued message to the front and send it immediately, interrupting
   *  the in-flight turn if one is running. */
  fastTrackQueued: (id: string) => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
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
  const [chatContext1m, setChatContext1m] = useState<boolean | undefined>();
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [branchInfo, setBranchInfo] = useState<Map<string, BranchInfo>>(new Map());
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const [queuedTurns, setQueuedTurns] = useState<QueuedChatTurn[]>([]);
  // Messages the user sent while the agent was mid-turn.  Held locally,
  // persisted per-chat, and drained one-at-a-time after each turn completes so
  // they never appear in the chat until the agent is actually ready to handle
  // them. Initialised from localStorage so a queue survives an app restart.
  const [localQueue, setLocalQueue] = useState<LocalQueuedMessage[]>(() =>
    loadQueue(chatId),
  );
  // When paused, the drain effect holds messages instead of auto-sending them.
  // Persisted per-chat so pausing survives chat switches and app restarts.
  const [queuePaused, setQueuePaused] = useState(() => loadPaused(chatId));
  // Gate auto-draining until the first chat_replay has synced the true server
  // streaming state. On mount isStreaming defaults to false, so without this a
  // persisted queue could fire a message into a turn that is still running
  // server-side (the very thing the queue exists to prevent).
  const [replaySynced, setReplaySynced] = useState(false);

  // Tracks the number of turn_start events that haven't been matched by a
  // turn_end yet. This lets us guard against stale chat_status events (e.g.
  // "awaiting_input" from turn N) overriding isStreaming that was set true by
  // turn_start for the immediately-queued turn N+1.
  const turnCountRef = useRef(0);

  // Ref mirrors so callbacks and effects always read the latest values
  // without needing to be re-registered on every state change.
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;
  const localQueueRef = useRef<LocalQueuedMessage[]>([]);
  localQueueRef.current = localQueue;

  // Mirror chatId in a ref so the event handler always reads the current value
  // without needing to be re-registered on every chatId change.
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  // Load the persisted queue whenever the active chat changes, and reset the
  // pause toggle to its default for the new chat. (Previously this cleared the
  // queue, which is why queued messages vanished on chat switch.)
  useEffect(() => {
    setLocalQueue(loadQueue(chatId));
    setQueuePaused(loadPaused(chatId));
    setReplaySynced(false);
  }, [chatId]);

  // Persist the queue and pause state whenever they change so both survive an
  // app restart. On a chatId switch the load effect above runs first with the
  // old values still in state, so these effects are skipped that render and
  // only fire once the freshly-loaded values are committed — no cross-chat
  // leakage.
  useEffect(() => {
    saveQueue(chatIdRef.current, localQueue);
  }, [localQueue]);

  useEffect(() => {
    savePaused(chatIdRef.current, queuePaused);
  }, [queuePaused]);

  // Drain one locally-queued message as soon as the agent is genuinely idle:
  //   • isStreaming=false  — the turn counter dropped to zero (turn_end)
  //   • pendingAttention=undefined — this isn't just an attention pause
  // Each drained message starts a new turn; when that turn ends this effect
  // fires again to drain the next one, producing a FIFO cascade.
  useEffect(() => {
    if (
      replaySynced &&
      !isStreaming &&
      !pendingAttention &&
      !queuePaused &&
      localQueueRef.current.length > 0
    ) {
      const [next, ...rest] = localQueueRef.current;
      setLocalQueue(rest);
      const id = chatIdRef.current;
      if (repoPath && id) {
        agentSocket.send({
          type: "user_message",
          chatId: id,
          repoPath,
          text: next.text,
          model: next.opts.model,
          permissionMode: next.opts.permissionMode,
          attachments: next.opts.attachments,
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaySynced, isStreaming, pendingAttention, queuePaused, repoPath]);

  // Track permission requestId -> tool_use block ID mapping for live updates
  const requestToToolUseIdRef = useRef(new Map<string, string>());

  // Mirror turns in a ref so event handlers can access the current state
  const turnsRef = useRef<ChatTurn[]>([]);

  // Keep turnsRef in sync with turns state
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

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
      setChatContext1m(undefined);
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
        setChatContext1m(undefined);
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

    const cachedSetChatContext1m: React.Dispatch<React.SetStateAction<boolean | undefined>> = (action) => {
      setChatContext1m((prev) => {
        const next =
          typeof action === "function"
            ? (action as (p: boolean | undefined) => boolean | undefined)(prev)
            : action;
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
        // The server streaming state is now known — allow the queue to drain.
        setReplaySynced(true);
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
        setChatContext1m: cachedSetChatContext1m,
        setContextUsage: cachedSetContextUsage,
        setBranchInfo: cachedSetBranchInfo,
        setSlashCommands: cachedSetSlashCommands,
        setQueuedTurns,
        setQueuePaused,
        requestToToolUseId: requestToToolUseIdRef.current,
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
      // When the agent is mid-turn, hold the message locally.  The drain
      // effect above fires as soon as the turn ends and sends queued messages
      // one at a time — each starts a new turn whose completion drains the next.
      if (isStreamingRef.current) {
        setLocalQueue((q) => [...q, { id: newQueueId(), text, opts }]);
        return;
      }
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

  const setQueuePausedAndSync = useCallback((paused: boolean) => {
    setQueuePaused(paused);
    const id = chatIdRef.current;
    if (id) {
      agentSocket.send({
        type: "set_queue_paused",
        chatId: id,
        paused,
      });
    }
  }, []);

  const toggleQueuePaused = useCallback(() => {
    setQueuePausedAndSync(!queuePaused);
  }, [queuePaused, setQueuePausedAndSync]);

  // Add a message to the queue and pause it, regardless of whether the agent
  // is currently streaming. Used by the composer's long-press-to-queue gesture
  // so the message is held until the user resumes the queue.
  const enqueuePaused = useCallback((text: string, opts: SendOptions) => {
    setQueuePausedAndSync(true);
    setLocalQueue((q) => [...q, { id: newQueueId(), text, opts }]);
  }, [setQueuePausedAndSync]);

  const removeQueued = useCallback((id: string) => {
    setLocalQueue((q) => q.filter((m) => m.id !== id));
  }, []);

  const removeUsageQueuedTurn = useCallback((id: string) => {
    if (!repoPath || !chatId) return;
    // Capture the turn before removing so we can restore it on failure.
    let removed: QueuedChatTurn | undefined;
    setQueuedTurns((q) => {
      removed = q.find((t) => t.id === id);
      return q.filter((t) => t.id !== id);
    });
    api.removeQueuedTurn(repoPath, chatId, id).catch(() => {
      // Restore the turn if the server call failed.
      if (removed) {
        const restored = removed;
        setQueuedTurns((q) => q.some((t) => t.id === id) ? q : [...q, restored]);
      }
    });
  }, [repoPath, chatId]);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    setLocalQueue((q) => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= q.length ||
        toIndex >= q.length
      ) {
        return q;
      }
      const next = [...q];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  // Fast-track: move the message to the front, un-pause, and interrupt any
  // in-flight turn. The drain effect then sends it as soon as the turn ends
  // (or immediately, if the agent was already idle).
  const fastTrackQueued = useCallback((id: string) => {
    setQueuePaused(false);
    setLocalQueue((q) => {
      const item = q.find((m) => m.id === id);
      if (!item) return q;
      return [item, ...q.filter((m) => m.id !== id)];
    });
    if (isStreamingRef.current) {
      const cid = chatIdRef.current;
      if (cid) agentSocket.send({ type: "interrupt", chatId: cid });
    }
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
    chatContext1m,
    contextUsage,
    branchInfo,
    slashCommands,
    queuedTurns,
    localQueue,
    queuePaused,
    toggleQueuePaused,
    enqueuePaused,
    removeQueued,
    removeUsageQueuedTurn,
    fastTrackQueued,
    reorderQueue,
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
  setChatContext1m: React.Dispatch<React.SetStateAction<boolean | undefined>>;
  setContextUsage: React.Dispatch<React.SetStateAction<ContextUsage | null>>;
  setBranchInfo: (info: Map<string, BranchInfo>) => void;
  setSlashCommands: React.Dispatch<React.SetStateAction<string[]>>;
  setQueuedTurns: React.Dispatch<React.SetStateAction<QueuedChatTurn[]>>;
  setQueuePaused: React.Dispatch<React.SetStateAction<boolean>>;
  // Map of permission requestId -> tool_use block ID, used to apply
  // permission_response updatedInput back to the originating tool_use block.
  requestToToolUseId: Map<string, string>;
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
      s.setChatContext1m(event.record.context1m);
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
          origin: event.origin,
          originLabel: event.originLabel,
          ts: new Date().toISOString(),
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
    case "permission_request": {
      // RequestUserAttention is now handled via the pending_attention event —
      // the tool handler blocks on attention_ack, not the permission system.
      // Skip setting pendingPermission for it so the old permission UI doesn't
      // also appear (it would be auto-resolved server-side anyway in bypass mode).
      if (event.toolName === "RequestUserAttention") break;

      // Find the matching tool_use block from recent assistant turns.
      // We use setTurns with a function to access the current state synchronously,
      // since refs might not be updated yet when this event arrives.
      let foundToolUseId: string | undefined;

      s.setTurns((currentTurns) => {
        // Search backwards through turns to find the most recent tool_use block
        // with this toolName that hasn't been mapped to a permission yet
        for (let i = currentTurns.length - 1; i >= 0; i--) {
          const turn = currentTurns[i];
          if (turn.kind === "assistant") {
            for (const block of turn.content) {
              if (block.type === "tool_use" && block.name === event.toolName) {
                // Check if this block is already mapped to a different request
                const alreadyMapped = Array.from(s.requestToToolUseId.values()).includes(block.id);
                if (!alreadyMapped) {
                  foundToolUseId = block.id;
                  break;
                }
              }
            }
            if (foundToolUseId) break;
          }
        }
        // Return unchanged - we're just reading
        return currentTurns;
      });

      // Store the mapping
      if (foundToolUseId) {
        s.requestToToolUseId.set(event.requestId, foundToolUseId);
      }

      s.setPendingPermission({
        requestId: event.requestId,
        toolName: event.toolName,
        input: event.input,
        suggestions: event.suggestions ?? [],
        toolUseId: foundToolUseId,
      });
      break;
    }
    case "permission_response": {
      // Update the tool_use block's input with the updatedInput from the response.
      // Hoist updatedInput into a local so TypeScript keeps the "allow" narrowing
      // inside the setTurns closure below.
      const updatedInput =
        event.result.behavior === "allow" ? event.result.updatedInput : undefined;
      if (updatedInput) {
        const toolUseId = s.requestToToolUseId.get(event.requestId);
        if (toolUseId) {
          s.setTurns((prevTurns) => {
            return prevTurns.map((turn) => {
              if (turn.kind === "assistant") {
                const updatedContent = turn.content.map((block) => {
                  if (block.type === "tool_use" && block.id === toolUseId) {
                    const baseInput =
                      block.input && typeof block.input === "object"
                        ? (block.input as Record<string, unknown>)
                        : {};
                    return {
                      ...block,
                      input: { ...baseInput, ...updatedInput },
                    };
                  }
                  return block;
                });
                return { ...turn, content: updatedContent };
              }
              return turn;
            });
          });
          // Clean up the mapping
          s.requestToToolUseId.delete(event.requestId);
        }
      }
      break;
    }
    case "error":
      // Server-restart interruptions are silently suppressed from the turn list
      // — the retry banner in the chat pane already communicates this clearly.
      // User-initiated aborts are likewise not real errors.
      if (
        event.message !== SERVER_RESTART_ERROR_MSG &&
        !isAbortErrorMessage(event.message)
      ) {
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

  // Build a map to track which tool_use blocks need their input updated.
  // We'll map tool_use block IDs to their updatedInput after we process all events.
  const toolUseIdToUpdatedInput = new Map<string, Record<string, unknown>>();

  // Track tool_use blocks as we encounter them, mapped by toolName
  const toolUseBlocksByName = new Map<string, Array<{ id: string; input: unknown }>>();

  // Track whether the current agent turn had a real user message driving it.
  // Auto-compact turns have no user_message — their `result` events should not
  // be rendered as visible result lines (they were already suppressed from live
  // broadcasts, but old records may have them persisted on disk).
  let currentTurnHasUserMessage = false;

  // Map permission requestIds to their corresponding tool_use block IDs
  const requestIdToToolUseId = new Map<string, string>();

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
    } else if (ev.type === "assistant") {
      // Track tool_use blocks from this assistant message
      for (const block of ev.content) {
        if (block.type === "tool_use") {
          const list = toolUseBlocksByName.get(block.name) ?? [];
          list.push({ id: block.id, input: block.input });
          toolUseBlocksByName.set(block.name, list);
        }
      }
    } else if (ev.type === "permission_request") {
      // Match this permission request to a tool_use block
      const blocks = toolUseBlocksByName.get(ev.toolName) ?? [];
      // Find the first unmatched block for this tool name
      for (const block of blocks) {
        if (!Array.from(requestIdToToolUseId.values()).includes(block.id)) {
          requestIdToToolUseId.set(ev.requestId, block.id);
          break;
        }
      }
    } else if (ev.type === "permission_response") {
      // Store updatedInput for the matching tool_use block
      if (ev.result.behavior === "allow" && ev.result.updatedInput) {
        const toolUseId = requestIdToToolUseId.get(ev.requestId);
        if (toolUseId) {
          toolUseIdToUpdatedInput.set(toolUseId, ev.result.updatedInput);
        }
      }
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

  // Second pass: Apply permission updates to tool_use blocks
  if (toolUseIdToUpdatedInput.size > 0) {
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      if (turn.kind === "assistant") {
        const updatedContent = turn.content.map((block) => {
          if (block.type === "tool_use") {
            const updatedInput = toolUseIdToUpdatedInput.get(block.id);
            if (updatedInput) {
              const baseInput =
                block.input && typeof block.input === "object"
                  ? (block.input as Record<string, unknown>)
                  : {};
              return {
                ...block,
                input: { ...baseInput, ...updatedInput },
              };
            }
          }
          return block;
        });
        if (updatedContent !== turn.content) {
          turns[i] = { ...turn, content: updatedContent };
        }
      }
    }
  }

  s.setTurns(turns);
  s.setQueuedTurns(record.queuedTurns ?? []);
  if (record.queuePaused !== undefined) {
    s.setQueuePaused(record.queuePaused);
  }
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

// Messages injected by coordination tools BEFORE the origin field existed were
// persisted as plain user messages with only a recognisable text prefix. Infer
// their origin so they render as system chips (and stay off the jump bar)
// instead of masquerading as the user.
function inferLegacyOrigin(
  text: string,
): { origin: MessageOrigin; originLabel: string } | undefined {
  if (/^\[Subagent ch_/.test(text)) {
    return { origin: "subagent", originLabel: "Subagent" };
  }
  if (/^\[Coordinator ch_/.test(text)) {
    return { origin: "system", originLabel: "Coordinator" };
  }
  if (/^\[System\]/.test(text)) {
    return { origin: "system", originLabel: "System" };
  }
  return undefined;
}

function chatEventToTurn(ev: ChatEvent): ChatTurn | null {
  switch (ev.type) {
    case "user_message": {
      const legacy = ev.origin ? undefined : inferLegacyOrigin(ev.text);
      return {
        kind: "user",
        id: ev.id,
        text: ev.text,
        attachments: ev.attachments,
        origin: ev.origin ?? legacy?.origin,
        originLabel: ev.originLabel ?? legacy?.originLabel,
        ts: ev.ts,
      };
    }
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
      // Suppress the server-restart sentinel — the retry banner handles it —
      // and user-initiated aborts persisted before the server-side fix landed.
      if (ev.message === SERVER_RESTART_ERROR_MSG || isAbortErrorMessage(ev.message))
        return null;
      return {
        kind: "assistant",
        id: `e-${ev.ts}`,
        content: [{ type: "text", text: `**Error:** ${ev.message}` }],
      };
    default:
      return null;
  }
}
