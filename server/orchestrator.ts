import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeOrchestratorMcp } from "./orchestratorTools.js";
import type {
  OrchestratorEvent,
  OrchestratorNav,
} from "../src/types.js";

export type OrchestratorSubscriber = (event: OrchestratorEvent) => void;

const ORCHESTRATOR_MODEL =
  process.env.ORCHESTRATOR_MODEL ?? "claude-haiku-4-5";

const SYSTEM_PROMPT = `You are the Buildover orchestrator: a fast voice-to-agent dispatcher. The user speaks to you and you ROUTE their request to a chat — almost always by calling create_chat. You are NOT a coding assistant, NOT an advisor, NOT a gatekeeper. You are a switchboard.

Tools:
- list_repos — discover available repos
- open_repo — make a repo active
- list_chats — discover existing chats inside a repo
- switch_to_chat — navigate to an existing chat
- create_chat — create a new chat AND fire the user's request as the first message inside it (this is your default action)

DEFAULT BEHAVIOUR: call create_chat. Pass the user's request as the \`prompt\` argument, with disfluencies ("um", "uh", false starts) cleaned up. The downstream coding agent — not you — handles ANY topic the user asks about: writing code, fixing bugs, refactoring, design discussion, brainstorming, ideation, planning, reviewing options, explaining things, answering questions about a repo. You DO NOT JUDGE whether a request is "appropriate for an engineering agent" — anything the user says into the mic is in scope, and you dispatch it.

NEVER refuse a request because it's "ideation", "high-level", "not a concrete engineering task", "better suited to a human", or any similar framing. The downstream agent is fully capable of brainstorming, ideating, and discussing. Just dispatch.

Repo selection: prefer the user's currently-active repo (given in the [Workspace context] line). If they explicitly name a different repo, use list_repos to find it. Never ask the user "which repo?" — just use the active one.

ONLY ask for clarification when the transcript is genuinely unintelligible: pure filler ("um... yeah... uh"), a few stray words with no actionable content, or contradictory instructions. When in doubt, dispatch — a chat the user didn't quite want is fine, they can delete it. A request you refused is friction.

REPLY FORMAT — CRITICAL:
- Your text reply is shown in a tiny one-line bar.
- After create_chat, reply with something like: "Started." or "On it." or "Created chat for the login bug." That's it.
- After switch_to_chat: "Switching to <title>." or "Done."
- NEVER explain, list options, ramble, apologise, give caveats, or write multi-line responses. The downstream agent handles explanation; you just confirm the dispatch.
- Do NOT describe the tools you called. Do NOT recap the user's request back to them.

Call create_chat at most once per turn unless the user explicitly asked for two distinct chats.`;

class OrchestratorSession {
  private subscribers = new Set<OrchestratorSubscriber>();
  // Recent stderr output from the SDK's CLI subprocess. Captured per-turn so
  // that if the process crashes ("exited with code 1") we can surface what
  // it actually said before failing.
  private lastStderr = "";
  private mcp = makeOrchestratorMcp({
    emitNav: (nav) => this.emit({ type: "nav", nav }),
  });
  // Sequential queue: messages are appended as they arrive and run one by one
  // so the SDK never sees concurrent turns on the same session.
  private queue: { text: string; activeRepoPath: string | null | undefined }[] =
    [];
  private running = false;
  private currentAbort: AbortController | undefined;

