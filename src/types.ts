// Shared message types between server and client.

export type Model = string;

export type ModelProvider = "claude" | "cursor" | "openai";

/** Claude reasoning effort levels, lowest to highest. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface ModelOption {
  id: string;
  label: string;
  provider?: ModelProvider;
  contextWindow?: number;
  /** Effort levels the model accepts (from the Models API capabilities). */
  effortLevels?: EffortLevel[];
}

/**
 * Effort levels a Claude model supports. Prefers the live list from the
 * Models API; falls back to a family heuristic for the static MODELS list.
 */
export function effortLevelsFor(model: string, live?: EffortLevel[]): EffortLevel[] {
  if (live) return live;
  if (!model.startsWith("claude-")) return [];
  if (model.includes("haiku")) return [];
  if (/-4-6\b/.test(model)) return ["low", "medium", "high", "max"];
  if (/-4-5\b/.test(model)) return model.includes("opus") ? ["low", "medium", "high"] : [];
  if (/-(3|4-[01])\b|-3-/.test(model)) return [];
  return [...EFFORT_LEVELS];
}

/** The level the API uses when `effort` is omitted. */
export function defaultEffortFor(model: string): EffortLevel {
  return model.startsWith("claude-opus-5-5") ? "medium" : "high";
}

/** Fallback model list used before the /api/models response arrives. */
export const MODELS: ModelOption[] = [
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", provider: "claude" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "claude" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "claude" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "claude" },
  { id: "claude-opus-5", label: "Claude Opus 5", provider: "claude" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "claude" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "claude" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", provider: "claude" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "claude" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "claude" },
];

export const DEFAULT_MODEL: Model = "claude-opus-5";

/** Cursor model ids are stored as `cursor:<nativeId>`. */
export const CURSOR_MODEL_PREFIX = "cursor:";

export function getModelProvider(model: string): ModelProvider {
  if (model.startsWith(CURSOR_MODEL_PREFIX)) return "cursor";
  if (model.startsWith("claude-")) return "claude";
  return "openai";
}

/**
 * Subagents always run on Haiku 5.5 — fast and cheap (a tenth of Haiku 4.5's
 * price), suited to the focused, well-scoped work a coordinator hands off. Enforced by chat kind in runTurn,
 * so it holds regardless of who spawned the subagent or how a turn is resumed.
 */
export const SUBAGENT_MODEL: Model = "claude-haiku-5-5";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

// Where a chat message came from. Absent ⇒ "user" (a genuine user-typed
// message). "subagent" = a report delivered from a child subagent; "system" =
// an automated notice (ticket approvals, plan notes, coordinator→subagent
// relays). Used by the UI to render delivered messages distinctly from the
// user's own bubble.
export type MessageOrigin = "user" | "subagent" | "system";

// ---- Attachments ----

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  contents?: string;
  dataUrl?: string;
}

// ---- Content blocks (assistant / tool messages) ----

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export interface McpServerInfo {
  name: string;
  status: string;
}

// ---- User-installed MCP servers (persisted to mcp-servers.json) ----

export type McpServerType = "stdio" | "sse" | "http";

export interface InstalledMcpServer {
  /** Unique stable ID — use Smithery qualifiedName or any slug */
  id: string;
  name: string;
  description?: string;
  type: McpServerType;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse / http
  url?: string;
  headers?: Record<string, string>;
}

// ---- Agent tasks (subagents / shell processes) ----

// A unit of work the Claude CLI tracks alongside the main turn: a subagent
// (Agent tool), a Bash command (foreground or run_in_background), a monitor,
// etc. Background tasks outlive the turn that started them — the server keeps
// the CLI process alive until they settle — so they are tracked per chat and
// pushed live via `background_tasks` events rather than derived from the
// transcript.
export interface AgentTask {
  id: string;
  /** The tool_use block that started the task, when known. */
  toolUseId?: string;
  /** Raw CLI task type, e.g. "local_bash", "local_agent". */
  taskType: string;
  description: string;
  /** Agent type (e.g. "Explore") for subagent tasks. */
  subagentType?: string;
  status: "running" | "completed" | "failed" | "stopped";
  /** False while the spawning tool call is blocking the turn on it. */
  background: boolean;
  startedAt: string;
  endedAt?: string;
  lastToolName?: string;
  /** One-line progress / completion summary from the CLI. */
  summary?: string;
  totalTokens?: number;
  toolUses?: number;
  /** True when the server can serve this task's output file. */
  hasOutput?: boolean;
}

