import {
  query,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createCustomToolsServer,
  type RequestAttentionAck,
  type RequestCompact,
} from "./customTools.js";
import { readInstalledServers, toSdkMcpConfig } from "./mcp-config.js";
import type {
  AgentEvent,
  Attachment,
  ContentBlock,
  Model,
  PermissionMode,
} from "../src/types.js";

// Appended to every chat's system prompt. The native Task* progress tools are
// disabled (see disallowedTools below), so we explicitly steer the model to use
// the TodoWrite tool instead — our sidebar (useTodos / TodoPanel) renders
// progress from TodoWrite, and without this nudge the model stops tracking
// progress at all once the Task tools disappear.
const TODO_TRACKING_INSTRUCTION = `Track progress using the TodoWrite tool, not the Task tools. Maintain a todo list for any multi-step work: add items as you plan, mark exactly one item in_progress while you work on it, and mark it completed as soon as it is done. This list is rendered in the user's sidebar, so keep it current.`;

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
        | "user_tool_results"
        | "result"
        | "error"
        | "turn_start"
        | "turn_end"
        | "permission_request"
        | "context_usage";
    }
  >,
  "chatId"
>;

interface RunArgs {
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
}

// Runs one user-turn through the SDK, normalizing messages into our wire
// format and emitting them via `emit`. Returns the (possibly new) session id.
export async function runAgentTurn(args: RunArgs): Promise<string | undefined> {
  const {
    prompt,
    model,
    sessionId,
    resumeSessionAt,
    cwd,
    permissionMode,
    getPermissionMode,
    attachments,
    emit,
    requestPermission,
    requestAttentionAck,
    abortController,
  } = args;

  // Collect all assistant messages so getCurrentTodos can scan for TodoWrite calls
  const allMessages: any[] = [];

  // Helper to extract current todos from conversation history (same logic as useTodos hook)
  const getCurrentTodos = () => {
    // Walk messages in reverse to find the latest TodoWrite call
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const msg = allMessages[i];
      if (msg.type !== "assistant") continue;

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
  };

  const customToolsServer = createCustomToolsServer(
    requestAttentionAck,
    args.requestCompact,
    cwd,
    getCurrentTodos
  );

  const finalPromptContent = renderPromptWithAttachments(prompt, attachments);

  // Tools that must always surface a UI prompt regardless of permission mode,
  // because they are user-interaction checkpoints, not dangerous operations.
  // Note: RequestUserAttention is intentionally absent — it blocks inside its
  // own MCP tool handler (via requestAttentionAck), not via the permission
  // system. Routing it through requestPermission would deadlock because the
  // client ignores permission_request events for this tool.
  const ALWAYS_PROMPT_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"]);

  // Tool names that modify files — we snapshot before these run.
  const FILE_MODIFYING_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

  const canUseTool: CanUseTool = async (toolName, input) => {
    // Snapshot the target file before any file-modifying tool executes so we
    // can restore it on revert.  Do this regardless of permission mode so even
    // auto-approved edits are covered.
    if (args.onBeforeFileTool && FILE_MODIFYING_TOOLS.has(toolName)) {
      await args.onBeforeFileTool(toolName, input).catch(() => {
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
    const currentMode = getPermissionMode?.() ?? permissionMode;
    if (currentMode === "bypassPermissions" && !ALWAYS_PROMPT_TOOLS.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    const decision = await requestPermission({
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

  // SDK requires `canUseTool` to be paired with `stream-json` input. We pass
  // the prompt as an async iterable to satisfy that.
  const promptIterable = (async function* () {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: finalPromptContent },
      parent_tool_use_id: null,
      session_id: sessionId ?? "",
    };
  })();

  const stream = query({
    prompt: promptIterable,
    options: {
      model,
      cwd: cwd ?? process.cwd(),
      resume: sessionId,
      // Truncated resume after an edit / branch-switch / revert: cut the
      // resumed history at this message uuid and fork into a new session so
      // the abandoned branch's session file stays intact for future branch
      // switches. The forked session's id arrives via system_init and
      // replaces record.sessionId (which also clears the one-shot marker).
      ...(sessionId && resumeSessionAt
        ? { resumeSessionAt, forkSession: true }
        : {}),
      permissionMode,
      canUseTool,
      includePartialMessages: false,
      // Adaptive-thinking models (Opus 4.8+) default to `display: 'omitted'`,
      // which returns thinking blocks with an empty `thinking` string (only a
      // signature for multi-turn continuity). That surfaced as an empty
      // "Thinking" dropdown in the UI. Request `summarized` so the thinking
      // content is actually included. Harmless on older/non-adaptive models —
      // they return their thinking either way.
      thinking: { type: "adaptive", display: "summarized" },
      ...(args.context1m ? { betas: ["context-1m-2025-08-07" as const] } : {}),
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
      // Pass the controller so the SDK terminates its CLI subprocess on
      // abort; relying on stream.interrupt() alone left the turn running.
      abortController,
      // Every chat gets a base instruction steering progress tracking to our
      // TodoWrite tool (rendered in the sidebar via useTodos/TodoPanel). The
      // native Task tools are disabled above, so without this the model would
      // simply stop tracking progress. Coordinator/subagent chats get extra
      // role instructions appended on top.
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
        append: [TODO_TRACKING_INSTRUCTION, args.systemPromptAppend]
          .filter(Boolean)
          .join("\n\n"),
      },
      // Register custom tools (e.g. RequestUserAttention) so the SDK
      // knows about them and routes them through canUseTool → requestPermission.
      mcpServers: {
        "buildover-custom-tools": customToolsServer,
        // Coordination tools for coordinator/subagent chats.
        ...(args.extraMcpServers ?? {}),
        // User-installed servers from mcp-servers.json — re-read on every
        // turn so installs/removals take effect without a server restart.
        ...toSdkMcpConfig(readInstalledServers()),
      },
    },
  });

  let currentSessionId = sessionId;
  emit({ type: "turn_start" });

  if (abortController) {
    abortController.signal.addEventListener("abort", () => {
      try {
        // Belt-and-braces: the SDK's Query exposes interrupt() too.
        // interrupt() returns a Promise that rejects with AbortError once
        // the controller is already aborted — swallow that to avoid an
        // unhandled rejection crashing the process.
        const p = (stream as any).interrupt?.();
        if (p && typeof p.then === "function") p.catch(() => {});
      } catch {}
    });
  }

  try {
    for await (const message of stream as AsyncIterable<any>) {
      switch (message.type) {
        case "system": {
          if (message.subtype === "init") {
            currentSessionId = message.session_id ?? currentSessionId;
            emit({
              type: "system_init",
              sessionId: currentSessionId ?? "",
              tools: message.tools ?? [],
              mcpServers: message.mcp_servers ?? [],
              cwd: message.cwd,
              model: message.model,
              permissionMode: message.permissionMode,
              slashCommands: message.slash_commands ?? [],
            });
          }
          break;
        }

        case "assistant": {
          const content = normalizeContent(message.message?.content ?? []);
          // Store assistant messages so getCurrentTodos can scan for TodoWrite calls
          allMessages.push({ type: "assistant", message: message.message, content });
          emit({
            type: "assistant",
            uuid: message.uuid ?? cryptoRandomId(),
            sessionId: message.session_id ?? currentSessionId ?? "",
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
            const modelLower = args.model.toLowerCase();
            if (modelLower.includes("opus")) {
              contextWindowSize = 1_000_000;
            } else if (modelLower.includes("sonnet")) {
              contextWindowSize = args.context1m ? 1_000_000 : 200_000;
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
              sessionId: message.session_id ?? currentSessionId ?? "",
              content,
            });
          }
          break;
        }

        case "result": {
          currentSessionId = message.session_id ?? currentSessionId;
          emit({
            type: "result",
            sessionId: currentSessionId ?? "",
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
          break;
        }

        default:
          break;
      }
    }
  } catch (err) {
    // AbortErrors are intentional interruptions (user clicked stop, or force-forwarded
    // a queued message). Don't emit them as visible error events in the chat.
    // The SDK reports a user-initiated stop as a plain Error with the message
    // "Claude Code process aborted by user" (not an AbortError), so also treat
    // that message — and any error thrown while our controller is aborted — as an abort.
    const errMessage = err instanceof Error ? err.message : String(err);
    const isAbort =
      abortController?.signal.aborted === true ||
      /aborted by user/i.test(errMessage) ||
      (err instanceof Error && err.name === "AbortError") ||
      (typeof DOMException !== "undefined" &&
        err instanceof DOMException &&
        err.name === "AbortError");
    if (!isAbort) {
      console.error("[agent] runAgentTurn error:", err);
      emit({
        type: "error",
        message: errMessage,
      });
    }
  } finally {
    emit({ type: "turn_end" });
  }

  return currentSessionId;
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
