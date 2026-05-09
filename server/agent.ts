import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { customToolsServer } from "./customTools.js";
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
        | "permission_request";
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
  abortController?: AbortController;
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
    abortController,
  } = args;

  const finalPrompt = renderPromptWithAttachments(prompt, attachments);

  // Tools that must always surface a UI prompt regardless of permission mode,
  // because they are user-interaction checkpoints, not dangerous operations.
  const ALWAYS_PROMPT_TOOLS = new Set(["ExitPlanMode", "RequestUserAttention"]);

  const canUseTool: CanUseTool = async (toolName, input) => {
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
      message: { role: "user" as const, content: finalPrompt },
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
          break;
        }

        default:
          break;
      }
    }
  } catch (err) {
    emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
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

// Renders attachments into the prompt as fenced contents (text files) or
// path references (binary). For v2 the agent loop sees them as part of the
// user's message body, which is the same approach the VS Code extension
// takes when you @-mention a workspace file.
function renderPromptWithAttachments(
  text: string,
  attachments: Attachment[] | undefined,
): string {
  if (!attachments || attachments.length === 0) return text;
  const parts: string[] = [text];
  for (const a of attachments) {
    parts.push("");
    if (a.contents != null) {
      parts.push(`---`);
      parts.push(`Attached file: ${a.name} (${a.mime})`);
      parts.push("```");
      parts.push(a.contents);
      parts.push("```");
    } else if (a.dataUrl) {
      parts.push(`---`);
      parts.push(
        `Attached image: ${a.name} (${a.mime}, ${formatBytes(a.size)}). Data URL omitted from prompt; use Read tool if you need contents.`,
      );
    }
  }
  return parts.join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