// ---- Chats / repos ----

export type ChatStatus =
  | "awaiting_input"
  | "running"
  | "queued"
  | "agent_done"
  | "idle"
  | "finished"
  | "error";

// What kind of chat this is. "coordinator" is the always-present, undeletable
// chat pinned at the top of each repo's sidebar that delegates work to
// subagents. "subagent" chats are spawned by another chat (their parent) via
// the spawn_subagent tool. Absent/"user" means a normal user-created chat.
export type ChatKind = "user" | "coordinator" | "subagent";

export interface RepoInfo {
  id: string;
  path: string;
  name: string;
}

export interface RecentRepoInfo {
  path: string;
  name: string;
  lastOpenedAt: string;
}

// ---- Project templates ----

/** A local codebase registered as a starting point for new projects. */
export interface TemplateInfo {
  id: string;
  name: string;
  path: string;
  description?: string;
  createdAt: string;
  /** False when the folder has been moved or deleted since it was registered. */
  exists: boolean;
  /** Git repos are copied via `git ls-files`, honouring their .gitignore. */
  isGitRepo: boolean;
}

export interface GitHubAccountInfo {
  login: string;
  host: string;
  /** The account gh currently treats as active — used as the default choice. */
  active: boolean;
}

/** A repository on GitHub, as listed on the clone screen. */
export interface GitHubRepoInfo {
  nameWithOwner: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  isFork: boolean;
  pushedAt: string;
  sshUrl: string;
}

export type RepoVisibility = "private" | "public" | "internal";

export interface CreateProjectRequest {
  /** Omitted for an empty project — the folder is created with nothing in it. */
  templateId?: string;
  name: string;
  parentDir: string;
  initGit: boolean;
  commit: boolean;
  commitMessage?: string;
  github?: {
    account: string;
    owner: string;
    visibility: RepoVisibility;
    description?: string;
    push: boolean;
  };
}

/**
 * One stage of project creation. Steps after the file copy can fail without
 * failing the whole operation — the project still exists locally — so the modal
 * reports them individually.
 */
export interface CreateProjectStep {
  label: string;
  status: "ok" | "failed";
  detail?: string;
}

export interface CreateProjectResult {
  repo: RepoInfo;
  steps: CreateProjectStep[];
}

/** Global preferences persisted in ~/.buildover/prefs.json. */
export interface AppPrefs {
  /** Where the last project was created or cloned; prefilled next time. */
  lastProjectLocation?: string;
  /** Reasoning effort for Claude turns. Unset → the model's default. */
  claudeEffort?: EffortLevel;
  /** Token count at which Claude chats auto-compact. Unset → 200k. */
  autoCompactWindow?: number;
  /** Max turns running at once across all chats; extras queue FIFO. Unset → 4,
   *  0 → unlimited. */
  maxConcurrentTurns?: number;
  /** How many hours a chat with "Keep warm" on is pinged to keep its prompt
   *  cache alive after the last real activity. Unset / 0 → off. */
  keepWarmHours?: number;
}

/** Running spend for one chat, API-equivalent (list price, not billing). */
export interface ChatCost {
  /** Sum of every turn's cost: visible turns, silent compactions, keep-alives. */
  totalUsd: number;
  /** Cost of the last visible (non-silent) turn. */
  lastTurnUsd: number;
  /** Visible turns counted in totalUsd. */
  turns: number;
  /** Part of totalUsd spent on silent turns (compaction, keep-alive pings,
   *  handoff notes). */
  silentUsd?: number;
  /** ISO time of the last API round-trip (any turn, silent or not). The prompt
   *  cache is warm for ~1h after this. */
  lastApiAt?: string;
  /** Server bookkeeping: the SDK's cumulative `total_cost_usd` at the last
   *  result, used to turn that running total into per-turn deltas. */
  lastCumulativeUsd?: number;
}

