import { runAgentTurn, type RawAgentEvent } from "./agent.js";
import { runOpenAIAgentTurn } from "./openaiAgent.js";
import { runCursorAgentTurn } from "./cursorAgent.js";
import {
  getCodexUsageLimitBlock,
  isCodexAvailable,
} from "./codexUsage.js";
import { isCursorAvailable, getCursorUsageLimitBlock } from "./cursorUsage.js";
import {
  getModelProvider,
  isClaudeModel,
  isCursorModel,
  toCursorModelId,
} from "./modelProvider.js";
import { makeCoordinationMcp } from "./coordinationTools.js";
import { coordinatorPrompt, subagentPrompt } from "./prompts.js";
import {
  appendEvent,
  computeStatus,
  enqueueChatTurn,
  forkAtMessage,
  readChat,
  rebuildIndex,
  recoverStaleChat,
  revertToCheckpoint,
  setTitle,
  shiftQueuedChatTurn,
  switchBranch,
  withChatLock,
  writeChat,
} from "./chats.js";
import { basename } from "node:path";
import { notifyAgentFinished } from "./push.js";
import { generateTitle } from "./title.js";
import { makeCheckpointId, saveSnapshot } from "./snapshots.js";
import { getUsageLimitBlock, type UsageLimitBlock } from "./usage.js";
import type {
  AgentEvent,
  Attachment,
  ChatEvent,
  ChatRecord,
  MessageOrigin,
  Model,
  PermissionMode,
  QueuedChatTurn,
} from "../src/types.js";
import { SUBAGENT_MODEL } from "../src/types.js";

export type Subscriber = (event: AgentEvent) => void;

interface PendingPermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: unknown[];
  resolve: (
    result:
      | {
          behavior: "allow";
          updatedInput?: Record<string, unknown>;
          updatedPermissions?: unknown[];
        }
      | { behavior: "deny"; message: string; interrupt?: boolean },
  ) => void;
}

interface PendingAttention {
  attentionId: string;
  message: string;
  summary?: string;
  resolve: (result: { feedback?: string; interrupt?: boolean }) => void;
}

// Absolute context-window usage (in tokens) that triggers automatic compaction.
const AUTO_COMPACT_TOKEN_THRESHOLD = 1_000_000;
const USAGE_QUEUE_POLL_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

// The parent-facing tools a subagent uses to reach its coordinator. If a
// subagent turn ends without calling any of these, it gets nudged once.
const PARENT_FACING_TOOLS = new Set([
  "mcp__buildover-agents__report_to_parent",
  "mcp__buildover-agents__mark_task_finished",
  "mcp__buildover-agents__share_files_with_parent",
]);

const PARENT_NUDGE_PROMPT =
  "You've stopped without contacting your coordinator this turn. If your assignment is complete, call `mark_task_finished` with a summary. If you have a question, a blocker, or an interim finding, call `report_to_parent`. If you genuinely have nothing to report yet and are still working, continue the task. Don't reply to this message with plain text — your coordinator only sees what you send through those tools.";

const queueTimers = new Map<string, ReturnType<typeof setTimeout>>();

function queueTimerKey(repoPath: string, chatId: string): string {
  return `${repoPath}\u0000${chatId}`;
}

