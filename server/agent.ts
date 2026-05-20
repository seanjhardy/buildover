import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import {
  createCustomToolsServer,
  type RequestAttentionAck,
} from "./customTools.js";
import { readInstalledServers, toSdkMcpConfig } from "./mcp-config.js";
import type {
  AgentEvent,
  Attachment,
  ContentBlock,
  Model,
  PermissionMode,
} from "../src/types.js";

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
  abortController?: AbortController;
  // Optional hook called just before a file-modifying tool (Write, Edit,
  // MultiEdit) executes.  The session uses this to snapshot the target file's
  // current content so it can be restored on revert.
  onBeforeFileTool?: (toolName: string, input: unknown) => Promise<void>;
}

// Runs one user-turn through the SDK, normalizing messages into our wire
// format and emitting them via `emit`. Returns the (possibly new) session id.
export async function runAgentTurn(args: RunArgs): Promise<string | undefined> {
  const {
    prompt,
    model,
    sessionId,
    cwd,
    permissionMode,
    getPermissionMode,
    attachments,
    emit,
    requestPermission,
    requestAttentionAck,
    abortController,
  } = args;

  const customToolsServer = createCustomToolsServer(requestAttentionAck);

  const finalPromptContent = renderPromptWithAttachments(prompt, attachments);

  // Tools that must always surface a UI prompt regardless of permission mode,
  // because they are user-interaction checkpoints, not dangerous operations.
  const ALWAYS_PROMPT_TOOLS = new Set(["ExitPlanMode", "RequestUserAttention", "AskUserQuestion"]);

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

    // In bypassPermissions mode, the SDK still calls canUseTool for every
    // tool when the callback is supplied — so the mode alone won't suppress
    // prompts. Short-circuit here to honor the user's choice.
    // Exception: ExitPlanMode and RequestUserAttention must always go
    // through the permission UI so their answers/plans are shown to the user.
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
      permissionMode,
      canUseTool,
      includePartialMessages: false,
      // Pass the controller so the SDK terminates its CLI subprocess on
      // abort; relying on stream.interrupt() alone left the turn running.
      abortController,
      // Register custom tools (e.g. RequestUserAttention) so the SDK
      // knows about them and routes them through canUseTool → requestPermission.
      mcpServers: {
        "buildover-custom-tools": customToolsServer,
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
            const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
              "claude-opus-4-7": 1_000_000,
              "claude-sonnet-4-6": 1_000_000,
              "claude-haiku-4-5": 200_000,
            };
            const inputTokens = iterUsage.input_tokens ?? 0;
            const outputTokens = iterUsage.output_tokens ?? 0;
            const cacheReadTokens = iterUsage.cache_read_input_tokens ?? 0;
            const cacheWriteTokens = iterUsage.cache_creation_input_tokens ?? 0;
            const usedTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
            const contextWindowSize = MODEL_CONTEXT_WINDOWS[args.model] ?? 200_000;
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
          // Emit context usage derived from the SDK's usage + modelUsage fields.
          // modelUsage is keyed by model name and carries contextWindow size.
          const usage = (message as any).usage as
            | {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              }
            | undefined;
          const modelUsageMap = (message as any).modelUsage as
            | Record<string, { contextWindow?: number }>
            | undefined;
          if (usage) {
            const inputTokens = usage.input_tokens ?? 0;
            const outputTokens = usage.output_tokens ?? 0;
            const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
            const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
            const usedTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
            // Prefer the actual model's context window size reported by the SDK.
            // Fall back to a static lookup table of known limits, then 200k.
            const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
              "claude-opus-4-7": 1_000_000,
              "claude-sonnet-4-6": 1_000_000,
              "claude-haiku-4-5": 200_000,
            };
            const modelEntry = modelUsageMap
              ? Object.values(modelUsageMap)[0]
              : undefined;
            // modelEntry.contextWindow comes from the SDK; if absent, fall back
            // to our static table keyed by the model used in this turn, then 200k.
            const contextWindowSize =
              MODEL_CONTEXT_WINDOWS[args.model] ??
              modelEntry?.contextWindow ??
              200_000;
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

        default:
          break;
      }
    }
  } catch (err) {
    // AbortErrors are intentional interruptions (user clicked stop, or force-forwarded
    // a queued message). Don't emit them as visible error events in the chat.
    const isAbort =
      (err instanceof Error && err.name === "AbortError") ||
      (typeof DOMException !== "undefined" &&
        err instanceof DOMException &&
        err.name === "AbortError");
    if (!isAbort) {
      console.error("[agent] runAgentTurn error:", err);
      emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
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
type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

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
          media_type: a.mime,
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