/** Link written when a chat is continued in a fresh one (handoff). */
export interface ChatHandoffTo {
  chatId: string;
  title: string;
  notePath: string;
  createdAt: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  status: ChatStatus;
  userMarkedFinished: boolean;
  sessionId?: string;
  model: Model;
  createdAt: string;
  updatedAt: string;
  preview: string;
  /** User pinned this chat to the top of the sidebar. Absent === not starred. */
  starred?: boolean;
  /** Chat kind — absent means "user" (a normal user-created chat). */
  kind?: ChatKind;
  /** For subagent chats: the chat that spawned this one. */
  parentChatId?: string;
  /** For subagent chats: short description of the assigned task. */
  task?: string;
  /** First queued turn's schedule, mirrored from the full record so the queue
   *  drainer can reschedule wakeups/retries without reading every transcript.
   *  Absent when the chat has no queued turns. */
  queuedTurn?: { runAfter: string | null };
  /** Mirrors ChatRecord.queuePaused so the drainer can skip paused chats
   *  without a full read. Absent === not paused. */
  queuePaused?: boolean;
  /** Mirrors ChatRecord.keepWarm so startup can re-arm keep-alive timers. */
  keepWarm?: boolean;
  /** Mirrors ChatRecord.handoffTo?.chatId. */
  continuedInChatId?: string;
}

// Persisted chat events. These are a superset of the live AgentEvent stream
// plus user-side records (user_message, permission_response) so the chat file
// is a complete, replayable transcript.
export type ChatEvent =
  | {
      type: "user_message";
      id: string;
      text: string;
      attachments?: Attachment[];
      /** Source of this message. Absent === "user" (legacy / genuine user). */
      origin?: MessageOrigin;
      /** Display label for non-user origins (e.g. the subagent's title). */
      originLabel?: string;
      ts: string;
    }
  | {
      type: "system_init";
      sessionId: string;
      tools: string[];
      mcpServers: McpServerInfo[];
      cwd?: string;
      model?: string;
      permissionMode?: string;
      slashCommands?: string[];
      ts: string;
    }
  | {
      type: "assistant";
      uuid: string;
      sessionId: string;
      content: ContentBlock[];
      ts: string;
    }
  | {
      type: "user_tool_results";
      uuid: string;
      sessionId: string;
      content: ContentBlock[];
      ts: string;
    }
  | {
      type: "result";
      sessionId: string;
      subtype: string;
      durationMs: number;
      totalCostUsd?: number;
      numTurns: number;
      result?: string;
      ts: string;
    }
  | {
      type: "permission_request";
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      suggestions?: unknown[];
      ts: string;
    }
  | {
      type: "permission_response";
      requestId: string;
      result:
        | {
            behavior: "allow";
            updatedInput?: Record<string, unknown>;
            updatedPermissions?: unknown[];
          }
        | { behavior: "deny"; message: string; interrupt?: boolean };
      ts: string;
    }
  | { type: "error"; message: string; ts: string }
  | { type: "turn_start"; ts: string }
  | { type: "turn_end"; ts: string }
  | ({ type: "context_usage"; ts: string } & ContextUsage)
  | {
      // Persisted just before each non-silent turn_start.  Stores the id used
      // to name the file-content snapshot directory so the server can locate
      // and restore snapshots when the user clicks "Revert".
      type: "revert_checkpoint";
      checkpointId: string;
      ts: string;
    };

