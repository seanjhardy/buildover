import { runAgentTurn, type RawAgentEvent } from "./agent.js";
import {
  appendEvent,
  computeStatus,
  readChat,
  rebuildIndex,
  setTitle,
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
  }

  // Kicks off a turn in the background. Resolves immediately; the actual work
  // streams through emit/persistence/broadcast.
  async runTurn(args: {
    text: string;
    model: Model;
    permissionMode: PermissionMode;
    attachments?: Attachment[];
  }): Promise<void> {
    if (this.running) {
      throw new Error("Chat already running");
    }
    this.running = true;
    this.abort = new AbortController();

    const record = await readChat(this.repoPath, this.chatId);
    if (!record) {
      this.running = false;
      throw new Error(`Chat ${this.chatId} not found`);
    }
    record.model = args.model;
    record.permissionMode = args.permissionMode;
    await writeChat(this.repoPath, record);

    const isFirstUserTurn = !record.events.some(
      (e) => e.type === "user_message",
    );

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
        signal: this.abort.signal,
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
      const final = await readChat(this.repoPath, this.chatId);
      if (final) {
        final.status = computeStatus(final);
        await writeChat(this.repoPath, final);
        await this.pushStatusFor(final);
      }
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
