// Shared message types between server and client.

export type Model =
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5";

export const MODELS: { id: Model; label: string }[] = [
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

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

// ---- Chats / repos ----

export type ChatStatus =
  | "awaiting_input"
  | "running"
  | "agent_done"
  | "idle"
  | "finished"
  | "error";

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
  | ({ type: "context_usage"; ts: string } & ContextUsage);

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
  model: Model;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  events: ChatEvent[];
  /** Most recent context window usage — updated on every turn, used to
   *  re-populate the context ring when replaying/loading a chat. */
  lastContextUsage?: ContextUsage;
  /** Diverging conversation branches created via message editing. Absent on
   *  linear chats. record.events is always the currently active branch. */
  branches?: ChatBranch[];
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
    };

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
    }
  // Emitted after a fork_message succeeds. A full chat_replay follows.
  | {
      type: "chat_forked";
      chatId: string;
      branchId: string;         // ID of the branch that now holds the old trunk
      parentMessageId: string;  // which user_message was the fork point
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