// A diverging branch at a fork point. Stores all events from the branching
// user_message onwards (inclusive). Absent on linear (non-forked) chats.
export interface ChatBranch {
  id: string;               // e.g. "br_lx4k2abc"
  parentMessageId: string;  // the user_message.id this branch diverged at
  events: ChatEvent[];      // events from parentMessageId onwards (inclusive)
  createdAt: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  titleAuto: boolean;
  status: ChatStatus;
  userMarkedFinished: boolean;
  sessionId?: string;
  /** Per-provider session ids so switching Claude ↔ Cursor mid-chat does not
   *  overwrite the other provider's resume handle. `sessionId` remains the
   *  most recently active session (for UI / legacy callers). */
  providerSessions?: {
    claude?: string;
    cursor?: string;
    openai?: string;
  };
  /** One-shot marker set by fork / branch-switch / revert. When present, the
   *  next agent turn resumes `sessionId` only up to and including this SDK
   *  message UUID (forking the SDK session at that point) so the model never
   *  sees messages that were edited away or reverted. Cleared when the next
   *  turn's system_init establishes the forked session. */
  resumeSessionAt?: string;
  model: Model;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  events: ChatEvent[];
  /** Durable delayed turns: usage-limit retries and agent-scheduled wakeups.
   *  Usage retry user messages are already persisted in events. */
  queuedTurns?: QueuedChatTurn[];
  /** When true, queued turns stay visible but will not auto-drain. */
  queuePaused?: boolean;
  /** Most recent context window usage — updated on every turn, used to
   *  re-populate the context ring when replaying/loading a chat. */
  lastContextUsage?: ContextUsage;
  /** Diverging conversation branches created via message editing. Absent on
   *  linear chats. record.events is always the currently active branch. */
  branches?: ChatBranch[];
  /** User pinned this chat to the top of the sidebar. Absent === not starred. */
  starred?: boolean;
  /** Chat kind — absent means "user" (a normal user-created chat). */
  kind?: ChatKind;
  /** For subagent chats: the chat that spawned this one. */
  parentChatId?: string;
  /** For subagent chats: short description of the assigned task. */
  task?: string;
  /** For code-editing subagent chats: the isolated git worktree its SDK
   *  session runs in, so its edits don't touch the live main working tree until
   *  merged back. Absent for research/read-only subagents and normal chats. */
  worktreePath?: string;
  /** Branch checked out in `worktreePath` (e.g. `subagent/<chatId>`). */
  worktreeBranch?: string;
  /** When true, enables the 1M token context window beta for Claude models. */
  context1m?: boolean;
  /** Running API-equivalent cost, including silent turns (see ChatCost). */
  cost?: ChatCost;
  /** Opt-in: ping the chat every 55 min after its last activity so the
   *  prompt cache never goes cold (window length = prefs.keepWarmHours). */
  keepWarm?: boolean;
  /** Set on the old chat once it has been continued in a fresh one. */
  handoffTo?: ChatHandoffTo;
  /** Set on the fresh chat: where it came from, and the composer text to
   *  prefill (the note is never auto-sent). */
  handoffFrom?: { chatId: string; notePath: string; prefill?: string };
}

export interface QueuedChatTurn {
  id: string;
  text: string;
  model: Model;
  permissionMode: PermissionMode;
  /** Why this turn is queued. "user" is a message the user sent while the
   *  agent was mid-turn; it runs as soon as the chat is free and its
   *  user_message is only persisted when it runs. Older persisted entries
   *  predate this field and are usage-limit retries. */
  kind?: "usage_limit" | "scheduled_wakeup" | "user";
  attachments?: Attachment[];
  origin?: MessageOrigin;
  originLabel?: string;
  createdAt: string;
  runAfter: string | null;
  reason: string;
}

// ---- Plans / tickets (coordinator workflow) ----

// Lifecycle of a plan ticket:
//   draft        — proposed by the coordinator, waiting for user approval
//   approved     — user (or coordinator on the user's behalf) approved it
//   in_progress  — a subagent is actively working on it
//   agent_done   — the coordinator judged the work complete; awaiting the
//                  user's final sign-off
//   done         — user confirmed the result
//   rejected     — user rejected the ticket
export type PlanTicketStatus =
  | "draft"
  | "approved"
  | "in_progress"
  | "agent_done"
  | "done"
  | "rejected";

