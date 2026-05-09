import { runAgentTurn, type RawAgentEvent } from "./agent.js";
import {
  appendEvent,
  computeStatus,
  readChat,
  rebuildIndex,
  recoverStaleChat,
  setTitle,
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

// One AgentSession per chat. Lives independently of the WS connections that
// happen to be subscribed at any given moment — closing the browser does not
// stop the agent. Persistence is the source of truth; subscribers are pushed
// live events for low-latency UI updates.
class AgentSession {
  readonly chatId: string;
  readonly repoPath: string;
  private subscribers = new Set<Subscriber>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private abort?: AbortController;
  private running = false;
  // Tracks the active turn's permissionMode so it can be updated mid-turn.
  // canUseTool reads this on every invocation via the getter passed to the
  // SDK, so toggling bypass takes effect on the next decision.
  private currentPermissionMode: PermissionMode = "default";

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
      (rec) => this.pushStatusFor(rec),
    );
    pending.resolve(result);
    return true;
  }

  // Updates the in-flight turn's permissionMode. When switching to bypass we
  // also auto-resolve any outstanding permission prompts so the user doesn't
  // have to click each one individually after toggling the mode.
  setPermissionMode(mode: PermissionMode): void {
    this.currentPermissionMode = mode;
    if (mode === "bypassPermissions" && this.pendingPermissions.size > 0) {
      for (const [requestId] of this.pendingPermissions) {
        this.resolvePermission(requestId, { behavior: "allow" });
      }
    }
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
  async runTurn(args: {
    text: string;
    model: Model;
    permissionMode: PermissionMode;
    attachments?: Attachment[];
    isRetry?: boolean;
  }): Promise<void> {
    if (this.running) {
      throw new Error("Chat already running");
    }
    this.running = true;
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

    const emit = (event: RawAgentEvent) => {
      // Tag with this session's chatId before broadcasting / persisting.
      const tagged = { ...event, chatId: this.chatId } as AgentEvent;
      this.broadcast(tagged);
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
      this.pendingPermissions.clear();
      const final = await withChatLock(this.repoPath, this.chatId, async () => {
        const r = await readChat(this.repoPath, this.chatId);
        if (!r) return null;
        r.status = computeStatus(r);
        await writeChat(this.repoPath, r);
        return r;
      });
      if (final) await this.pushStatusFor(final);
    }
  }

  private async persistAgentEvent(event: AgentEvent): Promise<void> {
    // Drop our own status/title/replay envelopes from the persisted log.
    if (
      event.type === "chat_status" ||
      event.type === "chat_title" ||
      event.type === "chat_replay" ||
      event.type === "user_message_echo"
    ) {
      return;
    }
    const ts = new Date().toISOString();
    const { chatId: _omit, ...rest } = event as AgentEvent & { chatId: string };
    const persisted = { ...rest, ts } as ChatEvent;
    const updated = await this.record(persisted);
    await this.pushStatusFor(updated);
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
