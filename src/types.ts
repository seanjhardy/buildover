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
  | "finished";

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
  | { type: "turn_end"; ts: string };

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
  | { type: "interrupt"; chatId: string };

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
    };