  subscribe(sub: OrchestratorSubscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  private emit(event: OrchestratorEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        /* never let one subscriber kill the others */
      }
    }
  }

  enqueue(text: string, activeRepoPath: string | null | undefined): void {
    if (!text.trim()) return;
    this.queue.push({ text: text.trim(), activeRepoPath });
    void this.drain();
  }

  // Aborts the in-flight turn (if any) and drops queued messages. Used when
  // the user explicitly asks to stop; the mic flow does NOT call this.
  interrupt(): void {
    this.queue = [];
    this.currentAbort?.abort();
  }

  // Starts a fresh session: drops in-flight + queued and resets per-minute
  // rate limits. Each turn is already independent (no resume — see runOne)
  // so this is mostly a way to clear the create_chat token bucket.
  reset(): void {
    this.interrupt();
    this.mcp.resetRateLimits();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        await this.runOne(next.text, next.activeRepoPath ?? null);
      }
    } finally {
      this.running = false;
    }
  }

  private async runOne(
    text: string,
    activeRepoPath: string | null,
  ): Promise<void> {
    const ac = new AbortController();
    this.currentAbort = ac;
    this.emit({ type: "turn_start" });

    const contextHeader = activeRepoPath
      ? `\n\n[Workspace context] The user's currently active repo path is: ${activeRepoPath}`
      : "\n\n[Workspace context] The user has no active repo open right now.";
    const userMessage = text + contextHeader;

    const promptIterable = (async function* () {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: userMessage },
        parent_tool_use_id: null,
        session_id: "",
      };
    })();

    this.lastStderr = "";
    let stream: any;
    try {
      stream = query({
        prompt: promptIterable,
        options: {
          model: ORCHESTRATOR_MODEL,
          systemPrompt: SYSTEM_PROMPT,
          // The orchestrator never edits files — strip the default Claude
          // Code toolset and only expose our MCP tools.
          tools: [],
          mcpServers: { "buildover-orchestrator": this.mcp.server },
          // No `resume` — `persistSession: false` means sessions aren't on
          // disk, and resuming a non-persisted session crashes the CLI
          // subprocess ("Claude Code process exited with code 1"). The
          // orchestrator is stateless across turns by design: the active
          // repo path is injected into the user message each turn, which
          // is all the cross-turn context it needs.
          permissionMode: "bypassPermissions",
          includePartialMessages: false,
          abortController: ac,
          // Don't write transcripts to ~/.claude/projects — these aren't
          // engineering chats and would otherwise clutter the user's VS Code
          // Claude Code extension history.
          persistSession: false,
          // Capture subprocess stderr so failures surface as readable
          // errors instead of opaque "exited with code 1" messages.
          stderr: (data: string) => {
            // Cap to keep memory bounded if something is spamming.
            this.lastStderr = (this.lastStderr + data).slice(-4000);
          },
          // Cap runaway loops: the orchestrator should not need many turns.
          maxTurns: 6,
        },
      });
    } catch (e) {
      this.emit({
        type: "error",
        message: this.formatError(e),
      });
      this.emit({ type: "turn_end" });
      return;
    }

    try {
      for await (const message of stream as AsyncIterable<any>) {
        switch (message.type) {
          case "system": {
            // Nothing to capture — orchestrator turns are stateless, so we
            // don't track session_id between turns.
            break;
          }
          case "assistant": {
            const blocks = message.message?.content ?? [];
            for (const b of blocks) {
              if (!b || typeof b !== "object") continue;
              if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
                this.emit({ type: "assistant_text", text: b.text });
              } else if (b.type === "tool_use") {
                this.emit({
                  type: "tool_call",
                  name: String(b.name ?? "tool"),
                  input: (b.input ?? {}) as Record<string, unknown>,
                });
              }
            }
            break;
          }
          case "user": {
            // tool_result blocks come back wrapped as a user message
            const blocks = message.message?.content ?? [];
            for (const b of blocks) {
              if (!b || typeof b !== "object") continue;
              if (b.type === "tool_result") {
                this.emit({
                  type: "tool_result",
                  name: "tool",
                  ok: !b.is_error,
                });
              }
            }
            break;
          }
          case "result":
          default:
            break;
        }
      }
    } catch (err) {
      this.emit({
        type: "error",
        message: this.formatError(err),
      });
    } finally {
      this.currentAbort = undefined;
      this.emit({ type: "turn_end" });
    }
  }

  // Stitch SDK errors with any captured stderr from the CLI subprocess so
  // crashes are diagnosable instead of just "exited with code 1".
  private formatError(err: unknown): string {
    const base = err instanceof Error ? err.message : String(err);
    const tail = this.lastStderr.trim();
    if (!tail) return base;
    // Keep it bounded — we don't want a multi-KB stack trace in the bar.
    const snippet = tail.length > 600 ? `…${tail.slice(-600)}` : tail;
    return `${base}\n[stderr] ${snippet}`;
  }
}

let singleton: OrchestratorSession | undefined;

export function getOrchestrator(): OrchestratorSession {
  if (!singleton) singleton = new OrchestratorSession();
  return singleton;
}

export type { OrchestratorNav };
