import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createCustomToolsServer,
  type RequestAttentionAck,
  type RequestCompact,
  type RequestHandoff,
} from "./customTools.js";
import { readInstalledServers, toSdkMcpConfig } from "./mcp-config.js";
import { updateToolsCache } from "./mcp-tools-cache.js";
import { readPrefs } from "./prefs.js";
import { DEFAULT_AUTO_COMPACT_WINDOW } from "./tokenEconomy.js";
import {
  EFFORT_LEVELS,
  effortLevelsFor,
  type AgentEvent,
  type AgentTask,
  type AppPrefs,
  type Attachment,
  type ContentBlock,
  type EffortLevel,
  type Model,
  type PermissionMode,
} from "../src/types.js";

// Appended to every chat's system prompt. The native Task* progress tools are
// disabled (see disallowedTools below), so we explicitly steer the model to use
// the TodoWrite tool instead — our sidebar (useTodos / TodoPanel) renders
// progress from TodoWrite, and without this nudge the model stops tracking
// progress at all once the Task tools disappear.
const TODO_TRACKING_INSTRUCTION = `Track progress using the TodoWrite tool, not the Task tools. Maintain a todo list for any multi-step work: add items as you plan, mark exactly one item in_progress while you work on it, and mark it completed as soon as it is done. This list is rendered in the user's sidebar, so keep it current.`;

// Also appended to every chat: when to reach for ShowImage, which displays an
// image to the user without it entering the model's context.
const SHOW_IMAGE_INSTRUCTION = `To show the user an image you don't need to look at yourself (a screenshot, render or plot they asked to see), call the ShowImage tool with its absolute path. It renders inline in the chat and never enters your context, so it costs no image tokens; only Read an image when you need to inspect it.`;

// The agent emits events without a chatId — the session wraps emit() to tag
// each one before broadcasting / persisting. This keeps agent.ts unaware of
// session identity. Distributive Omit so each union member loses chatId
// individually instead of collapsing to a common shape.
type DistOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
export type RawAgentEvent = DistOmit<
  Extract<
    AgentEvent,
    {
      type:
        | "system_init"
        | "assistant"
        | "assistant_partial"
        | "user_tool_results"
        | "result"
        | "error"
        | "turn_start"
        | "turn_end"
        | "permission_request"
        | "context_usage"
        | "chat_notice";
    }
  >,
  "chatId"
>;

export interface RunArgs {
  prompt: string;
  model: Model;
  sessionId?: string;
  // When set (by fork / branch-switch / revert), resume `sessionId` only up
  // to and including this SDK message uuid, forking into a fresh session.
  // Without it the SDK would replay the session's full transcript — including
  // the messages the user just edited away or reverted.
  resumeSessionAt?: string;
  cwd?: string;
  permissionMode: PermissionMode;
  // Read at every canUseTool invocation so toggling bypass mid-turn takes
  // effect immediately. Falls back to the static `permissionMode` above if
  // the caller doesn't supply this.
  getPermissionMode?: () => PermissionMode;
  attachments?: Attachment[];
  emit: (event: RawAgentEvent) => void;
  // Awaits the user's decision for a tool permission request. The server
  // wires this up by emitting `permission_request` and storing the resolver
  // until a matching `permission_response` arrives over the WebSocket.
  requestPermission: (req: {
    toolName: string;
    input: Record<string, unknown>;
    suggestions: unknown[];
  }) => Promise<
    | {
        behavior: "allow";
        updatedInput?: Record<string, unknown>;
        updatedPermissions?: unknown[];
      }
    | { behavior: "deny"; message: string; interrupt?: boolean }
  >;
  // Called by the RequestUserAttention tool handler. Resolves only when the
  // client sends an attention_ack — this is what makes the tool block
  // regardless of permission-mode bypass.
  requestAttentionAck: RequestAttentionAck;
  // Called by the ClearContext tool handler. Signals to the session that the
  // agent wants to compact history; the session schedules a /compact turn
  // after the current turn ends (same path as auto-compact).
  requestCompact: RequestCompact;
  // Called by the Handoff tool handler: after the turn ends the session writes
  // a handoff note and opens a fresh chat to continue in.
  requestHandoff: RequestHandoff;
  // Aborting this stops the current turn only. Background tasks keep running;
  // ClaudeLiveQuery.close() is what tears the whole CLI process down.
  abortController?: AbortController;
  // Optional hook called just before a file-modifying tool (Write, Edit,
  // MultiEdit) executes.  The session uses this to snapshot the target file's
  // current content so it can be restored on revert.
  onBeforeFileTool?: (toolName: string, input: unknown) => Promise<void>;
  // Extra instructions appended to the default Claude Code system prompt.
  // Used by coordinator/subagent chats to describe their role and workflow.
  systemPromptAppend?: string;
  // When true, enables the 1M token context window beta for Claude models.
  context1m?: boolean;
  // Additional in-process MCP servers for this turn (e.g. the
  // "buildover-agents" coordination toolset for coordinator/subagent chats).
  extraMcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  // When set, overrides CLAUDE_CONFIG_DIR for the CLI subprocess so the turn
  // runs under a non-primary Claude account (see claudeAccounts.ts). Omitted
  // for the primary account, which keeps its existing environment untouched.
  claudeConfigDir?: string;
}

// Clamps the preferred effort to the highest level the model supports at or
// below it (e.g. `xhigh` → `high` on Sonnet 4.6). Undefined when the model has
// no effort support or no preference is set.
function resolveEffort(model: Model, preferred: EffortLevel | undefined): EffortLevel | undefined {
  if (!preferred) return undefined;
  const supported = effortLevelsFor(model);
  const ceiling = EFFORT_LEVELS.indexOf(preferred);
  return [...supported].reverse().find((l) => EFFORT_LEVELS.indexOf(l) <= ceiling);
}

// Tools that must always surface a UI prompt regardless of permission mode,
// because they are user-interaction checkpoints, not dangerous operations.
// Note: RequestUserAttention is intentionally absent — it blocks inside its
// own MCP tool handler (via requestAttentionAck), not via the permission
// system. Routing it through requestPermission would deadlock because the
// client ignores permission_request events for this tool.
const ALWAYS_PROMPT_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"]);

// Tool names that modify files — we snapshot before these run.
const FILE_MODIFYING_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

