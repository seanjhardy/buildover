import { runAgentTurn, type RawAgentEvent } from "./agent.js";
import {
  appendEvent,
  computeStatus,
  forkAtMessage,
  readChat,
  rebuildIndex,
  recoverStaleChat,
  setTitle,
  switchBranch,
  withChatLock,
  writeChat,
} from "./chats.js";
import { generateTitle } from "./title.js";
import type {
  AgentEvent,
  Attachment,
  ChatEvent,
  ChatRecord,
  Model,
  PermissionMode,
} from "../src/types.js";

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
  resolve: (result: { feedback?: string; interrupt?: boolean }) => void;
}

// Percentage of context window used that triggers automatic compaction.
const AUTO_COMPACT_THRESHOLD = 80;

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
  // True while a silent (auto-compact) turn is in progress. Used to suppress
  // chat_status broadcasts for turn-content events so the client never sees
  // the chat flicker to "running" and back during an invisible compact turn.
  private currentTurnSilent = false;
  // If a user message arrives while a silent auto-compact turn is in progress,
  // we can't run it immediately (running = true) but we also can't surface a
  // "Chat already running" error since the user has no idea compaction is
  // happening. Instead we park the turn here and start it as soon as the
  // compact finishes.
  private pendingUserTurn: Parameters<AgentSession["runTurn"]>[0] | null = null;
  // Tracks the active turn's permissionMode so it can be updated mid-turn.
  // canUseTool reads this on every invocation via the getter passed to the
  // SDK, so toggling bypass takes effect on the next decision.
  private currentPermissionMode: PermissionMode = "default";
  // Latest context window usage percentage — updated each time a context_usage
  // event arrives. Used to decide whether to auto-compact after a turn ends.
  private lastContextPct = 0;
  private lastModel: Model = "claude-sonnet-4-6";

  constructor(chatId: string, repoPath: string) {
    this.chatId = chatId;
    this.repoPath = repoPath;
  }

  isRunning(): boolean {
    return this.running;
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

  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
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

  private async record(event: ChatEvent): Promise<ChatRecord | null> {
    return appendEvent(this.repoPath, this.chatId, event);
  }

  private async pushStatusFor(record: ChatRecord | null): Promise<void> {
    if (!record) return;
    this.broadcast({
      type: "chat_status",
      chatId: this.chatId,
      status: record.status,
      sessionId: record.sessionId,
    });
    await rebuildIndex(this.repoPath);
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
  }): Promise<void> {
    if (this.running) {
      if (this.currentTurnSilent && !args.silent) {
        // A silent auto-compact is in progress. The user has no idea — the UI
        // showed the chat as done. Park this turn and run it the moment
        // compaction finishes (see the finally block below).
        this.pendingUserTurn = args;
        return;
      }
      throw new Error("Chat already running");
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
      };
      const afterUser = await this.record(userEvent);
      this.broadcast({
        type: "user_message_echo",
        chatId: this.chatId,
        id: userId,
        text: args.text,
        attachments: args.attachments,
      });
      await this.pushStatusFor(afterUser);

      if (isFirstUserTurn) {
        // Fire-and-forget title generation — never blocks the turn.
        void this.generateAndApplyTitle(args.text);
      }
    }

    // Track the latest model so we can use it for the auto-compact turn.
    this.lastModel = args.model;

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
    ]);

    const emit = (event: RawAgentEvent) => {
      // Tag with this session's chatId before broadcasting / persisting.
      const tagged = { ...event, chatId: this.chatId } as AgentEvent;
      // Track context usage so we can auto-compact after the turn ends.
      if (tagged.type === "context_usage") {
        this.lastContextPct = tagged.pct;
      }
      // During a silent turn (auto-compact), suppress turn-content events from
      // reaching subscribers so nothing appears in the chat UI.
      if (!args.silent || !SILENT_SUPPRESS.has(tagged.type)) {
        this.broadcast(tagged);
      }
      void this.persistAgentEvent(tagged);
    };

    try {
      await runAgentTurn({
        prompt: args.text,
        model: args.model,
        sessionId: record.sessionId,
        cwd: this.repoPath,
        permissionMode: args.permissionMode,
        getPermissionMode: () => this.currentPermissionMode,
        attachments: args.attachments,
        emit,
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
            void this.persistAgentEvent(ev);
          }),
        abortController: this.abort,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.broadcast({ type: "error", chatId: this.chatId, message });
      await this.record({
        type: "error",
        message,
        ts: new Date().toISOString(),
      });
    } finally {
      this.running = false;
      this.currentTurnSilent = false;
      this.pendingPermissions.clear();
      const final = await withChatLock(this.repoPath, this.chatId, async () => {
        const r = await readChat(this.repoPath, this.chatId);
        if (!r) return null;
        r.status = computeStatus(r);
        await writeChat(this.repoPath, r);
        return r;
      });
      if (final) await this.pushStatusFor(final);

      // Auto-compact if the context window is getting full.
      // Guard: don't re-trigger on the compact turn itself to avoid a loop.
      if (
        this.lastContextPct >= AUTO_COMPACT_THRESHOLD &&
        !args.text.startsWith("/compact")
      ) {
        void this.runTurn({
          text: "/compact",
          model: this.lastModel,
          permissionMode: args.permissionMode,
          isRetry: true,  // don't echo "/compact" as a user message
          silent: true,   // suppress assistant/result turns from reaching the UI
        });
      } else if (this.pendingUserTurn) {
        // A user message arrived while a silent compact turn was running and
        // was parked (see the running guard above). Now that the session is
        // free, send it through normally.
        const queued = this.pendingUserTurn;
        this.pendingUserTurn = null;
        void this.runTurn(queued);
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
    model: Model;
    permissionMode: PermissionMode;
  }): Promise<void> {
    if (this.running) throw new Error("Chat already running");

    const result = await forkAtMessage(
      this.repoPath,
      this.chatId,
      args.userMessageId,
      args.newText,
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
    });

    await rebuildIndex(this.repoPath);

    // Now run the new turn. The user_message is already persisted by
    // forkAtMessage, so use isRetry=true to skip re-persisting it.
    await this.runTurn({
      text: args.newText,
      model: args.model,
      permissionMode: args.permissionMode,
      isRetry: true,
    });
  }

  // Switch the active branch at a fork point. Swaps trunk ↔ target branch
  // on disk then broadcasts the updated replay to all subscribers.
  async runSwitchBranch(args: {
    parentMessageId: string;
    targetBranchId: string;
  }): Promise<void> {
    if (this.running) throw new Error("Cannot switch branch while agent is running");

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
