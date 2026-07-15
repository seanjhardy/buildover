// Shared message types between server and client.

export type Model = string;

export type ModelProvider = "claude" | "cursor" | "openai";

/** Fallback model list used before the /api/models response arrives. */
export const MODELS: { id: string; label: string; provider?: ModelProvider }[] = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "claude" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", provider: "claude" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "claude" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", provider: "claude" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "claude" },
];

export const DEFAULT_MODEL: Model = "claude-opus-4-8";

/** Cursor model ids are stored as `cursor:<nativeId>`. */
export const CURSOR_MODEL_PREFIX = "cursor:";

export function getModelProvider(model: string): ModelProvider {
  if (model.startsWith(CURSOR_MODEL_PREFIX)) return "cursor";
  if (model.startsWith("claude-")) return "claude";
  return "openai";
}

/**
 * Subagents always run on Haiku 4.5 — fast and cheap, suited to the focused,
 * well-scoped work a coordinator hands off. Enforced by chat kind in runTurn,
 * so it holds regardless of who spawned the subagent or how a turn is resumed.
 */
export const SUBAGENT_MODEL: Model = "claude-haiku-4-5";

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
  /** User turns deferred because Claude usage is exhausted. The user message
   *  is already persisted in events; these entries are the runnable work queue. */
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
}

export interface QueuedChatTurn {
  id: string;
  text: string;
  model: Model;
  permissionMode: PermissionMode;
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
  score: number;
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