export interface PlanTicket {
  id: string;
  title: string;
  /**
   * Markdown body — the technical specification: concrete files, symbols,
   * data structures and acceptance criteria a fresh agent needs to pick the
   * work up cold.
   */
  description: string;
  /**
   * Markdown body — the human-readable version of the plan: high-level
   * business logic in plain language, no file paths or variable names.
   * Shown to the user by default; the technical spec is behind a toggle.
   */
  humanDescription?: string;
  status: PlanTicketStatus;
  /** Position in the priority list (0 = highest priority). */
  order: number;
  /** Chat id of the subagent currently (or most recently) working this ticket. */
  subagentChatId?: string;
  /** Chat id of the agent that drafted this ticket (coordinator or research subagent). */
  createdByChatId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlansFile {
  tickets: PlanTicket[];
  updatedAt: string;
}

// ---- Wire protocol ----

// All client/server WS messages carry a `chatId` so a single connection can
// multiplex many chats. REST is used for repo/chat metadata; WS only carries
// streaming agent events plus permission round-trips.

export type ClientMessage =
  | {
      type: "subscribe";
      chatId: string;
      repoPath: string;
      // When false, the server skips the chat_replay envelope and only sends
      // live events going forward. Used by the sidebar to track status pills
      // for non-active chats without paying the replay cost.
      withReplay?: boolean;
    }
  | {
      type: "unsubscribe";
      chatId: string;
    }
  | {
      type: "user_message";
      chatId: string;
      repoPath: string;
      text: string;
      model: Model;
      permissionMode?: PermissionMode;
      attachments?: Attachment[];
      /** When true, this is a retry after a server-restart interruption.
       *  The server re-runs the turn without re-persisting the user message. */
      isRetry?: boolean;
    }
  | {
      type: "permission_response";
      chatId: string;
      requestId: string;
      result:
        | {
            behavior: "allow";
            updatedInput?: Record<string, unknown>;
            updatedPermissions?: unknown[];
          }
        | { behavior: "deny"; message: string; interrupt?: boolean };
      }
  | { type: "interrupt"; chatId: string }
  | {
      // Stops a single subagent / shell task without touching the main turn.
      type: "stop_background_task";
      chatId: string;
      taskId: string;
    }
  | {
      // Application-level heartbeat. The server replies with a { type: "pong" }
      // frame. Used by the client to detect a silently-dead socket (e.g. after
      // the laptop sleeps or wifi drops) and trigger a reconnect.
      type: "ping";
    }
  | {
      // Pauses or resumes the chat's queued-turn drain.
      type: "set_queue_paused";
      chatId: string;
      paused: boolean;
    }
  | {
      // Holds a message in the chat's server-side queue until the current turn
      // ends. The server drains it even when no client has the chat open.
      // `paused` also pauses the queue (long-press send).
      type: "queue_user_message";
      chatId: string;
      repoPath: string;
      text: string;
      model: Model;
      permissionMode: PermissionMode;
      attachments?: Attachment[];
      paused?: boolean;
    }
  | {
      // New order for the chat's queued user messages (ids of kind "user").
      type: "reorder_queued_turns";
      chatId: string;
      turnIds: string[];
    }
  | {
      // Moves a queued turn to the front, resumes the queue and interrupts the
      // in-flight turn so it runs next.
      type: "fast_track_queued_turn";
      chatId: string;
      turnId: string;
    }
  | {
      // Updates the permissionMode of an in-flight turn. The server applies
      // this dynamically so toggling bypass mid-turn takes effect on the
      // next (and any pending) permission decision.
      type: "set_permission_mode";
      chatId: string;
      permissionMode: PermissionMode;
    }
  | {
      // Sent by the client after the user responds to a RequestUserAttention
      // prompt. This is separate from the permission system so it cannot be
      // bypassed by Claude Code's dangerouslySkipPermissions flag — the tool
      // handler itself blocks until this ack arrives.
      type: "attention_ack";
      chatId: string;
      attentionId: string;
      // Optional feedback typed by the user before clicking Continue/Stop.
      feedback?: string;
      // True when the user clicks "Stop" — aborts the turn.
      interrupt?: boolean;
    }
  | {
      // Edit an existing user message, forking the conversation at that point.
      // The server saves events from userMessageId onwards as a branch, then
      // starts a fresh turn with the new text.
      type: "fork_message";
      chatId: string;
      repoPath: string;
      userMessageId: string;
      newText: string;
      attachments?: Attachment[];
      model: Model;
      permissionMode?: PermissionMode;
    }
  | {
      // Navigate between branches at a given fork point. The server swaps the
      // active trunk with the target branch so record.events is always current.
      type: "switch_branch";
      chatId: string;
      repoPath: string;
      parentMessageId: string;
      targetBranchId: string;
    }
  | {
      // Revert all file changes made from the given checkpoint onward and
      // truncate the chat history back to just before that checkpoint.
      type: "revert_to_checkpoint";
      chatId: string;
      repoPath: string;
      checkpointId: string;
    };

// ---- Semantic search ----

export interface SearchResult {
  chatId: string;
  chatTitle: string;
  chatUpdatedAt: string;
  messageText: string;
  eventIndex: number;
  /** "agent" = the agent's final message of a turn. */
  role: "user" | "agent";
  score: number;
  /** Message contains the query verbatim (case/whitespace-insensitive). */
  exactMatch: boolean;
  ts: string;
}

export interface SearchIndexStatus {
  isModelLoading: boolean;
  isIndexing: boolean;
  modelError: string | null;
  indexed: number;
  total: number;
}

export interface ContextUsage {
  usedTokens: number;
  contextWindowSize: number;
  pct: number; // 0–100
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type AgentEvent =
  | {
      type: "system_init";
      chatId: string;
      sessionId: string;
      tools: string[];
      mcpServers: McpServerInfo[];
      cwd?: string;
      model?: string;
      permissionMode?: string;
      slashCommands?: string[];
    }
  | {
      type: "assistant";
      chatId: string;
      uuid: string;
      sessionId: string;
      content: ContentBlock[];
    }
  | {
      type: "user_tool_results";
      chatId: string;
      uuid: string;
      sessionId: string;
      content: ContentBlock[];
    }
  | {
      type: "result";
      chatId: string;
      sessionId: string;
      subtype: string;
      durationMs: number;
      /** Cost of THIS turn (the server converts the SDK's cumulative
       *  `total_cost_usd` into a per-turn delta). */
      totalCostUsd?: number;
      numTurns: number;
      result?: string;
    }
  | {
      type: "permission_request";
      chatId: string;
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      suggestions?: unknown[];
    }
  | {
      // Broadcast when a permission request is resolved so live clients can
      // update the originating tool_use block's input (e.g. AskUserQuestion
      // answers) without waiting for a full chat_replay.
      type: "permission_response";
      chatId: string;
      requestId: string;
      result:
        | {
            behavior: "allow";
            updatedInput?: Record<string, unknown>;
            updatedPermissions?: unknown[];
          }
        | { behavior: "deny"; message: string; interrupt?: boolean };
      ts?: string;
    }
  | { type: "error"; chatId: string; message: string }
  | { type: "turn_start"; chatId: string }
  | { type: "turn_end"; chatId: string }
  | ({ type: "context_usage"; chatId: string } & ContextUsage)
  | {
      // Emitted when the tool handler for RequestUserAttention is blocking,
      // waiting for an attention_ack from the client. Unlike permission_request
      // this is NOT routed through the permission system, so it cannot be
      // auto-approved by Claude Code's dangerouslySkipPermissions flag.
      type: "pending_attention";
      chatId: string;
      attentionId: string;
      message: string;
      summary?: string;
    }
  | {
      type: "user_message_echo";
      chatId: string;
      id: string;
      text: string;
      attachments?: Attachment[];
      /** Source of this message. Absent === "user" (genuine user input). */
      origin?: MessageOrigin;
      /** Display label for non-user origins (e.g. the subagent's title). */
      originLabel?: string;
    }
  // Status / metadata pushes.
  | {
      type: "chat_status";
      chatId: string;
      status: ChatStatus;
      sessionId?: string;
      /** Included by durable status pushes so the open chat can update its
       *  delayed-turn UI without waiting for a reconnect/replay. */
      queuedTurns?: QueuedChatTurn[];
      queuePaused?: boolean;
      /** Present while the turn waits for a global concurrency slot
       *  (status "queued"). */
      slotQueue?: { position: number; running: number; max: number };
    }
  | {
      // Live-only status line above the composer: a rate-limit / retry notice
      // from the SDK stream. `message: null` clears it.
      type: "chat_notice";
      chatId: string;
      kind: "rate_limit" | "retry";
      message: string | null;
    }
  | {
      // Running cost changed (after every turn, including silent ones).
      type: "chat_cost";
      chatId: string;
      cost: ChatCost;
    }
  | {
      // The chat was continued in a fresh one (agent-triggered handoff, or
      // after POST /api/chats/:id/handoff). Tagged with the OLD chat's id.
      type: "chat_handoff";
      chatId: string;
      handoffTo: ChatHandoffTo;
    }
  | {
      type: "chat_title";
      chatId: string;
      title: string;
    }
  // Replay envelope: server pushes the entire history when a client subscribes
  // to a chat. Events are the raw persisted ChatEvents.
  | {
      type: "chat_replay";
      chatId: string;
      record: ChatRecord;
      pendingPermissions: { requestId: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown[] }[];
      pendingAttentions: { attentionId: string; message: string; summary?: string }[];
    }
  // Emitted after a fork_message succeeds. A full chat_replay follows.
  | {
      type: "chat_forked";
      chatId: string;
      branchId: string;         // ID of the branch that now holds the old trunk
      parentMessageId: string;  // which user_message was the fork point
    }
  // Broadcast live when the server creates a revert checkpoint just before a
  // non-silent turn starts. The client annotates the preceding user turn so the
  // "↩ Revert" button appears without waiting for a full chat_replay.
  | {
      type: "revert_checkpoint";
      chatId: string;
      checkpointId: string;
    }
  // Broadcast when a chat spawns a subagent chat. Tagged with the *parent's*
  // chatId (the channel the sidebar is already subscribed to) and carries the
  // new chat's summary so the sidebar can show it immediately.
  | {
      type: "chat_created";
      chatId: string;
      summary: ChatSummary;
    }
  // Broadcast whenever the repo's plans/tickets file changes (coordinator tool
  // call or user action via the plans panel). Tagged with the coordinator's
  // chatId so existing per-chat subscriptions deliver it.
  | {
      type: "plans_updated";
      chatId: string;
      tickets: PlanTicket[];
    }
  // Full snapshot of the chat's subagent / shell tasks (running and recently
  // finished). REPLACE semantics. Live-only: sent on every change and right
  // after a chat_replay, never persisted.
  | {
      type: "background_tasks";
      chatId: string;
      tasks: AgentTask[];
    };

// ---- Orchestrator wire protocol ----

// Navigation actions the orchestrator's tools emit back to the client. The
// client applies these to its workspace state (open/active repo, active chat).
export type OrchestratorNav =
  | { action: "open_repo"; path: string }
  | { action: "switch_chat"; repoPath: string; chatId: string }
  | { action: "create_chat"; repoPath: string; chatId: string };

export type OrchestratorClientMessage =
  | { type: "user_message"; text: string; activeRepoPath?: string | null }
  | { type: "interrupt" }
  | { type: "reset" };

export type OrchestratorEvent =
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; summary?: string }
  | { type: "nav"; nav: OrchestratorNav }
  | { type: "error"; message: string };

export interface OrchestratorRepoSnapshot {
  path: string;
  name: string;
  open: boolean;
  recent: boolean;
}

export interface OrchestratorChatSnapshot {
  id: string;
  title: string;
  status: ChatStatus;
  preview: string;
  updatedAt: string;
}