// After a turn ends with nothing running, the CLI is kept alive for a while
// before its input is closed (letting it exit). A follow-up message sent in
// that window goes straight to the model; one sent after it pays a cold start
// (hooks, plugins, every MCP server reconnecting, transcript reload), which
// is several seconds. A task that settles in the window can still wake the
// model.
const IDLE_WIND_DOWN_MS = 15 * 60_000;
// Each idle CLI holds a few hundred MB, so only the most recently used ones
// stay warm; older idle ones are wound down early.
const MAX_IDLE_PROCESSES = 4;
const idleProcesses = new Set<ClaudeLiveQuery>();

// Lets idle processes exit so the next turn starts one that picks up changed
// config (e.g. installed MCP servers, which are read at process start).
export function windDownIdleProcesses(): void {
  for (const p of [...idleProcesses]) p.windDownNow();
}
// A soft interrupt normally lands within a second. If the CLI hasn't closed
// the turn by then, fall back to killing the process outright.
const INTERRUPT_FALLBACK_MS = 5_000;
// Grace before trusting background_tasks_changed over a missing
// task_notification.
const LEVEL_RECONCILE_MS = 2_000;
type ThinkingDisplay = "summarized" | "omitted";

function thinkingDisplay(prefs: AppPrefs): ThinkingDisplay {
  return prefs.thinkingSummaries ? "summarized" : "omitted";
}

// Minimum gap between assistant_partial updates for one block.
const PARTIAL_THROTTLE_MS = 80;

export interface LiveQueryHooks {
  // Full task snapshot, sent whenever any task changes.
  onTasksChanged: (tasks: AgentTask[]) => void;
  // The CLI started a turn on its own — a background task settled and it woke
  // the model to handle the result. `notes` are the task summaries that
  // triggered it. The session should call adoptTurn() once it is free.
  // `steered` is set when the turn is a steered message (see steer()) that
  // the CLI ran on its own because the turn it was sent into ended first.
  onUnsolicitedTurn: (notes: string[], steered: boolean) => void;
  // The CLI process exited (input closed, close() called, or it crashed).
  onClosed: () => void;
}

interface TurnSink {
  emit: (event: RawAgentEvent) => void;
  resolve: () => void;
  interrupted: boolean;
}