function makeQueuedTurnId(): string {
  return `qt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function delayUntil(runAfter: string | null): number {
  if (!runAfter) return USAGE_QUEUE_POLL_MS;
  const target = new Date(runAfter).getTime();
  if (!Number.isFinite(target)) return USAGE_QUEUE_POLL_MS;
  return Math.min(Math.max(0, target - Date.now()) + 2_000, MAX_TIMER_MS);
}

export function cancelQueuedTurnDrain(repoPath: string, chatId: string): void {
  const key = queueTimerKey(repoPath, chatId);
  const existing = queueTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    queueTimers.delete(key);
  }
}

export function scheduleQueuedTurnDrain(
  repoPath: string,
  chatId: string,
  runAfter: string | null,
): void {
  const key = queueTimerKey(repoPath, chatId);
  const existing = queueTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    queueTimers.delete(key);
    void drainQueuedTurns(repoPath, chatId);
  }, delayUntil(runAfter));
  queueTimers.set(key, timer);
}

export async function scheduleQueuedTurnsForRepo(repoPath: string): Promise<void> {
  const { listChats, readChat } = await import("./chats.js");
  const chats = await listChats(repoPath);
  for (const chat of chats) {
    if (chat.status !== "queued") continue;
    const record = await readChat(repoPath, chat.id).catch(() => null);
    if (record?.queuePaused) continue;
    const next = record?.queuedTurns?.[0];
    if (next) scheduleQueuedTurnDrain(repoPath, chat.id, next.runAfter);
  }
}

const CODEX_FALLBACK_MODEL = "gpt-5.6-luna";
const CURSOR_FALLBACK_MODEL = toCursorModelId("composer-2.5");

/** When Claude is exhausted, prefer Cursor subscription, then Codex. */
async function resolveClaudeUsageFallback(
  model: string,
): Promise<string | null> {
  if (!isClaudeModel(model)) return null;
  if (await isCursorAvailable()) {
    const cursorBlock = await getCursorUsageLimitBlock();
    if (!cursorBlock) return CURSOR_FALLBACK_MODEL;
  }
  if (await isCodexAvailable()) return CODEX_FALLBACK_MODEL;
  return null;
}

async function getProviderUsageLimitBlock(
  model: string | undefined,
): Promise<UsageLimitBlock | null> {
  if (!model) return null;
  const provider = getModelProvider(model);
  if (provider === "cursor") return getCursorUsageLimitBlock();
  if (provider === "openai") return getCodexUsageLimitBlock();
  return getUsageLimitBlock(model);
}

async function drainQueuedTurns(repoPath: string, chatId: string): Promise<void> {
  const session = getSession(repoPath, chatId);
  if (session.isRunning()) {
    scheduleQueuedTurnDrain(repoPath, chatId, new Date(Date.now() + 5_000).toISOString());
    return;
  }

  const record = await readChat(repoPath, chatId);
  if (!record || record.queuePaused) return;

  const nextModel = record.queuedTurns?.[0]?.model;
  const usageBlock = await getProviderUsageLimitBlock(nextModel);
  if (usageBlock) {
    // Claude is exhausted — try running the queued turn via Cursor / Codex.
    const shifted = await shiftQueuedChatTurn(repoPath, chatId);
    if (shifted && isClaudeModel(shifted.turn.model)) {
      const fallback = await resolveClaudeUsageFallback(shifted.turn.model);
      if (fallback) {
        console.log(`[usage-queue] Claude blocked, falling back to ${fallback} for ${chatId}`);
        await session.pushStatusForRecord(shifted.record);
        void session
          .runTurn({
            text: shifted.turn.text,
            model: fallback,
            permissionMode: shifted.turn.permissionMode,
            attachments: shifted.turn.attachments,
            isRetry: true,
            origin: shifted.turn.origin,
            originLabel: shifted.turn.originLabel,
          })
          .catch((err) => {
            console.warn(`[usage-queue] fallback failed for ${chatId}:`, err instanceof Error ? err.message : err);
          });
        return;
      }
    }
    // No fallback available — wait and retry.
    await session.pushStatusForRecord(record);
    scheduleQueuedTurnDrain(repoPath, chatId, usageBlock.resetsAt);
    return;
  }

  const shifted = await shiftQueuedChatTurn(repoPath, chatId);
  if (!shifted) return;

  await session.pushStatusForRecord(shifted.record);
  void session
    .runTurn({
      text: shifted.turn.text,
      model: shifted.turn.model,
      permissionMode: shifted.turn.permissionMode,
      attachments: shifted.turn.attachments,
      isRetry: true,
      origin: shifted.turn.origin,
      originLabel: shifted.turn.originLabel,
    })
    .catch((err) => {
      console.warn(
        `[usage-queue] queued turn failed for ${chatId}:`,
        err instanceof Error ? err.message : err,
      );
    });
}

// One AgentSession per chat. Lives independently of the WS connections that
// happen to be subscribed at any given moment — closing the browser does not
// stop the agent. Persistence is the source of truth; subscribers are pushed
// live events for low-latency UI updates.
class AgentSession {
  readonly chatId: string;
  readonly repoPath: string;
  private subscribers = new Set<Subscriber>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingAttentions = new Map<string, PendingAttention>();
  private abort?: AbortController;
  private running = false;
  // Structural chat operations (edit/resend, branch switch, revert) can arrive
  // while an aborted turn is still unwinding, or while an invisible compact
  // turn is running. These waiters let those operations wait for the session
  // to become genuinely idle instead of racing the final cleanup and returning
  // a misleading "Chat already running" error.
  private idleWaiters = new Set<() => void>();
  // True while a silent (auto-compact) turn is in progress. Used to suppress
  // chat_status broadcasts for turn-content events so the client never sees
  // the chat flicker to "running" and back during an invisible compact turn.
  private currentTurnSilent = false;
  // If user messages arrive while a silent auto-compact turn is in progress,
  // we can't run them immediately (running = true) but we also can't surface a
  // "Chat already running" error since the user has no idea compaction is
  // happening. We persist + echo each message immediately for UI visibility,
  // then queue the turns here and drain them once the compact finishes.
  private pendingUserTurns: Parameters<AgentSession["runTurn"]>[0][] = [];
  // Tracks the active turn's permissionMode so it can be updated mid-turn.
  // canUseTool reads this on every invocation via the getter passed to the
  // SDK, so toggling bypass takes effect on the next decision.
  private currentPermissionMode: PermissionMode = "default";
  // Latest context window usage in tokens — updated each time a context_usage
  // event arrives. Used to decide whether to auto-compact after a turn ends.
  private lastContextUsedTokens = 0;
  private lastModel: Model = "claude-sonnet-4-6";
  // Set to true when the agent calls ClearContext during a turn. The finally
  // block treats this the same as hitting the auto-compact threshold — it runs
  // a silent /compact turn immediately after the current turn ends.
  private pendingCompact = false;

  constructor(chatId: string, repoPath: string) {
    this.chatId = chatId;
    this.repoPath = repoPath;
  }

  isRunning(): boolean {
    return this.running;
  }

  private waitUntilIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private signalIdle(): void {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private async prepareStructuralOperation(busyMessage: string): Promise<void> {
    if (!this.running) return;

    // A foreground turn that the user has not stopped is still protected from
    // destructive history changes. If Stop was already requested, however,
    // the UI operation should wait for cleanup rather than lose the user's
    // edit in the narrow abort/finally race. Invisible auto-compaction is also
    // safe to pre-empt because it has no user-visible output to preserve.
    if (!this.currentTurnSilent && !this.abort?.signal.aborted) {
      throw new Error(busyMessage);
    }

    const idle = this.waitUntilIdle();
    this.interrupt();
    await idle;
  }

  pendingPermissionList(): {
    requestId: string;
    toolName: string;
    input: Record<string, unknown>;
    suggestions?: unknown[];
  }[] {
    return Array.from(this.pendingPermissions.values()).map((p) => ({
      requestId: p.requestId,
      toolName: p.toolName,
      input: p.input,
      suggestions: p.suggestions,
    }));
  }

  pendingAttentionList(): { attentionId: string; message: string; summary?: string }[] {
    return Array.from(this.pendingAttentions.values()).map((p) => ({
      attentionId: p.attentionId,
      message: p.message,
      summary: p.summary,
    }));
  }

  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  // Broadcasts an externally-produced event (e.g. plans_updated when the user
  // edits a ticket via the plans panel, or chat_created when this chat spawns
  // a subagent) to everyone subscribed to this chat's channel.
  pushEvent(event: AgentEvent): void {
    this.broadcast(event);
  }

  // Delivers a message to this chat from outside the normal composer flow —
  // a subagent reporting back to its parent, or the server notifying the
  // coordinator that a ticket was approved. If a turn is already in flight the
  // message is persisted + echoed immediately and parked; the runTurn finally
  // block drains the queue as soon as the session frees up, so nothing is lost.
  async deliverMessage(args: {
    text: string;
    model?: Model;
    permissionMode?: PermissionMode;
    // Marks where this message came from so the UI can render delivered
    // messages (subagent reports, system notices) distinctly from genuine
    // user input. Absent === "user".
    origin?: MessageOrigin;
    originLabel?: string;
  }): Promise<void> {
    const record = await readChat(this.repoPath, this.chatId);
    if (!record) throw new Error(`Chat ${this.chatId} not found`);
    const model = args.model ?? record.model;
    const permissionMode = args.permissionMode ?? record.permissionMode;
    if (this.running) {
      const userId = `u-${Date.now()}`;
      const ts = new Date().toISOString();
      void this.record({
        type: "user_message",
        id: userId,
        text: args.text,
        origin: args.origin,
        originLabel: args.originLabel,
        ts,
      });
      this.broadcastUserEcho(userId, args.text, undefined, args.origin, args.originLabel);
      // isRetry: the parked turn must not double-persist/echo the message.
      this.pendingUserTurns.push({
        text: args.text,
        model,
        permissionMode,
        isRetry: true,
        origin: args.origin,
        originLabel: args.originLabel,
      });
      return;
    }
    // Guarded fire-and-forget: a rejection here (e.g. a race on the running
    // flag, or a transient IO failure) must never become an unhandled promise
    // rejection — that would crash the whole backend, and under a dev watcher
    // it then restarts, retries the sender's turn, and loops.
    this.runTurn({
      text: args.text,
      model,
      permissionMode,
      origin: args.origin,
      originLabel: args.originLabel,
    }).catch((e) =>
      console.warn(
        `[deliver] turn failed for ${this.chatId}:`,
        e instanceof Error ? e.message : e,
      ),
    );
  }

  private broadcast(event: AgentEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // Subscriber failures must not break the session.
      }
    }
  }

  // Broadcasts the live echo for a freshly-recorded user-slot message. origin /
  // originLabel tag delivered (non-user) messages — subagent reports, system
  // notices — so the UI can render them distinctly from genuine user input.
  // They ride on the echo via a cast until they are added to the
  // user_message_echo variant of AgentEvent in src/types.ts.
  private broadcastUserEcho(
    id: string,
    text: string,
    attachments?: Attachment[],
    origin?: MessageOrigin,
    originLabel?: string,
  ): void {
    const echo: AgentEvent = {
      type: "user_message_echo",
      chatId: this.chatId,
      id,
      text,
      attachments,
    };
    this.broadcast({ ...echo, origin, originLabel } as AgentEvent);
  }

  private async record(event: ChatEvent): Promise<ChatRecord | null> {
    return appendEvent(this.repoPath, this.chatId, event);
  }

  private async pushStatusFor(record: ChatRecord | null): Promise<void> {
    if (!record) return;
    const status = computeStatus(record);
    this.broadcast({
      type: "chat_status",
      chatId: this.chatId,
      status,
      sessionId: record.sessionId,
    });
    await rebuildIndex(this.repoPath);
  }

  async pushStatusForRecord(record: ChatRecord | null): Promise<void> {
    await this.pushStatusFor(record);
  }

  private async queueForUsageLimit(
    args: {
      text: string;
      model: Model;
      permissionMode: PermissionMode;
      attachments?: Attachment[];
      isRetry?: boolean;
      origin?: MessageOrigin;
      originLabel?: string;
    },
    usageBlock: UsageLimitBlock,
  ): Promise<void> {
    const userId = `u-${Date.now()}`;
    const ts = new Date().toISOString();
    const userEvent: ChatEvent | undefined = args.isRetry
      ? undefined
      : {
          type: "user_message",
          id: userId,
          text: args.text,
          attachments: args.attachments,
          ts,
          origin: args.origin,
          originLabel: args.originLabel,
        };
    const queuedTurn: QueuedChatTurn = {
      id: makeQueuedTurnId(),
      text: args.text,
      model: args.model,
      permissionMode: args.permissionMode,
      attachments: args.attachments,
      origin: args.origin,
      originLabel: args.originLabel,
      createdAt: ts,
      runAfter: usageBlock.resetsAt,
      reason: usageBlock.message,
    };

    const wasFirstUserTurn = await readChat(this.repoPath, this.chatId).then(
      (record) => !record?.events.some((e) => e.type === "user_message"),
    );
    const updated = await enqueueChatTurn(
      this.repoPath,
      this.chatId,
      queuedTurn,
      userEvent,
    );

    if (userEvent) {
      this.broadcastUserEcho(
        userId,
        args.text,
        args.attachments,
        args.origin,
        args.originLabel,
      );
      if (wasFirstUserTurn && (updated?.kind ?? "user") === "user") {
        void this.generateAndApplyTitle(args.text);
      }
    }
    await this.pushStatusFor(updated);
    if (!updated?.queuePaused) {
      scheduleQueuedTurnDrain(this.repoPath, this.chatId, usageBlock.resetsAt);
    }
  }

  // Decides whether a mid-turn failure was caused by the usage/session limit
  // being exhausted while the agent was working. Returns the block to re-queue
  // against, or null for a genuine error that should surface normally.
  //
  // Two complementary signals are used:
  //   1. getUsageLimitBlock() — authoritative; reports the real reset time once
  //      the usage endpoint reflects the maxed-out bucket.
  //   2. the SDK error text — a fast path for the brief window where the limit
  //      has been hit but the usage endpoint hasn't caught up yet. In that case
  //      we synthesize a block with no reset time; the drain falls back to
  //      60s polling and re-checks getUsageLimitBlock until the real reset is
  //      known or capacity returns.
  private async usageBlockForFailure(
    errorMessage: string,
    model: string,
  ): Promise<UsageLimitBlock | null> {
    const block = await getProviderUsageLimitBlock(model).catch(() => null);
    if (block) return block;
    if (/rate.?limit|429|usage limit|quota|exceeded your/i.test(errorMessage)) {
      return {
        message:
          "Usage limit reached while the agent was working. Execution is deferred until the limit resets.",
        resetsAt: null,
      };
    }
    return null;
  }

  // Handles a turn that failed (either a mid-turn `error` event from the SDK or
  // an unexpected throw). If the failure was caused by the usage/session limit,
  // the in-flight turn is re-queued so it revives automatically after the reset
  // and `true` is returned. Otherwise the error is surfaced normally and `false`
  // is returned. The caller uses the return value to skip auto-compaction.
  private async finalizeFailure(
    args: Parameters<AgentSession["runTurn"]>[0],
    message: string,
  ): Promise<boolean> {
    // Silent (auto-compact) turns never block on usage and carry no
    // user-visible message to resume, so they always surface the error.
    const usageBlock = args.silent
      ? null
      : await this.usageBlockForFailure(message, args.model);
    if (usageBlock) {
      // Prefer falling back to Cursor/Codex immediately instead of parking the
      // interrupted request while another provider still has quota.
      if (isClaudeModel(args.model)) {
        const fallback = await resolveClaudeUsageFallback(args.model);
        if (fallback) {
          console.log(
            `[session] Claude hit usage mid-turn — falling back to ${fallback}`,
          );
          // pendingUserTurns drains in finally once this.running clears.
          this.pendingUserTurns.unshift({
            ...args,
            model: fallback,
            isRetry: true,
          });
          return true;
        }
      }
      // isRetry: the user message is already persisted (echoed at turn start),
      // so the queued turn must not double-persist or re-echo it.
      await this.queueForUsageLimit({ ...args, isRetry: true }, usageBlock);
      return true;
    }
    this.broadcast({ type: "error", chatId: this.chatId, message });
    await this.record({
      type: "error",
      message,
      ts: new Date().toISOString(),
    });
    return false;
  }

  // Resolves an outstanding permission request. Called when a client sends a
  // permission_response.
  resolvePermission(
    requestId: string,
    result:
      | {
          behavior: "allow";
          updatedInput?: Record<string, unknown>;
          updatedPermissions?: unknown[];
        }
      | { behavior: "deny"; message: string; interrupt?: boolean },
  ): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    // Persist the response on the transcript so future replays show it.
    const ts = new Date().toISOString();
    void this.record({ type: "permission_response", requestId, result, ts }).then(
      (rec) => {
        // Only push a status update while the turn is still running. If the
        // record() promise resolves after the turn's finally block has already
        // called pushStatusFor (possible when the agent's last tool use results
        // in a permission that is resolved just as the turn ends), broadcasting
        // again here would produce a duplicate "agent_done" chat_status event
        // and therefore a duplicate notification on the client.
        if (this.running) this.pushStatusFor(rec);
      },
    );
    pending.resolve(result);
    return true;
  }

  // Tools that must always surface a UI prompt regardless of permission mode,
  // because they are user-interaction checkpoints, not dangerous operations.
  // Must stay in sync with the same set in agent.ts and App.tsx.
  private static readonly ALWAYS_PROMPT_TOOLS = new Set([
    "ExitPlanMode",
    "RequestUserAttention",
  ]);

  // Updates the in-flight turn's permissionMode. When switching to bypass we
  // also auto-resolve any outstanding permission prompts so the user doesn't
  // have to click each one individually after toggling the mode.
  // Exception: tools in ALWAYS_PROMPT_TOOLS (e.g. RequestUserAttention) must
  // never be auto-resolved — they are genuine user checkpoints.
  setPermissionMode(mode: PermissionMode): void {
    this.currentPermissionMode = mode;
    if (mode === "bypassPermissions" && this.pendingPermissions.size > 0) {
      for (const [requestId, pending] of this.pendingPermissions) {
        if (AgentSession.ALWAYS_PROMPT_TOOLS.has(pending.toolName)) continue;
        this.resolvePermission(requestId, { behavior: "allow" });
      }
    }
  }

  // Resolves a pending RequestUserAttention ack. Called when the client sends
  // an attention_ack message. Returns false if the attentionId is unknown.
  resolveAttentionAck(
    attentionId: string,
    result: { feedback?: string; interrupt?: boolean },
  ): boolean {
    const pending = this.pendingAttentions.get(attentionId);
    if (!pending) return false;
    this.pendingAttentions.delete(attentionId);
    pending.resolve(result);
    // Transition the status back to "running" now that the user has responded
    // and the turn is continuing. If the user clicked Stop, the turn is about
    // to end and the finally block in runTurn will push the correct final status.
    if (!result.interrupt) {
      this.broadcast({
        type: "chat_status",
        chatId: this.chatId,
        status: "running",
      });
    }
    return true;
  }

  interrupt(): void {
    this.abort?.abort();
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve({
        behavior: "deny",
        message: "Interrupted",
        interrupt: true,
      });
    }
    this.pendingPermissions.clear();
    // Also unblock any tool handlers waiting on an attention ack.
    for (const [, pending] of this.pendingAttentions) {
      pending.resolve({ interrupt: true });
    }
    this.pendingAttentions.clear();
    // If there's no live turn, the abort above was a no-op but the persisted
    // record may still claim "running" (e.g. a previous server died mid-turn
    // and this AgentSession was just spun up by getSession). Heal the record
    // and push the new status so the client's stop button has visible effect.
    if (!this.running) void this.healAndBroadcast();
  }

  // Walks the persisted chat events, denies any unresolved permission_request
  // and closes any open turn, then broadcasts the recovered status. Safe to
  // call when nothing is wrong — recoverStaleChat returns false in that case.
  private async healAndBroadcast(): Promise<void> {
    try {
      const changed = await recoverStaleChat(this.repoPath, this.chatId);
      if (!changed) return;
      const record = await readChat(this.repoPath, this.chatId);
      await this.pushStatusFor(record);
    } catch {
      // Best-effort; the next subscribe will retry.
    }
  }

  // Called by the startup recovery path after a chat has been healed from a
  // server-restart interruption. Re-runs the last user message as a retry so
  // the agent continues without the user having to intervene. If there is no
  // user message to replay (shouldn't happen in practice) this is a no-op.
  async retryAfterRestart(): Promise<void> {
    const record = await readChat(this.repoPath, this.chatId);
    if (!record) return;

    // Find the last user message in the transcript.
    const lastUserMsg = [...record.events]
      .reverse()
      .find((e) => e.type === "user_message");
    if (!lastUserMsg || lastUserMsg.type !== "user_message") return;

    await this.runTurn({
      text: lastUserMsg.text,
      model: record.model,
      permissionMode: record.permissionMode,
      attachments: lastUserMsg.attachments,
      isRetry: true,
    });
  }

  // Kicks off a turn in the background. Resolves immediately; the actual work
  // streams through emit/persistence/broadcast.
  //
  // When `isRetry` is true the caller is re-running the last user message
  // after a server-restart interruption. In that case we skip persisting and
  // echoing the user message (it's already in the transcript) and run the
  // agent turn directly with the saved text.
  //
  // When `silent` is true (used for auto-compact) no assistant/result turns
  // are broadcast to subscribers — the compact runs invisibly in the background.
  async runTurn(args: {
    text: string;
    model: Model;
    permissionMode: PermissionMode;
    attachments?: Attachment[];
    isRetry?: boolean;
    silent?: boolean;
    // Set on the auto-prompt we send a subagent that finished without contacting
    // its parent. Prevents a second nudge from chaining off the nudge's own turn.
    nudge?: boolean;
    // Carried through from deliverMessage so a delivered (non-user) message
    // routed via runTurn keeps its origin tag on persist + echo.
    origin?: MessageOrigin;
    originLabel?: string;
  }): Promise<void> {
    if (this.running) {
      // A turn is already in flight (a normal visible turn, or an invisible
      // auto-compact). Rather than rejecting the message — which would surface
      // a "Chat already running" error and make the composer feel broken — we
      // persist + echo it immediately so it's durable and visible, then park
      // the turn. The finally block below drains pendingUserTurns FIFO as soon
      // as the session frees up, so the chat always accepts input like a normal
      // text box. The server is the single owner of this queue.
      if (!args.silent && !args.isRetry) {
        const userId = `u-${Date.now()}`;
        const ts = new Date().toISOString();
        const userEvent: ChatEvent = {
          type: "user_message",
          id: userId,
          text: args.text,
          attachments: args.attachments,
          ts,
          origin: args.origin,
          originLabel: args.originLabel,
        };
        // appendEvent uses withChatLock internally — it will queue behind any
        // lock already held by the in-flight turn (no deadlock, just ordering).
        void this.record(userEvent);
        this.broadcastUserEcho(
          userId,
          args.text,
          args.attachments,
          args.origin,
          args.originLabel,
        );
        // Mark as retry so the parked turn doesn't double-persist/echo.
        this.pendingUserTurns.push({ ...args, isRetry: true });
        return;
      }
      throw new Error("Chat already running");
    }

    // Subagents always run on Haiku 4.5, enforced here by chat kind — the one
    // path every turn (first turn, resumed turn, coordinator feedback, queued
    // turn) flows through. This is the source of truth, independent of whatever
    // model the spawner stored or the caller passed.
    {
      const kindRecord = await readChat(this.repoPath, this.chatId);
      if ((kindRecord?.kind ?? "user") === "subagent" && args.model !== SUBAGENT_MODEL) {
        args = { ...args, model: SUBAGENT_MODEL };
      }
    }

    // Check usage limit before starting a new turn. When Claude is exhausted
    // we first try Cursor (subscription), then Codex. Only queue when none
    // of the fallbacks are available. Cursor-selected models check Cursor
    // limits instead of Claude's.
    if (!args.silent) {
      if (isCursorModel(args.model)) {
        const cursorBlock = await getCursorUsageLimitBlock();
        if (cursorBlock) {
          await this.queueForUsageLimit(args, cursorBlock);
          return;
        }
      } else if (getModelProvider(args.model) === "openai") {
        const codexBlock = await getCodexUsageLimitBlock();
        if (codexBlock) {
          await this.queueForUsageLimit(args, codexBlock);
          return;
        }
      } else if (isClaudeModel(args.model)) {
        const usageBlock = await getUsageLimitBlock(args.model);
        if (usageBlock) {
          const fallback = await resolveClaudeUsageFallback(args.model);
          if (fallback) {
            console.log(`[session] Claude blocked — falling back to ${fallback}`);
            args = { ...args, model: fallback };
          } else {
            await this.queueForUsageLimit(args, usageBlock);
            return;
          }
        }
      }
    }

    this.running = true;
    this.currentTurnSilent = args.silent ?? false;
    this.abort = new AbortController();
    this.currentPermissionMode = args.permissionMode;

    const record = await withChatLock(this.repoPath, this.chatId, async () => {
      const r = await readChat(this.repoPath, this.chatId);
      if (!r) return null;
      r.model = args.model;
      r.permissionMode = args.permissionMode;
      await writeChat(this.repoPath, r);
      return r;
    });
    if (!record) {
      this.running = false;
      throw new Error(`Chat ${this.chatId} not found`);
    }

    const isFirstUserTurn = !record.events.some(
      (e) => e.type === "user_message",
    );

    if (!args.isRetry) {
      // Persist + echo the user message so subscribers see it immediately.
      const userId = `u-${Date.now()}`;
      const ts = new Date().toISOString();
      const userEvent: ChatEvent = {
        type: "user_message",
        id: userId,
        text: args.text,
        attachments: args.attachments,
        ts,
        origin: args.origin,
        originLabel: args.originLabel,
      };
      const afterUser = await this.record(userEvent);
      this.broadcastUserEcho(
        userId,
        args.text,
        args.attachments,
        args.origin,
        args.originLabel,
      );
      await this.pushStatusFor(afterUser);

      // Fire-and-forget title generation — never blocks the turn. Skipped for
      // coordinator chats (always titled "Coordinator") and subagent chats
      // (titled by the agent that spawned them).
      if (isFirstUserTurn && (record.kind ?? "user") === "user") {
        void this.generateAndApplyTitle(args.text);
      }
    }

    // Persist a revert_checkpoint event before every non-silent turn so the
    // user can restore file state to this exact point later.
    const checkpointId = args.silent ? null : makeCheckpointId();
    if (checkpointId) {
      await this.record({
        type: "revert_checkpoint",
        checkpointId,
        ts: new Date().toISOString(),
      });
    }

    // Track the latest model so we can use it for the auto-compact turn.
    this.lastModel = args.model;

    // All chats get the buildover-agents toolset so any chat can spawn and
    // manage subagents. Coordinator / subagent chats additionally receive role
    // instructions via systemPromptAppend.
    const chatKind = record.kind ?? "user";
    const systemPromptAppend =
      chatKind === "coordinator"
        ? coordinatorPrompt()
        : chatKind === "subagent"
          ? subagentPrompt({
              parentChatId: record.parentChatId ?? "unknown",
              task: record.task,
            })
          : undefined;
    const coordination = {
      ...(systemPromptAppend ? { systemPromptAppend } : {}),
      extraMcpServers: {
        "buildover-agents": makeCoordinationMcp({
          repoPath: this.repoPath,
          chatId: this.chatId,
          kind: chatKind,
          parentChatId: record.parentChatId,
          task: record.task,
        }),
      },
    };

    // Events that should be hidden from subscribers during a silent (auto-compact) turn.
    // We still persist assistant/result events so the session history is correct,
    // but we don't broadcast them so they don't appear as visible chat turns.
    const SILENT_SUPPRESS = new Set([
      "assistant",
      "user_tool_results",
      "result",
      "user_message_echo",
      "turn_start",
      "turn_end",
      // Suppress the transient spike in context usage that happens while the
      // compact turn loads the full history to summarize it. The internal
      // lastContextUsedTokens field is still updated (done before the broadcast
      // check) so the threshold logic works correctly.
      "context_usage",
    ]);

    // Captures a mid-turn `error` event emitted by the SDK runner so the
    // failure can be handled after the stream ends. The runner catches API
    // failures internally and emits them as `error` events (it does not throw),
    // so this is where a usage-limit-mid-turn surfaces. We defer rather than
    // broadcast/persist immediately: if it turns out to be a usage-limit hit we
    // re-queue the turn instead of leaving a dead-end error in the transcript.
    let deferredErrorMessage: string | null = null;

    // Track whether this subagent turn actually reached out to its parent
    // (report_to_parent / mark_task_finished / share_files_with_parent). If it
    // ends without doing so, the finally block nudges it to confirm whether it
    // meant to report back.
    let parentContacted = false;

    const emit = (event: RawAgentEvent) => {
      // Tag with this session's chatId before broadcasting / persisting.
      const tagged = { ...event, chatId: this.chatId } as AgentEvent;
      // Provider runners finish by emitting turn_end before control returns to
      // this AgentSession. Do not expose that event yet: `this.running` is
      // still true until the outer finally block has persisted all preceding
      // output and completed its cleanup. Broadcasting it here made the UI
      // expose Edit/Resend while the server still rejected them as busy.
      if (tagged.type === "turn_end") return;
      // Track context usage so we can auto-compact after the turn ends.
      if (tagged.type === "context_usage") {
        this.lastContextUsedTokens = tagged.usedTokens;
      }
      if (tagged.type === "assistant") {
        for (const block of tagged.content) {
          if (block.type === "tool_use" && PARENT_FACING_TOOLS.has(block.name)) {
            parentContacted = true;
          }
        }
      }
      if (tagged.type === "error") {
        deferredErrorMessage = tagged.message;
        return;
      }
      // During a silent turn (auto-compact), suppress turn-content events from
      // reaching subscribers so nothing appears in the chat UI.
      if (!args.silent || !SILENT_SUPPRESS.has(tagged.type)) {
        this.broadcast(tagged);
      }
      void this.persistAgentEvent(tagged);
    };

    // Code-editing subagents run their SDK session in an isolated git worktree
    // so their edits don't touch the live main working tree until merged back.
    // Everything else — coordination, persistence, broadcast — stays keyed to
    // the main repoPath; only the SDK's execution cwd changes.
    const execCwd = record.worktreePath ?? this.repoPath;

    // Set when a turn failure is re-queued because the usage limit was hit
    // mid-flight. The finally block reads it to skip auto-compaction (a silent
    // compact turn bypasses the usage check and would fail immediately).
    let queuedForUsage = false;

    try {
      // Route to the correct runner based on the model provider.
      const provider = getModelProvider(args.model);
      if (provider === "cursor") {
        await runCursorAgentTurn({
          prompt: args.text,
          model: args.model,
          cwd: execCwd,
          permissionMode: args.permissionMode,
          cursorSessionId: record.providerSessions?.cursor,
          conversationHistory: record.events,
          emit,
          abortController: this.abort,
        });
      } else if (provider === "openai") {
        await runOpenAIAgentTurn({
          prompt: args.text,
          model: args.model,
          cwd: execCwd,
          permissionMode: args.permissionMode,
          codexSessionId: record.providerSessions?.openai,
          attachments: args.attachments,
          conversationHistory: record.events,
          emit,
          abortController: this.abort,
        });
      } else {
      // Prefer the Claude-specific session id so a prior Cursor turn cannot
      // poison Claude SDK resume.
      const claudeSessionId =
        record.providerSessions?.claude ??
        (record.sessionId &&
        !record.sessionId.startsWith("openai-") &&
        record.providerSessions?.cursor !== record.sessionId
          ? record.sessionId
          : undefined);
      // When switching to Claude with no prior Claude session, inject a text
      // history preamble so the model sees earlier Cursor/OpenAI turns.
      let claudePrompt = args.text;
      if (
        !claudeSessionId &&
        record.events.some((e) => e.type === "user_message" || e.type === "assistant")
      ) {
        const lines: string[] = [];
        for (const ev of record.events) {
          if (ev.type === "user_message") lines.push(`User: ${ev.text}`);
          else if (ev.type === "assistant") {
            const t = ev.content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("");
            if (t.trim()) lines.push(`Assistant: ${t}`);
          }
        }
        if (lines.length) {
          let body = lines.join("\n\n");
          if (body.length > 12_000) body = body.slice(-12_000);
          claudePrompt =
            "Previous conversation in this Buildover chat (for context; continue naturally):\n\n" +
            body +
            "\n\n---\n\n" +
            args.text;
        }
      }
      await runAgentTurn({
        prompt: claudePrompt,
        model: args.model,
        sessionId: claudeSessionId,
        // One-shot marker set by fork / branch-switch / revert: resume the
        // session only up to this SDK message uuid so the model never sees
        // the edited-away / reverted history.
        resumeSessionAt: record.resumeSessionAt,
        cwd: execCwd,
        permissionMode: args.permissionMode,
        getPermissionMode: () => this.currentPermissionMode,
        attachments: args.attachments,
        context1m: record.context1m,
        ...coordination,
        emit,
        requestCompact: (reason) => {
          console.log(`[session] ClearContext requested by agent${reason ? `: ${reason}` : ""}`);
          this.pendingCompact = true;
        },
        requestPermission: (req) =>
          new Promise((resolve) => {
            const requestId = `pr-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}`;
            this.pendingPermissions.set(requestId, {
              requestId,
              toolName: req.toolName,
              input: req.input,
              suggestions: req.suggestions ?? [],
              resolve,
            });
            const ev: AgentEvent = {
              type: "permission_request",
              chatId: this.chatId,
              requestId,
              toolName: req.toolName,
              input: req.input,
              suggestions: req.suggestions,
            };
            this.broadcast(ev);
            void this.persistAgentEvent(ev);
          }),
        requestAttentionAck: (req) =>
          new Promise((resolve) => {
            this.pendingAttentions.set(req.attentionId, {
              attentionId: req.attentionId,
              message: req.message,
              summary: req.summary,
              resolve,
            });
            const ev: AgentEvent = {
              type: "pending_attention",
              chatId: this.chatId,
              attentionId: req.attentionId,
              message: req.message,
              summary: req.summary,
            };
            this.broadcast(ev);
            // Transition the sidebar/tab status to "awaiting_input" while we
            // wait for the user to respond. This is a live-only signal — no
            // persistence needed because the record's computeStatus will
            // correctly reflect the running/idle state after the turn ends.
            this.broadcast({
              type: "chat_status",
              chatId: this.chatId,
              status: "awaiting_input",
            });
            void this.persistAgentEvent(ev);
          }),
        abortController: this.abort,
        // Snapshot the target file before any file-modifying tool runs so we
        // can restore it when the user clicks "Revert".  Only active for
        // non-silent turns (silent = auto-compact, which has no checkpoint).
        onBeforeFileTool: checkpointId
          ? async (_toolName, input) => {
              const inp = input as Record<string, unknown>;
              const filePath = String(inp.file_path ?? "");
              if (filePath) {
                await saveSnapshot(this.repoPath, this.chatId, checkpointId, filePath);
              }
            }
          : undefined,
      });
      }

      // The SDK runner reports mid-turn API failures as `error` events (it does
      // not throw), so handle a deferred error here. If it was caused by the
      // usage/session limit being exhausted while the agent was working, the
      // turn is re-queued to revive automatically after the reset instead of
      // surfacing a dead-end error.
      // The persisted SDK session no longer exists — typically happens after a
      // backend restart when the in-process session files are gone but the chat
      // record still holds the old sessionId. Clear it silently and re-queue
      // the turn so it retries with a fresh session; no error shown to the user.
      // Cast needed: TS CFA narrows deferredErrorMessage to null (the assignment
      // inside the emit closure isn't tracked), so we restore the declared type.
      if (
        (deferredErrorMessage as string | null)?.includes("No conversation found with session ID") &&
        record.sessionId
      ) {
        console.warn(
          `[session] Stale SDK session ${record.sessionId} cleared, re-queuing turn`,
        );
        await withChatLock(this.repoPath, this.chatId, async () => {
          const r = await readChat(this.repoPath, this.chatId);
          if (r) {
            r.sessionId = undefined;
            r.resumeSessionAt = undefined;
            await writeChat(this.repoPath, r);
          }
        });
        // Put the turn back at the front of the queue; the finally-block drain
        // will pick it up immediately once this.running is cleared.
        this.pendingUserTurns.unshift({ ...args, isRetry: true });
      } else if (deferredErrorMessage) {
        queuedForUsage = await this.finalizeFailure(args, deferredErrorMessage);
      }
    } catch (err) {
      // An unexpected throw from the runner itself (not the in-stream error
      // path above). Route it through the same handler so a usage limit here is
      // also re-queued rather than surfaced as a dead end.
      const message = err instanceof Error ? err.message : String(err);
      queuedForUsage = await this.finalizeFailure(args, message);
    } finally {
      const wasSilent = this.currentTurnSilent;
      const wasAborted = this.abort?.signal.aborted === true;
      this.currentTurnSilent = false;
      this.pendingPermissions.clear();
      let final: ChatRecord | null = null;
      try {
        // The client must only receive turn_end after every preceding event is
        // durable and the session is actually available for another operation.
        // Silent compact turns have no persisted turn_start, so they do not add
        // a matching terminal event either.
        if (!wasSilent) {
          final = await this.record({
            type: "turn_end",
            ts: new Date().toISOString(),
          });
        } else {
          final = await withChatLock(this.repoPath, this.chatId, async () => {
            const r = await readChat(this.repoPath, this.chatId);
            if (!r) return null;
            r.status = computeStatus(r);
            await writeChat(this.repoPath, r);
            return r;
          });
        }
      } catch (err) {
        console.warn(
          `[session] failed to finalize turn for ${this.chatId}:`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        this.running = false;
        this.abort = undefined;
      }
      if (final) {
        try {
          await this.pushStatusFor(final);
        } catch (err) {
          console.warn(
            `[session] failed to publish final status for ${this.chatId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      if (!wasSilent) {
        this.broadcast({ type: "turn_end", chatId: this.chatId });
      }
      // Release structural operations only after subscribers have received
      // the terminal state, otherwise a fork replay can be overtaken by the
      // old turn's delayed status/end events.
      this.signalIdle();

      // Auto-compact if the context window is getting full, or if the agent
      // explicitly requested a compact via the ClearContext tool.
      // Guard: don't re-trigger on the compact turn itself to avoid a loop, and
      // never start a compact turn when we just queued for a usage limit — it
      // would skip the usage check and immediately fail again.
      const shouldCompact =
        !wasAborted &&
        !queuedForUsage &&
        (this.lastContextUsedTokens >= AUTO_COMPACT_TOKEN_THRESHOLD ||
          this.pendingCompact) &&
        !args.text.startsWith("/compact");
      this.pendingCompact = false;
      if (shouldCompact) {
        void this.runTurn({
          text: "/compact",
          model: this.lastModel,
          permissionMode: args.permissionMode,
          isRetry: true,  // don't echo "/compact" as a user message
          silent: true,   // suppress assistant/result turns from reaching the UI
        });
      } else if (this.pendingUserTurns.length > 0) {
        // One or more user messages arrived while a silent compact turn was
        // running and were parked (see the running guard above). Now that the
        // session is free, send the first one through. Its own finally block
        // will drain the next entry, and so on until the queue is empty.
        const queued = this.pendingUserTurns.shift()!;
        void this.runTurn(queued);
      } else {
        const record = await readChat(this.repoPath, this.chatId);
        const next = record?.queuedTurns?.[0];
        if (next) {
          scheduleQueuedTurnDrain(this.repoPath, this.chatId, next.runAfter);
        } else if (!wasSilent) {
          // A subagent that finished its turn without ever contacting its parent
          // has most likely forgotten to report back. Send a single auto-prompt
          // asking it to confirm — `nudge: true` stops the prompt's own turn from
          // chaining another nudge, so this fires at most once per stretch.
          if (
            !args.nudge &&
            !queuedForUsage &&
            !deferredErrorMessage &&
            !wasAborted &&
            (record?.kind ?? "user") === "subagent" &&
            record?.parentChatId &&
            !parentContacted
          ) {
            void this.runTurn({
              text: PARENT_NUDGE_PROMPT,
              model: this.lastModel,
              permissionMode: args.permissionMode,
              nudge: true,
              origin: "system",
              originLabel: "System",
            });
          } else {
            // Agent fully finished this chat (no compact, no queued follow-up).
            // Push to the phone if the Mac has been idle a while (handled inside).
            void notifyAgentFinished(
              record?.title ?? this.chatId,
              basename(this.repoPath),
            );
          }
        }
      }
    }
  }

  private async persistAgentEvent(event: AgentEvent): Promise<void> {
    // Drop our own status/title/replay envelopes from the persisted log.
    // pending_attention is also excluded: it's transient blocking state —
    // the attentionId promise is gone after a restart so replaying it would
    // deadlock. The client re-shows the message from the persistent chat turn.
    if (
      event.type === "chat_status" ||
      event.type === "chat_title" ||
      event.type === "chat_replay" ||
      event.type === "user_message_echo" ||
      event.type === "pending_attention"
    ) {
      return;
    }

    // context_usage is not a turn event — persist it as a top-level field on
    // the ChatRecord so it survives page reload and can be re-emitted on replay,
    // without bloating the events array with a new entry every turn.
    // Skip during silent (compact) turns: the usage spike while compaction loads
    // the full history should not be written to disk — a page reload would show
    // an inflated number until the next real turn corrects it.
    if (event.type === "context_usage" && this.currentTurnSilent) return;
    if (event.type === "context_usage") {
      await withChatLock(this.repoPath, this.chatId, async () => {
        const r = await readChat(this.repoPath, this.chatId);
        if (!r) return;
        r.lastContextUsage = {
          usedTokens: event.usedTokens,
          contextWindowSize: event.contextWindowSize,
          pct: event.pct,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
        };
        await writeChat(this.repoPath, r);
      });
      return;
    }
    // Silent (auto-compact) turns must not write turn-content events to the
    // persisted log. Storing a `result` for a compact turn causes the client to
    // render an extra result line for every auto-compact that ran — the same
    // events that are already suppressed from being broadcast to subscribers.
    const SILENT_PERSIST_SUPPRESS = new Set([
      "result",
      "assistant",
      "user_tool_results",
      "turn_start",
      "turn_end",
    ]);
    if (this.currentTurnSilent && SILENT_PERSIST_SUPPRESS.has(event.type)) {
      return;
    }

    const ts = new Date().toISOString();
    const { chatId: _omit, ...rest } = event as AgentEvent & { chatId: string };
    const persisted = { ...rest, ts } as ChatEvent;
    const updated = await this.record(persisted);
    // Always suppress pushStatusFor for terminal turn events (result, turn_end):
    // the finally block in runTurn is solely responsible for broadcasting the
    // definitive terminal status, so firing it here too would send a duplicate
    // chat_status event — and trigger a duplicate notification on the client.
    //
    // For silent (auto-compact) turns, additionally suppress the mid-turn
    // content events (assistant, turn_start, etc.) so the chat never flickers
    // to "running" and back during an invisible compact turn.
    const ALWAYS_SUPPRESS_TYPES = new Set([
      "result",
      "turn_end",
    ]);
    const SILENT_SUPPRESS_TYPES = new Set([
      "assistant",
      "user_tool_results",
      "user_message_echo",
      "turn_start",
    ]);
    const suppressed =
      ALWAYS_SUPPRESS_TYPES.has(event.type) ||
      (this.currentTurnSilent && SILENT_SUPPRESS_TYPES.has(event.type));
    if (!suppressed) {
      await this.pushStatusFor(updated);
    }
  }

  // Fork the conversation at an existing user message. Saves the old trunk
  // from that point as a branch, then starts a fresh agent turn with newText.
  async runFork(args: {
    userMessageId: string;
    newText: string;
    attachments?: Attachment[];
    model: Model;
    permissionMode: PermissionMode;
  }): Promise<void> {
    await this.prepareStructuralOperation("Chat already running");

    const result = await forkAtMessage(
      this.repoPath,
      this.chatId,
      args.userMessageId,
      args.newText,
      args.attachments,
    );
    if (!result) throw new Error("Message not found or already branched away");

    // Notify subscribers: fork happened, then send full replay with new state.
    this.broadcast({
      type: "chat_forked",
      chatId: this.chatId,
      branchId: result.branchId,
      parentMessageId: args.userMessageId,
    });
    this.broadcast({
      type: "chat_replay",
      chatId: this.chatId,
      record: result.record,
      pendingPermissions: [],
      pendingAttentions: [],
    });

    await rebuildIndex(this.repoPath);

    // Now run the new turn. The user_message is already persisted by
    // forkAtMessage, so use isRetry=true to skip re-persisting it.
    await this.runTurn({
      text: args.newText,
      model: args.model,
      permissionMode: args.permissionMode,
      attachments: args.attachments,
      isRetry: true,
    });
  }

  // Switch the active branch at a fork point. Swaps trunk ↔ target branch
  // on disk then broadcasts the updated replay to all subscribers.
  async runSwitchBranch(args: {
    parentMessageId: string;
    targetBranchId: string;
  }): Promise<void> {
    await this.prepareStructuralOperation(
      "Cannot switch branch while agent is running",
    );

    const record = await switchBranch(
      this.repoPath,
      this.chatId,
      args.parentMessageId,
      args.targetBranchId,
    );
    if (!record) throw new Error("Branch not found");

    this.broadcast({
      type: "chat_replay",
      chatId: this.chatId,
      record,
      pendingPermissions: [],
      pendingAttentions: [],
    });
    this.broadcast({
      type: "chat_status",
      chatId: this.chatId,
      status: record.status,
      sessionId: record.sessionId,
    });

    await rebuildIndex(this.repoPath);
  }

  // Revert file changes and chat history back to just before the given
  // checkpoint, then broadcast the updated record to all subscribers.
  async runRevert(checkpointId: string): Promise<void> {
    await this.prepareStructuralOperation(
      "Cannot revert while agent is running",
    );

    const record = await revertToCheckpoint(this.repoPath, this.chatId, checkpointId);
    if (!record) throw new Error("Checkpoint not found");

    this.broadcast({
      type: "chat_replay",
      chatId: this.chatId,
      record,
      pendingPermissions: [],
      pendingAttentions: [],
    });
    this.broadcast({
      type: "chat_status",
      chatId: this.chatId,
      status: record.status,
      sessionId: record.sessionId,
    });

    await rebuildIndex(this.repoPath);
  }

  private async generateAndApplyTitle(firstPrompt: string): Promise<void> {
    try {
      const title = await generateTitle(firstPrompt);
      if (!title) return;
      const updated = await setTitle(this.repoPath, this.chatId, title, true);
      if (!updated) return;
      this.broadcast({
        type: "chat_title",
        chatId: this.chatId,
        title: updated.title,
      });
      await rebuildIndex(this.repoPath);
    } catch {
      // Best-effort; leave the placeholder title in place if it fails.
    }
  }
}

const sessions = new Map<string, AgentSession>();

function key(repoPath: string, chatId: string): string {
  return `${repoPath} ${chatId}`;
}

export function getSession(
  repoPath: string,
  chatId: string,
): AgentSession {
  const k = key(repoPath, chatId);
  let s = sessions.get(k);
  if (!s) {
    s = new AgentSession(chatId, repoPath);
    sessions.set(k, s);
  }
  return s;
}

export function tryGetSession(
  repoPath: string,
  chatId: string,
): AgentSession | undefined {
  return sessions.get(key(repoPath, chatId));
}

export function dropSession(repoPath: string, chatId: string): void {
  sessions.delete(key(repoPath, chatId));
}

export type { AgentSession };