// Push-based prompt stream. The CLI stays alive for as long as this iterable
// is open, which is what lets background tasks outlive the turn that started
// them.
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  get isEnded(): boolean {
    return this.ended;
  }

  push(message: SDKUserMessage): void {
    if (this.ended) return;
    this.items.push(message);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

const OUTPUT_PATH_RE = /written to: (\S+?\.output)\b/;

function clip(text: unknown, max = 300): string {
  const s = String(text ?? "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// A backgrounded Agent/Task tool returns an immediate "launched in the
// background" placeholder tool_result; the real result arrives later. We must
// not treat the placeholder as the task finishing.
function isBackgroundLaunchPlaceholder(content: unknown): boolean {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c: any) => (typeof c === "string" ? c : (c?.text ?? ""))).join("\n")
        : "";
  const t = text.toLowerCase();
  return (
    t.includes("async agent launched") ||
    t.includes("working in the background") ||
    t.includes("running in the background")
  );
}

// The line shown in the chat above a turn the CLI started because this task
// settled. Shell summaries already read well ('Background command "…"
// completed (exit code 0)'); a subagent's is just its final message.
function describeSettledTask(t: AgentTask): string {
  if (t.taskType !== "local_agent") return t.summary || `${t.description} ${t.status}`;
  const head = `Agent "${t.description}" ${t.status}`;
  return clip(t.summary ? `${head}: ${t.summary}` : head, 500);
}

// One Claude CLI process for a chat, carrying one or more turns. Each turn
// ends at the SDK's `result`; the process is kept alive afterwards only while
// subagents / shell commands it started in the background are still running,
// and winds down on its own once they settle.
export class ClaudeLiveQuery {
  readonly cwd: string;
  // The Claude account this process runs under; a turn for another account
  // needs a new process (see canReuse).
  private readonly claudeConfigDir: string | undefined;
  private readonly input = new InputQueue();
  private readonly abort = new AbortController();
  private readonly stream: Query;
  // The latest turn's args. SDK callbacks (canUseTool, custom tools) read
  // through this so work done by background tasks after a turn has ended
  // still reaches the session.
  private args: RunArgs;
  private model: Model;
  private effort: EffortLevel | undefined;
  private thinkingDisplay: ThinkingDisplay;
  private permissionMode: PermissionMode;
  private sessionId?: string;
  private sink: TurnSink | null = null;
  // False until the first turn is sent. That turn is the one this process was
  // started for, so it may carry a truncated resume that canReuse rejects.
  private used = false;
  // Set between a Stop and the CLI's result for the stopped turn.
  private draining: { promise: Promise<void>; resolve: () => void } | null = null;
  // Output of a CLI-initiated turn, held until the session adopts it.
  private buffered: any[] = [];
  private bufferedInit: any = null;
  private unsolicitedPending = false;
  // Summaries of tasks that settled while no turn was open.
  private notes: string[] = [];
  // Uuids of steered messages the CLI hasn't folded into a turn yet.
  private readonly unfoldedSteers = new Set<string>();
  private readonly tasks = new Map<string, AgentTask>();
  private readonly outputFiles = new Map<string, string>();
  // tool_use id → output path, parsed from background Bash tool results.
  private readonly outputPathsByToolUse = new Map<string, string>();
  // tool_use ids of Agent/Task subagents we track from the tool_use block
  // itself, because the CLI does not reliably emit task_* lifecycle messages
  // for them. Keyed in `tasks` by tool_use id; a real task_started with the
  // same tool_use_id supersedes the synthesized entry.
  private readonly syntheticAgentTaskIds = new Set<string>();
  // Assistant messages across every turn, scanned for the latest TodoWrite.
  private readonly assistantMessages: any[] = [];
  private idleTimer?: NodeJS.Timeout;
  private closed = false;
  private lastPublished = "";
  // True while a rate-limit / retry notice is showing on the client, so the
  // next real output can clear it. `warningShown` is the softer "approaching
  // limit" notice, which stays up until the limit status says it is allowed
  // again (or the turn ends).
  private noticeActive = false;
  private warningShown = false;
  // The text / thinking block being streamed right now.
  private partial: {
    id: string;
    blockType: "text" | "thinking";
    text: string;
    lastEmit: number;
    timer?: NodeJS.Timeout;
  } | null = null;
  private partialMessageId = "";

  static async start(args: RunArgs, hooks: LiveQueryHooks): Promise<ClaudeLiveQuery> {
    const prefs = await readPrefs();
    const effort = resolveEffort(args.model, prefs.claudeEffort);
    const autoCompactWindow = prefs.autoCompactWindow ?? DEFAULT_AUTO_COMPACT_WINDOW;
    return new ClaudeLiveQuery(args, effort, thinkingDisplay(prefs), autoCompactWindow, hooks);
  }

  private markActive(): void {
    idleProcesses.delete(this);
  }

  private markIdle(): void {
    idleProcesses.delete(this);
    idleProcesses.add(this);
    for (const p of idleProcesses) {
      if (idleProcesses.size <= MAX_IDLE_PROCESSES) break;
      p.windDownNow();
    }
  }

  // Closes the input of an idle process now rather than at the timer.
  windDownNow(): void {
    idleProcesses.delete(this);
    clearTimeout(this.idleTimer);
    if (!this.sink && !this.unsolicitedPending && !this.hasRunningTasks()) {
      this.input.end();
    }
  }

  private constructor(
    args: RunArgs,
    effort: EffortLevel | undefined,
    display: ThinkingDisplay,
    autoCompactWindow: number,
    private readonly hooks: LiveQueryHooks,
  ) {
    this.args = args;
    this.claudeConfigDir = args.claudeConfigDir;
    this.model = args.model;
    this.effort = effort;
    this.thinkingDisplay = display;
    this.permissionMode = args.permissionMode;
    this.sessionId = args.sessionId;
    this.cwd = args.cwd ?? process.cwd();

    const customToolsServer = createCustomToolsServer(
      (req) => this.args.requestAttentionAck(req),
      (reason) => this.args.requestCompact(reason),
      this.cwd,
      () => this.currentTodos(),
      (reason) => this.args.requestHandoff(reason),
    );

    const canUseTool: CanUseTool = async (toolName, input) => {
      const turn = this.args;
      // Snapshot the target file before any file-modifying tool executes so we
      // can restore it on revert.  Do this regardless of permission mode so even
      // auto-approved edits are covered.
      if (turn.onBeforeFileTool && FILE_MODIFYING_TOOLS.has(toolName)) {
        await turn.onBeforeFileTool(toolName, input).catch(() => {
          // Best-effort: a snapshot failure must never block the agent turn.
        });
      }

      // RequestUserAttention is always auto-allowed at the canUseTool stage.
      // The MCP tool handler blocks the turn itself by awaiting requestAttentionAck,
      // which only resolves when the client sends an attention_ack WebSocket message.
      if (toolName === "RequestUserAttention") {
        return { behavior: "allow", updatedInput: input };
      }

      // In bypassPermissions mode, the SDK still calls canUseTool for every
      // tool when the callback is supplied — so the mode alone won't suppress
      // prompts. Short-circuit here to honor the user's choice.
      // Exception: ExitPlanMode must always go through the permission UI so
      // its plan is shown to the user.
      const currentMode = turn.getPermissionMode?.() ?? turn.permissionMode;
      if (currentMode === "bypassPermissions" && !ALWAYS_PROMPT_TOOLS.has(toolName)) {
        return { behavior: "allow", updatedInput: input };
      }
      const decision = await turn.requestPermission({
        toolName,
        input,
        suggestions: [],
      });
      if (decision.behavior === "allow") {
        return {
          behavior: "allow",
          updatedInput: decision.updatedInput ?? input,
        };
      }
      return {
        behavior: "deny",
        message: decision.message ?? "Denied by user",
        interrupt: decision.interrupt,
      };
    };

    // SDK requires `canUseTool` to be paired with `stream-json` input, which
    // the push-based InputQueue provides.
    this.stream = query({
      prompt: this.input,
      options: {
        model: args.model,
        cwd: this.cwd,
        resume: args.sessionId,
        // Truncated resume after an edit / branch-switch / revert: cut the
        // resumed history at this message uuid and fork into a new session so
        // the abandoned branch's session file stays intact for future branch
        // switches. The forked session's id arrives via system_init and
        // replaces record.sessionId (which also clears the one-shot marker).
        ...(args.sessionId && args.resumeSessionAt
          ? { resumeSessionAt: args.resumeSessionAt, forkSession: true }
          : {}),
        permissionMode: args.permissionMode,
        canUseTool,
        ...(args.claudeConfigDir
          ? { env: { ...process.env, CLAUDE_CONFIG_DIR: args.claudeConfigDir } }
          : {}),
        // Streams text / thinking as it is generated (see handleStreamEvent),
        // so the chat shows output as soon as the model starts rather than
        // once each whole block is done.
        includePartialMessages: true,
        // Adaptive-thinking models (Opus 4.8+) only ever return a summary of
        // their thinking, and only when asked: `summarized` holds the reply
        // back ~1–3s while the summary is written, so it is opt-in (see
        // thinkingDisplay). `omitted` returns empty thinking blocks, which the
        // UI hides.
        thinking: { type: "adaptive", display },
        // User-chosen effort from the composer slider; omitted → model default.
        ...(effort ? { effort } : {}),
        ...(args.context1m ? { betas: ["context-1m-2025-08-07" as const] } : {}),
        // Every call re-reads the whole context, so cost scales with its size.
        // Compact well before the 1M window (see tokenEconomy.ts). The Haiku
        // search/research agents and the image-downscale hook come from the
        // user's global ~/.claude settings, which this query loads because
        // `settingSources` is deliberately omitted.
        settings: { autoCompactWindow },
        // One-line progress summaries for running subagents, shown on their
        // row in the Agents panel.
        agentProgressSummaries: true,
        // The claude_code preset exposes the harness's native TaskCreate/
        // TaskUpdate/TaskList tools and periodically nudges the model to use
        // them for progress tracking. We render progress from our own TodoWrite
        // tool (see useTodos / TodoPanel), so disable the Task tools to stop the
        // model defaulting to them — otherwise the sidebar never populates.
        disallowedTools: [
          "TaskCreate",
          "TaskUpdate",
          "TaskList",
          "TaskGet",
          "TaskOutput",
          "TaskStop",
        ],
        // Owned by this query (not the turn) so stopping a turn doesn't take
        // background tasks down with it; close() aborts it.
        abortController: this.abort,
        // Every chat gets a base instruction steering progress tracking to our
        // TodoWrite tool (rendered in the sidebar via useTodos/TodoPanel). The
        // native Task tools are disabled above, so without this the model would
        // simply stop tracking progress. Coordinator/subagent chats get extra
        // role instructions appended on top.
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: [TODO_TRACKING_INSTRUCTION, SHOW_IMAGE_INSTRUCTION, args.systemPromptAppend]
            .filter(Boolean)
            .join("\n\n"),
        },
        // Register custom tools (e.g. RequestUserAttention) so the SDK
        // knows about them and routes them through canUseTool → requestPermission.
        mcpServers: {
          "buildover-custom-tools": customToolsServer,
          // Coordination tools for coordinator/subagent chats.
          ...(args.extraMcpServers ?? {}),
          // User-installed servers from mcp-servers.json — re-read whenever a
          // CLI process starts so installs/removals take effect without a
          // server restart.
          ...toSdkMcpConfig(readInstalledServers()),
        },
      },
    });

    void this.consume();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get currentModel(): Model {
    return this.model;
  }

  // Whether the next turn for this chat can be sent into this process rather
  // than spawning a fresh one. A truncated resume (fork / revert) or a
  // different cwd or session needs a new process.
  canReuse(args: RunArgs): boolean {
    return (
      !this.closed &&
      !this.input.isEnded &&
      (args.cwd ?? process.cwd()) === this.cwd &&
      !args.resumeSessionAt &&
      args.sessionId === this.sessionId &&
      args.claudeConfigDir === this.claudeConfigDir
    );
  }

  hasRunningTasks(): boolean {
    for (const t of this.tasks.values()) if (t.status === "running") return true;
    return false;
  }

  hasPendingUnsolicitedTurn(): boolean {
    return this.unsolicitedPending;
  }

  taskList(): AgentTask[] {
    return [...this.tasks.values()];
  }

  outputFileFor(taskId: string): string | undefined {
    return this.outputFiles.get(taskId);
  }

  async stopTask(taskId: string): Promise<void> {
    if (this.closed) return;
    await this.stream.stopTask(taskId);
  }

  // Tears the CLI down immediately, killing every task it is running.
  close(): void {
    if (this.closed) return;
    idleProcesses.delete(this);
    clearTimeout(this.idleTimer);
    this.input.end();
    this.abort.abort();
  }

  // Sends a user message as a new turn. Resolves (with the possibly-new
  // session id) once the CLI reports the turn's result.
  async runTurn(args: RunArgs): Promise<string | undefined> {
    await this.settled();
    const usable = this.used ? this.canReuse(args) : !this.closed && !this.input.isEnded;
    if (!usable) throw new Error("Claude process is no longer reusable");
    this.used = true;
    this.args = args;
    // Anything still unfolded runs in this turn's prompt batch.
    this.unfoldedSteers.clear();
    await this.applyTurnSettings(args);
    const sink = this.openSink(args);
    // A CLI-initiated turn the session never got round to adopting folds into
    // this one rather than being dropped.
    this.flushBuffered();
    this.input.push({
      type: "user",
      message: {
        role: "user",
        content: renderPromptWithAttachments(args.prompt, args.attachments),
      },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
    });
    await sink;
    return this.sessionId;
  }

  // Whether steer() can deliver into the turn that is running right now.
  canSteer(): boolean {
    return !!this.sink && !this.draining && !this.closed && !this.input.isEnded;
  }

  // Sends a message into the running turn without stopping it. The CLI folds
  // it in after the current tool round; if the turn finishes first, the CLI
  // runs it as a turn of its own (adopted via onUnsolicitedTurn).
  steer(prompt: string, attachments?: Attachment[]): boolean {
    if (!this.canSteer()) return false;
    const uuid = randomUUID();
    this.unfoldedSteers.add(uuid);
    this.input.push({
      type: "user",
      message: {
        role: "user",
        content: renderPromptWithAttachments(prompt, attachments),
      },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
      priority: "next",
      uuid,
    } as SDKUserMessage);
    return true;
  }

  // Attaches a session turn to output the CLI produced on its own (see
  // onUnsolicitedTurn). Resolves at that turn's result.
  async adoptTurn(args: RunArgs): Promise<string | undefined> {
    if (!this.unsolicitedPending) return this.sessionId;
    this.args = args;
    const sink = this.openSink(args);
    this.flushBuffered();
    await sink;
    return this.sessionId;
  }

  private async applyTurnSettings(args: RunArgs): Promise<void> {
    if (args.model !== this.model) {
      await this.stream.setModel(args.model).catch((err) =>
        console.warn("[agent] setModel failed:", err instanceof Error ? err.message : err),
      );
      this.model = args.model;
    }
    // The process can outlive a change to the composer's effort slider or
    // thinking-summaries toggle.
    const prefs = await readPrefs();
    const display = thinkingDisplay(prefs);
    if (display !== this.thinkingDisplay) {
      await this.stream.setMaxThinkingTokens(null, display).catch((err) =>
        console.warn("[agent] setMaxThinkingTokens failed:", err instanceof Error ? err.message : err),
      );
      this.thinkingDisplay = display;
    }
    const effort = resolveEffort(args.model, prefs.claudeEffort);
    if (effort !== this.effort) {
      await this.stream.applyFlagSettings({ effortLevel: effort ?? null }).catch((err) =>
        console.warn("[agent] applyFlagSettings failed:", err instanceof Error ? err.message : err),
      );
      this.effort = effort;
    }
    if (args.permissionMode !== this.permissionMode) {
      await this.stream.setPermissionMode(args.permissionMode).catch((err) =>
        console.warn("[agent] setPermissionMode failed:", err instanceof Error ? err.message : err),
      );
      this.permissionMode = args.permissionMode;
    }
  }

  private openSink(args: RunArgs): Promise<void> {
    clearTimeout(this.idleTimer);
    this.markActive();
    this.unsolicitedPending = false;
    this.notes = [];
    return new Promise<void>((resolve) => {
      const sink: TurnSink = { emit: args.emit, resolve, interrupted: false };
      this.sink = sink;
      args.emit({ type: "turn_start" });
      const signal = args.abortController?.signal;
      if (signal) {
        const onAbort = () => this.interruptTurn(sink);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      // The process may have died while the buffered output was waiting.
      if (this.closed && this.buffered.length === 0) this.endTurn(sink);
    });
  }

  private flushBuffered(): void {
    const pending = this.buffered.splice(0);
    for (const message of pending) this.route(message);
    if (this.closed && this.sink) this.endTurn(this.sink);
  }

  // Stops the current turn only. interrupt() aborts the in-flight model call
  // and any foreground tools, but leaves background tasks running.
  // The turn ends for the session straight away so Stop feels instant; the
  // CLI's remaining output for it is drained (dropped) until its result, and
  // the next turn waits for that via settled().
  private interruptTurn(sink: TurnSink): void {
    if (this.sink !== sink) return;
    sink.interrupted = true;
    this.stream.interrupt().catch(() => {});
    if (!this.closed) {
      let done!: () => void;
      const drain = new Promise<void>((resolve) => (done = resolve));
      this.draining = { promise: drain, resolve: done };
      setTimeout(() => {
        if (this.draining?.promise === drain) {
          console.warn("[agent] interrupt did not end the turn — killing the CLI");
          this.close();
          this.finishDrain();
        }
      }, INTERRUPT_FALLBACK_MS);
    }
    this.endTurn(sink);
  }

  private finishDrain(): void {
    const drain = this.draining;
    this.draining = null;
    drain?.resolve();
  }

  // Resolves once a stopped turn's leftover output has been drained (or the
  // CLI was killed for not stopping), so the process is safe to reuse.
  settled(): Promise<void> {
    return this.draining?.promise ?? Promise.resolve();
  }

  private handleStreamEvent(emit: TurnSink["emit"], event: any): void {
    switch (event?.type) {
      case "message_start":
        this.partialMessageId = event.message?.id ?? cryptoRandomId();
        break;
      case "content_block_start": {
        this.clearPartial();
        const type = event.content_block?.type;
        if (type === "text" || type === "thinking") {
          this.partial = {
            id: `${this.partialMessageId}:${event.index}`,
            blockType: type,
            text: "",
            lastEmit: 0,
          };
        }
        break;
      }
      case "content_block_delta": {
        const p = this.partial;
        if (!p) break;
        const delta = event.delta;
        if (delta?.type === "text_delta") p.text += delta.text ?? "";
        else if (delta?.type === "thinking_delta") p.text += delta.thinking ?? "";
        else break;
        if (p.timer) break;
        const send = () => {
          p.timer = undefined;
          p.lastEmit = Date.now();
          emit({ type: "assistant_partial", id: p.id, blockType: p.blockType, text: p.text });
        };
        const wait = p.lastEmit + PARTIAL_THROTTLE_MS - Date.now();
        if (wait <= 0) send();
        else p.timer = setTimeout(send, wait);
        break;
      }
      case "content_block_stop":
        this.clearPartial();
        break;
    }
  }

  private clearPartial(): void {
    clearTimeout(this.partial?.timer);
    this.partial = null;
  }

  private endTurn(sink: TurnSink): void {
    if (this.sink !== sink) return;
    this.sink = null;
    this.clearPartial();
    // A turn can't end while its own foreground tool calls are still running,
    // so anything still marked as foreground-running settled without a
    // notification reaching us.
    let changed = false;
    for (const t of this.tasks.values()) {
      if (t.status === "running" && !t.background) {
        t.status = sink.interrupted ? "stopped" : "completed";
        t.endedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.publishTasks();
    sink.emit({ type: "turn_end" });
    sink.resolve();
    this.scheduleWindDown();
  }

  // Closes the input (letting the CLI exit) once nothing is left for it to do.
  private scheduleWindDown(): void {
    clearTimeout(this.idleTimer);
    if (this.closed || this.sink || this.unsolicitedPending || this.draining) return;
    if (this.hasRunningTasks()) return;
    this.idleTimer = setTimeout(() => this.windDownNow(), IDLE_WIND_DOWN_MS);
    this.markIdle();
  }

  private async consume(): Promise<void> {
    let failure: unknown;
    try {
      for await (const message of this.stream as AsyncIterable<any>) {
        this.route(message);
      }
    } catch (err) {
      failure = err;
    } finally {
      this.closed = true;
      idleProcesses.delete(this);
      clearTimeout(this.idleTimer);
      this.finishDrain();
      const sink = this.sink;
      if (failure && !this.isAbortLike(failure, sink)) {
        const message = failure instanceof Error ? failure.message : String(failure);
        if (sink) {
          console.error("[agent] Claude turn error:", failure);
          sink.emit({ type: "error", message });
        } else {
          console.warn("[agent] Claude process exited with an error between turns:", message);
        }
      }
      // A CLI-initiated turn still waiting to be adopted keeps its buffered
      // output; openSink/flushBuffered end it once replayed.
      if (sink) this.endTurn(sink);
      // Anything still running died with the process.
      let changed = false;
      for (const t of this.tasks.values()) {
        if (t.status === "running") {
          t.status = "stopped";
          t.endedAt = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) this.publishTasks();
      this.hooks.onClosed();
    }
  }

  // AbortErrors are intentional interruptions (user clicked stop, a forced
  // close, or a deliberate input close). Don't surface them as chat errors.
  // The SDK reports a user-initiated stop as a plain Error with the message
  // "Claude Code process aborted by user" (not an AbortError), and a CLI whose
  // input we closed after an interrupted turn can exit non-zero.
  private isAbortLike(err: unknown, sink: TurnSink | null): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return (
      this.abort.signal.aborted ||
      sink?.interrupted === true ||
      (!sink && this.input.isEnded) ||
      /aborted by user/i.test(message) ||
      (err instanceof Error && err.name === "AbortError") ||
      (typeof DOMException !== "undefined" &&
        err instanceof DOMException &&
        err.name === "AbortError")
    );
  }

  private route(message: any): void {
    if (message.type === "system" && this.handleTaskMessage(message)) return;
    if (message.type === "user") this.noteOutputPaths(message.message?.content);
    // Live deltas only matter to an open turn; the finished blocks follow as
    // assistant messages, so nothing is lost by dropping them otherwise.
    if (message.type === "stream_event" && (!this.sink || this.draining || message.parent_tool_use_id)) {
      return;
    }

    // A background subagent's own transcript streams through here too. It
    // belongs to that task, not to whichever turn happens to be open (or to a
    // turn of its own); the task row in the Agents panel tracks its progress.
    if (message.parent_tool_use_id && (!this.sink || this.isBackgroundToolUse(message.parent_tool_use_id))) {
      return;
    }

    // Tail of a turn the user already stopped: drop it up to its result.
    if (this.draining) {
      if (message.type === "system" && message.subtype === "init") {
        this.sessionId = message.session_id ?? this.sessionId;
      }
      if (message.type === "result") {
        this.sessionId = message.session_id ?? this.sessionId;
        this.finishDrain();
        this.scheduleWindDown();
      }
      return;
    }

    if (this.sink) {
      this.dispatch(this.sink, message);
      return;
    }

    // No turn is open, so the CLI started one by itself — normally a background
    // task settled and it woke the model. Buffer the output until the session
    // adopts it as a turn of its own.
    if (this.unsolicitedPending) {
      this.buffered.push(message);
      return;
    }
    if (message.type === "system" && message.subtype === "init") {
      this.bufferedInit = message;
      return;
    }
    if (message.type === "assistant") {
      clearTimeout(this.idleTimer);
      this.unsolicitedPending = true;
      if (this.bufferedInit) this.buffered.push(this.bufferedInit);
      this.bufferedInit = null;
      this.buffered.push(message);
      const steered = this.unfoldedSteers.size > 0;
      this.unfoldedSteers.clear();
      this.hooks.onUnsolicitedTurn(this.notes.splice(0), steered);
      return;
    }
    // A CLI turn with no output (e.g. acknowledging a stopped task).
    if (message.type === "result") {
      this.bufferedInit = null;
      this.scheduleWindDown();
    }
  }

  private dispatch(sink: TurnSink, message: any): void {
    const emit = sink.emit;
    switch (message.type) {
      case "system": {
        if (message.subtype === "init") {
          this.sessionId = message.session_id ?? this.sessionId;
          emit({
            type: "system_init",
            sessionId: this.sessionId ?? "",
            tools: message.tools ?? [],
            mcpServers: message.mcp_servers ?? [],
            cwd: message.cwd,
            model: message.model,
            permissionMode: message.permissionMode,
            slashCommands: message.slash_commands ?? [],
          });
          // Remember this snapshot so the Tools & MCP panel can preview the
          // available tools before a chat has started.
          void updateToolsCache(message.tools ?? [], message.mcp_servers ?? []);
        } else if (message.subtype === "api_retry") {
          // The CLI hit a retryable API error and is backing off. Surface it
          // as a non-fatal status instead of leaving the chat looking hung.
          const secs = Math.max(1, Math.ceil((message.retry_delay_ms ?? 0) / 1000));
          const limited = message.error_status === 429 || message.error === "rate_limit";
          const cause = limited
            ? "Rate limited"
            : message.error === "overloaded"
              ? "API overloaded"
              : message.error_status
                ? `API error ${message.error_status}`
                : "Connection problem";
          const attempt =
            message.attempt && message.max_retries
              ? ` (attempt ${message.attempt}/${message.max_retries})`
              : "";
          this.noticeActive = true;
          emit({
            type: "chat_notice",
            kind: limited ? "rate_limit" : "retry",
            message: `${cause}, retrying in ${secs}s${attempt}`,
          });
        }
        break;
      }

      case "rate_limit_event": {
        const info = message.rate_limit_info;
        if (!info) break;
        if (info.status === "rejected") {
          const resets = info.resetsAt
            ? ` Resets ${new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
            : "";
          this.noticeActive = true;
          emit({
            type: "chat_notice",
            kind: "rate_limit",
            message: `Rate limited${info.rateLimitType ? ` (${String(info.rateLimitType).replace(/_/g, " ")})` : ""}.${resets}`,
          });
        } else if (info.status === "allowed_warning") {
          this.warningShown = true;
          emit({
            type: "chat_notice",
            kind: "rate_limit",
            message: `Approaching usage limit${info.rateLimitType ? ` (${String(info.rateLimitType).replace(/_/g, " ")})` : ""}`,
          });
        } else if (this.noticeActive || this.warningShown) {
          this.noticeActive = false;
          this.warningShown = false;
          emit({ type: "chat_notice", kind: "rate_limit", message: null });
        }
        break;
      }

      case "stream_event":
        this.handleStreamEvent(emit, message.event);
        break;
      case "assistant": {
        this.clearPartial();
        if (this.noticeActive) {
          this.noticeActive = false;
          emit({ type: "chat_notice", kind: "retry", message: null });
        }
        const content = normalizeContent(message.message?.content ?? []);
        // Store assistant messages so currentTodos can scan for TodoWrite calls
        this.assistantMessages.push({ type: "assistant", message: message.message, content });
        this.registerAgentSubagents(message.message?.content ?? []);
        emit({
          type: "assistant",
          uuid: message.uuid ?? cryptoRandomId(),
          sessionId: message.session_id ?? this.sessionId ?? "",
          content,
        });
        // Emit an intermediate context_usage update so the ring moves during
        // long multi-step turns instead of only updating at the final result.
        // Each assistant message carries per-iteration usage from BetaMessage.
        const iterUsage = message.message?.usage as
          | {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            }
          | undefined;
        if (iterUsage) {
          // Determine context window size based on model family and context1m flag.
          // Models can have date suffixes (e.g., claude-sonnet-4-5-20250929)
          let contextWindowSize = 200_000; // default for haiku
          const modelLower = this.model.toLowerCase();
          if (modelLower.includes("opus")) {
            contextWindowSize = 1_000_000;
          } else if (modelLower.includes("sonnet")) {
            contextWindowSize = this.args.context1m ? 1_000_000 : 200_000;
          }
          const inputTokens = iterUsage.input_tokens ?? 0;
          const outputTokens = iterUsage.output_tokens ?? 0;
          const cacheReadTokens = iterUsage.cache_read_input_tokens ?? 0;
          const cacheWriteTokens = iterUsage.cache_creation_input_tokens ?? 0;
          // Exclude outputTokens: they are generated tokens, not context window
          // consumption. The context window limit is an input constraint only.
          const usedTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
          const pct = Math.min(100, (usedTokens / contextWindowSize) * 100);
          emit({
            type: "context_usage",
            usedTokens,
            contextWindowSize,
            pct,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
          });
        }
        break;
      }

      case "user": {
        const content = normalizeContent(message.message?.content ?? []);
        if (content.some((c) => c.type === "tool_result")) {
          emit({
            type: "user_tool_results",
            uuid: message.uuid ?? cryptoRandomId(),
            sessionId: message.session_id ?? this.sessionId ?? "",
            content,
          });
        }
        this.settleAgentSubagents(content);
        break;
      }

      case "result": {
        this.sessionId = message.session_id ?? this.sessionId;
        for (const uuid of message.user_message_uuids ?? []) this.unfoldedSteers.delete(uuid);
        if (this.noticeActive) {
          this.noticeActive = false;
          emit({ type: "chat_notice", kind: "retry", message: null });
        }
        emit({
          type: "result",
          sessionId: this.sessionId ?? "",
          subtype: message.subtype ?? "success",
          durationMs: message.duration_ms ?? 0,
          totalCostUsd: message.total_cost_usd,
          numTurns: message.num_turns ?? 0,
          result: message.result,
        });
        // NOTE: We intentionally do NOT emit context_usage from the result event.
        // The SDK's result.usage is the *cumulative sum* of tokens across all
        // agentic sub-turns (every API call Claude made during this user turn).
        // That sum can be many times larger than the actual context window in use
        // at any single moment — emitting it here caused a jarring jump to
        // hundreds of thousands of tokens at the end of multi-step tasks.
        // The per-assistant-message context_usage emits above are accurate
        // per-API-call measurements and are sufficient for tracking context pressure.
        this.completeSyntheticAgents();
        this.endTurn(sink);
        break;
      }

      default:
        break;
    }
  }

  // Folds the CLI's task lifecycle messages into the task map. Returns false
  // for system messages that aren't about tasks.
  private handleTaskMessage(m: any): boolean {
    const now = new Date().toISOString();
    switch (m.subtype) {
      case "task_started": {
        // Ambient tasks are housekeeping (watchers etc.), not user-visible work.
        if (m.ambient || m.skip_transcript) return true;
        // A real lifecycle message supersedes any entry we synthesized from the
        // Agent tool_use block (that entry is keyed by its tool_use_id).
        if (m.tool_use_id && this.syntheticAgentTaskIds.delete(m.tool_use_id)) {
          this.tasks.delete(m.tool_use_id);
        }
        const existing = this.tasks.get(m.task_id);
        this.tasks.set(m.task_id, {
          ...existing,
          id: m.task_id,
          toolUseId: m.tool_use_id,
          taskType: m.task_type ?? existing?.taskType ?? "task",
          description: clip(m.description ?? existing?.description),
          subagentType: m.subagent_type,
          status: "running",
          background: m.is_backgrounded ?? existing?.background ?? true,
          startedAt: existing?.startedAt ?? now,
        });
        const path = m.tool_use_id ? this.outputPathsByToolUse.get(m.tool_use_id) : undefined;
        if (path) this.setOutputFile(m.task_id, path);
        break;
      }
      case "task_progress": {
        const t = this.tasks.get(m.task_id);
        if (!t) return true;
        if (m.last_tool_name) t.lastToolName = m.last_tool_name;
        if (m.summary) t.summary = clip(m.summary, 200);
        if (m.usage) {
          t.totalTokens = m.usage.total_tokens;
          t.toolUses = m.usage.tool_uses;
        }
        break;
      }
      case "task_updated": {
        const t = this.tasks.get(m.task_id);
        if (!t) return true;
        const p = m.patch ?? {};
        if (p.description) t.description = clip(p.description);
        if (typeof p.is_backgrounded === "boolean") t.background = p.is_backgrounded;
        if (p.status) {
          t.status =
            p.status === "completed"
              ? "completed"
              : p.status === "failed"
                ? "failed"
                : p.status === "killed"
                  ? "stopped"
                  : "running";
          if (t.status !== "running") t.endedAt = p.end_time ? new Date(p.end_time).toISOString() : now;
        }
        if (p.error) t.summary = clip(p.error, 200);
        break;
      }
      case "task_notification": {
        const t = this.tasks.get(m.task_id);
        if (!t) return true;
        t.status = m.status === "completed" ? "completed" : m.status === "failed" ? "failed" : "stopped";
        t.endedAt ??= now;
        if (m.summary) t.summary = clip(m.summary, 200);
        if (m.usage) {
          t.totalTokens = m.usage.total_tokens;
          t.toolUses = m.usage.tool_uses;
        }
        if (m.output_file) this.setOutputFile(m.task_id, m.output_file);
        // Foreground tasks here belong to a background subagent; its own
        // notification covers them.
        if (!this.sink && t.background) this.notes.push(describeSettledTask(t));
        break;
      }
      case "background_tasks_changed": {
        // Level signal: reconcile against the authoritative live set so a
        // missed edge event can't leave a row spinning forever.
        const live = new Set<string>();
        for (const entry of m.tasks ?? []) {
          if (entry.ambient) continue;
          live.add(entry.task_id);
          if (!this.tasks.has(entry.task_id)) {
            this.tasks.set(entry.task_id, {
              id: entry.task_id,
              taskType: entry.task_type ?? "task",
              description: clip(entry.description),
              status: "running",
              background: true,
              startedAt: now,
            });
          }
        }
        const missing = [...this.tasks.values()]
          .filter((t) => t.status === "running" && t.background && !live.has(t.id))
          .map((t) => t.id);
        if (missing.length > 0) {
          // The level usually lands just before the task's own notification,
          // which carries the real outcome (completed / stopped / failed).
          // Only fall back to "completed" if that never arrives.
          setTimeout(() => {
            let changed = false;
            for (const id of missing) {
              const t = this.tasks.get(id);
              if (t?.status === "running") {
                t.status = "completed";
                t.endedAt = new Date().toISOString();
                changed = true;
              }
            }
            if (changed) {
              this.publishTasks();
              if (!this.sink) this.scheduleWindDown();
            }
          }, LEVEL_RECONCILE_MS);
        }
        break;
      }
      default:
        return false;
    }
    this.publishTasks();
    if (!this.sink) this.scheduleWindDown();
    return true;
  }

  private noteOutputPaths(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== "tool_result" || !block.tool_use_id) continue;
      const text =
        typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c: any) => c?.text ?? "").join("\n")
            : "";
      const match = OUTPUT_PATH_RE.exec(text);
      if (!match) continue;
      this.outputPathsByToolUse.set(block.tool_use_id, match[1]);
      for (const t of this.tasks.values()) {
        if (t.toolUseId === block.tool_use_id) {
          this.setOutputFile(t.id, match[1]);
          this.publishTasks();
        }
      }
    }
  }

  private isBackgroundToolUse(toolUseId: string): boolean {
    for (const t of this.tasks.values()) {
      if (t.toolUseId === toolUseId) return t.background;
    }
    return false;
  }

  private setOutputFile(taskId: string, path: string): void {
    const t = this.tasks.get(taskId);
    // A subagent's output file is its raw JSONL transcript; its summary is
    // the readable result.
    if (t?.taskType === "local_agent") return;
    this.outputFiles.set(taskId, path);
    if (t) t.hasOutput = true;
  }

  private publishTasks(): void {
    const tasks = this.taskList().map((t) => ({ ...t }));
    // Edge and level messages often describe the same change.
    const snapshot = JSON.stringify(tasks);
    if (snapshot === this.lastPublished) return;
    this.lastPublished = snapshot;
    this.hooks.onTasksChanged(tasks);
  }

  // Agent/Task subagents don't reliably get CLI task_* lifecycle messages, so
  // we track them from the tool_use block and settle them from the result. A
  // real task_started with the same tool_use_id supersedes these (see above).
  private registerAgentSubagents(content: unknown): void {
    if (!Array.isArray(content)) return;
    let changed = false;
    for (const block of content) {
      if (block?.type !== "tool_use" || !block.id) continue;
      if (block.name !== "Agent" && block.name !== "Task") continue;
      if (this.tasks.has(block.id)) continue;
      const input = (block.input ?? {}) as {
        description?: string;
        prompt?: string;
        subagent_type?: string;
      };
      this.tasks.set(block.id, {
        id: block.id,
        toolUseId: block.id,
        taskType: "local_agent",
        description: clip(input.description ?? input.prompt ?? "Agent task"),
        subagentType: input.subagent_type,
        status: "running",
        background: true,
        startedAt: new Date().toISOString(),
      });
      this.syntheticAgentTaskIds.add(block.id);
      changed = true;
    }
    if (changed) this.publishTasks();
  }

  // A real (non-placeholder) tool_result settles a synthesized agent. A
  // backgrounded subagent returns a "launched in the background" placeholder
  // immediately — that doesn't count; those are swept at turn end instead.
  private settleAgentSubagents(content: unknown): void {
    if (!Array.isArray(content)) return;
    let changed = false;
    for (const block of content) {
      if (block?.type !== "tool_result" || !block.tool_use_id) continue;
      if (!this.syntheticAgentTaskIds.has(block.tool_use_id)) continue;
      if (isBackgroundLaunchPlaceholder(block.content)) continue;
      const t = this.tasks.get(block.tool_use_id);
      if (!t || t.status !== "running") continue;
      t.status = block.is_error ? "failed" : "completed";
      t.endedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) this.publishTasks();
  }

  // Sweep still-running synthesized agents when a turn settles, so a
  // backgrounded subagent we never saw a real result for can't spin forever.
  private completeSyntheticAgents(): void {
    let changed = false;
    for (const id of this.syntheticAgentTaskIds) {
      const t = this.tasks.get(id);
      if (t && t.status === "running") {
        t.status = "completed";
        t.endedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.publishTasks();
  }

  // Latest TodoWrite list across every turn (same logic as the useTodos hook).
  private currentTodos(): any[] {
    for (let i = this.assistantMessages.length - 1; i >= 0; i--) {
      const msg = this.assistantMessages[i];
      const content = msg.message?.content ?? msg.content ?? [];
      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j];
        if (block.type === "tool_use" &&
            (block.name === "TodoWrite" || block.name === "mcp__buildover-custom-tools__TodoWrite")) {
          const input = block.input as { todos?: any[] };
          if (Array.isArray(input?.todos)) {
            return input.todos;
          }
        }
      }
    }
    return [];
  }
}

function normalizeContent(blocks: any[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        out.push({ type: "text", text: String(block.text ?? "") });
        break;
      case "thinking":
        out.push({
          type: "thinking",
          thinking: String(block.thinking ?? ""),
        });
        break;
      case "tool_use":
        out.push({
          type: "tool_use",
          id: String(block.id ?? cryptoRandomId()),
          name: String(block.name ?? "unknown"),
          input: block.input ?? {},
        });
        break;
      case "tool_result": {
        let content = "";
        if (typeof block.content === "string") content = block.content;
        else if (Array.isArray(block.content)) {
          content = block.content
            .map((c: any) =>
              typeof c === "string" ? c : c?.text ?? JSON.stringify(c),
            )
            .join("\n");
        } else if (block.content != null) {
          content = JSON.stringify(block.content);
        }
        out.push({
          type: "tool_result",
          tool_use_id: String(block.tool_use_id ?? ""),
          content,
          is_error: Boolean(block.is_error),
        });
        break;
      }
    }
  }
  return out;
}

// Renders attachments into a content block array so the SDK can forward them
// to Claude correctly. Text files become a fenced text block; images become a
// proper base64 image block so Claude can actually see them.
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };

function toImageMediaType(mime: string): ImageMediaType {
  switch (mime) {
    case "image/jpeg":
    case "image/png":
    case "image/gif":
    case "image/webp":
      return mime;
    default:
      // Anthropic only accepts these four; png is the safest fallback.
      return "image/png";
  }
}

function renderPromptWithAttachments(
  text: string,
  attachments: Attachment[] | undefined,
): PromptContentBlock[] | string {
  if (!attachments || attachments.length === 0) return text;

  const blocks: PromptContentBlock[] = [{ type: "text", text }];

  for (const a of attachments) {
    if (a.contents != null) {
      // Text file — append as a fenced code block in a text block.
      blocks.push({
        type: "text",
        text: `---\nAttached file: ${a.name} (${a.mime})\n\`\`\`\n${a.contents}\n\`\`\``,
      });
    } else if (a.dataUrl) {
      // Image — strip the data URL prefix and send as a real image block.
      const base64Data = a.dataUrl.replace(/^data:[^;]+;base64,/, "");
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: toImageMediaType(a.mime),
          data: base64Data,
        },
      });
      // Follow the image block with a text label so Claude knows the filename.
      blocks.push({
        type: "text",
        text: `(Image above: ${a.name}, ${formatBytes(a.size)})`,
      });
    }
  }

  return blocks;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
