/**
 * Cursor agent runner.
 *
 * Spawns the local `cursor-agent` CLI (same binary the Cursor IDE uses) with
 * the IDE session token, streaming `stream-json` events and mapping them to
 * the shared RawAgentEvent format so chat transcripts stay interchangeable
 * with Claude / OpenAI turns.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RawAgentEvent } from "./agent.js";
import type { ChatEvent, ContentBlock, PermissionMode } from "../src/types.js";
import {
  readCursorCreds,
  resolveCursorAgentBinary,
} from "./cursorAuth.js";
import { cursorNativeModelId } from "./modelProvider.js";

export interface CursorRunArgs {
  prompt: string;
  model: string;
  cwd: string;
  permissionMode: PermissionMode;
  /** Existing Cursor chat id for --resume (per-provider session). */
  cursorSessionId?: string;
  conversationHistory: ChatEvent[];
  emit: (event: RawAgentEvent) => void;
  abortController?: AbortController;
}

/**
 * Build a plain-text transcript of prior turns so a Cursor session started
 * mid-chat (after Claude turns) still sees the conversation.
 */
function buildHistoryPreamble(events: ChatEvent[]): string {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.type === "user_message") {
      lines.push(`User: ${ev.text}`);
    } else if (ev.type === "assistant") {
      const text = ev.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text.trim()) lines.push(`Assistant: ${text}`);
    }
  }
  if (lines.length === 0) return "";
  let body = lines.join("\n\n");
  if (body.length > 12_000) {
    body = body.slice(body.length - 12_000);
    const cut = body.indexOf("\n");
    if (cut > 0) body = body.slice(cut + 1);
  }
  return (
    "Previous conversation in this Buildover chat (for context; continue naturally):\n\n" +
    body +
    "\n\n---\n\n"
  );
}

function toolNameAndInput(toolCall: Record<string, unknown>): {
  name: string;
  input: Record<string, unknown>;
} {
  const keys = Object.keys(toolCall).filter(
    (k) => k.endsWith("ToolCall") || k.endsWith("Tool"),
  );
  for (const key of keys) {
    const block = toolCall[key] as Record<string, unknown> | undefined;
    if (!block || typeof block !== "object") continue;
    const tArgs = (block.args ?? {}) as Record<string, unknown>;
    const name = key
      .replace(/ToolCall$/, "")
      .replace(/Tool$/, "")
      .replace(/([A-Z])/g, "_$1")
      .replace(/^_/, "")
      .toLowerCase();
    if (key === "shellToolCall") {
      return {
        name: "Bash",
        input: {
          command: tArgs.command,
          description: tArgs.description ?? block.description,
        },
      };
    }
    if (key === "readToolCall" || key === "readFileToolCall") {
      return {
        name: "Read",
        input: { path: tArgs.path ?? tArgs.targetFile ?? tArgs.filePath },
      };
    }
    if (
      key === "writeToolCall" ||
      key === "editToolCall" ||
      key === "editFileToolCall"
    ) {
      return {
        name: key.startsWith("write") ? "Write" : "Edit",
        input: {
          path: tArgs.path ?? tArgs.targetFile ?? tArgs.filePath,
          ...tArgs,
        },
      };
    }
    if (key === "grepToolCall" || key === "searchToolCall") {
      return { name: "Grep", input: tArgs };
    }
    if (key === "lsToolCall" || key === "listToolCall") {
      return { name: "LS", input: tArgs };
    }
    return { name: name || key, input: tArgs };
  }
  return { name: "Tool", input: toolCall };
}

function toolResultContent(toolCall: Record<string, unknown>): {
  content: string;
  isError: boolean;
} {
  const keys = Object.keys(toolCall).filter((k) => k.endsWith("ToolCall"));
  for (const key of keys) {
    const block = toolCall[key] as Record<string, unknown> | undefined;
    const result = block?.result as Record<string, unknown> | undefined;
    if (!result) continue;
    if (result.success && typeof result.success === "object") {
      const s = result.success as Record<string, unknown>;
      const out =
        (s.stdout as string) ||
        (s.interleavedOutput as string) ||
        (s.content as string) ||
        JSON.stringify(s).slice(0, 8000);
      return { content: out, isError: false };
    }
    if (result.error || result.failure) {
      return {
        content: JSON.stringify(result.error ?? result.failure).slice(0, 8000),
        isError: true,
      };
    }
    return { content: JSON.stringify(result).slice(0, 8000), isError: false };
  }
  return { content: "(no output)", isError: false };
}

function contextWindowFor(model: string): number {
  if (/opus|1m|sol-/i.test(model)) return 1_000_000;
  return 200_000;
}

/**
 * Runs one user turn through cursor-agent, emitting RawAgentEvent events.
 * Returns the Cursor session id (for providerSessions.cursor persistence).
 */
export async function runCursorAgentTurn(
  args: CursorRunArgs,
): Promise<string | undefined> {
  const binary = resolveCursorAgentBinary();
  if (!binary) {
    args.emit({
      type: "error",
      message:
        "cursor-agent binary not found. Install/update the Cursor app, or set CURSOR_AGENT_PATH.",
    });
    args.emit({ type: "turn_end" });
    return undefined;
  }

  const creds = await readCursorCreds();
  const nativeModel = cursorNativeModelId(args.model);
  const force =
    args.permissionMode === "bypassPermissions" ||
    args.permissionMode === "acceptEdits";

  let sessionId = args.cursorSessionId;
  let needsPreamble = false;

  if (!sessionId) {
    needsPreamble = args.conversationHistory.some(
      (e) => e.type === "user_message" || e.type === "assistant",
    );
    sessionId = await createCursorChat(binary, creds.token, args.cwd);
  }

  const promptText =
    (needsPreamble ? buildHistoryPreamble(args.conversationHistory) : "") +
    args.prompt;

  const cliArgs = [
    "-p",
    "--trust",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--model",
    nativeModel,
    "--workspace",
    args.cwd,
  ];
  if (force) cliArgs.push("--force");
  if (args.permissionMode === "plan") cliArgs.push("--mode", "plan");
  if (sessionId) cliArgs.push("--resume", sessionId);
  cliArgs.push(promptText);

  args.emit({ type: "turn_start" });

  const child = spawn(binary, cliArgs, {
    cwd: args.cwd,
    env: {
      ...process.env,
      CURSOR_AUTH_TOKEN: creds.token,
      CURSOR_API_KEY: process.env.CURSOR_API_KEY || creds.token,
      NO_OPEN_BROWSER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let finalSessionId = sessionId;
  let emittedInit = false;
  let assistantUuidCounter = 0;
  let pendingThinking = "";
  let openAssistantBlocks: ContentBlock[] = [];
  let sawResult = false;
  const startedToolIds = new Set<string>();
  let totalInput = 0;
  let totalOutput = 0;
  let turns = 0;
  const startedAt = Date.now();

  const flushAssistant = (sid: string) => {
    if (openAssistantBlocks.length === 0 && !pendingThinking.trim()) return;
    const content: ContentBlock[] = [];
    if (pendingThinking.trim()) {
      content.push({ type: "thinking", thinking: pendingThinking });
      pendingThinking = "";
    }
    content.push(...openAssistantBlocks);
    openAssistantBlocks = [];
    if (content.length === 0) return;
    assistantUuidCounter++;
    args.emit({
      type: "assistant",
      uuid: `${sid}-a-${assistantUuidCounter}`,
      sessionId: sid,
      content,
    });
  };

  const onAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  args.abortController?.signal.addEventListener("abort", onAbort);

  try {
    await new Promise<void>((resolve, reject) => {
      const rl = createInterface({ input: child.stdout });
      let stderr = "";
      child.stderr.on("data", (buf: Buffer) => {
        stderr += buf.toString();
      });

      rl.on("line", (line) => {
        if (!line.trim()) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }

        const type = msg.type as string;
        const sid =
          (msg.session_id as string) ||
          finalSessionId ||
          `cursor-${Date.now()}`;
        finalSessionId = sid;

        if (type === "system" && msg.subtype === "init") {
          emittedInit = true;
          args.emit({
            type: "system_init",
            sessionId: sid,
            tools: [],
            mcpServers: [],
            cwd: args.cwd,
            model: args.model,
            permissionMode: args.permissionMode,
          });
          return;
        }

        if (!emittedInit) {
          emittedInit = true;
          args.emit({
            type: "system_init",
            sessionId: sid,
            tools: [],
            mcpServers: [],
            cwd: args.cwd,
            model: args.model,
            permissionMode: args.permissionMode,
          });
        }

        if (type === "thinking") {
          if (msg.subtype === "delta" && typeof msg.text === "string") {
            pendingThinking += msg.text;
          }
          return;
        }

        if (type === "tool_call") {
          const callId = String(
            msg.call_id ?? msg.toolCallId ?? `tool-${Date.now()}`,
          );
          const toolCall = (msg.tool_call ?? {}) as Record<string, unknown>;

          if (msg.subtype === "started" && !startedToolIds.has(callId)) {
            if (pendingThinking.trim()) {
              openAssistantBlocks.unshift({
                type: "thinking",
                thinking: pendingThinking,
              });
              pendingThinking = "";
            }
            const { name, input } = toolNameAndInput(toolCall);
            openAssistantBlocks.push({
              type: "tool_use",
              id: callId,
              name,
              input,
            });
            flushAssistant(sid);
            startedToolIds.add(callId);
            turns++;
          }

          if (msg.subtype === "completed") {
            const { content, isError } = toolResultContent(toolCall);
            args.emit({
              type: "user_tool_results",
              uuid: `${sid}-tr-${callId}`,
              sessionId: sid,
              content: [
                {
                  type: "tool_result",
                  tool_use_id: callId,
                  content,
                  is_error: isError,
                },
              ],
            });
          }
          return;
        }

        if (type === "assistant") {
          const message = msg.message as
            | { content?: Array<{ type: string; text?: string }> }
            | undefined;
          for (const part of message?.content ?? []) {
            if (part.type === "text" && part.text) {
              const last = openAssistantBlocks[openAssistantBlocks.length - 1];
              if (last?.type === "text") {
                last.text = part.text;
              } else {
                openAssistantBlocks.push({ type: "text", text: part.text });
              }
            }
          }
          return;
        }

        if (type === "result") {
          flushAssistant(sid);
          sawResult = true;
          const usage = msg.usage as
            | {
                inputTokens?: number;
                outputTokens?: number;
                cacheReadTokens?: number;
                cacheWriteTokens?: number;
              }
            | undefined;
          if (usage) {
            totalInput += usage.inputTokens ?? 0;
            totalOutput += usage.outputTokens ?? 0;
            const used = totalInput + totalOutput;
            const window = contextWindowFor(nativeModel);
            args.emit({
              type: "context_usage",
              usedTokens: used,
              contextWindowSize: window,
              pct: Math.min(100, Math.round((used / window) * 100)),
              inputTokens: totalInput,
              outputTokens: totalOutput,
              cacheReadTokens: usage.cacheReadTokens ?? 0,
              cacheWriteTokens: usage.cacheWriteTokens ?? 0,
            });
          }

          const subtype =
            msg.is_error || msg.subtype === "error"
              ? "error"
              : msg.subtype === "interrupted"
                ? "interrupted"
                : "success";

          if (subtype === "error" && typeof msg.result === "string") {
            args.emit({ type: "error", message: msg.result });
          }

          args.emit({
            type: "result",
            sessionId: sid,
            subtype: subtype as "success" | "error" | "interrupted",
            durationMs: Number(msg.duration_ms ?? Date.now() - startedAt),
            numTurns: turns || 1,
            result: typeof msg.result === "string" ? msg.result : undefined,
          });
        }
      });

      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        flushAssistant(finalSessionId || sessionId || "cursor-unknown");
        if (!sawResult && code && code !== 0) {
          args.emit({
            type: "error",
            message:
              stderr.trim().slice(0, 500) ||
              `cursor-agent exited with code ${code}`,
          });
        }
        if (!emittedInit) {
          const sid = finalSessionId || sessionId || `cursor-${Date.now()}`;
          args.emit({
            type: "system_init",
            sessionId: sid,
            tools: [],
            mcpServers: [],
            cwd: args.cwd,
            model: args.model,
            permissionMode: args.permissionMode,
          });
          args.emit({
            type: "result",
            sessionId: sid,
            subtype: "error",
            durationMs: Date.now() - startedAt,
            numTurns: 0,
          });
        }
        resolve();
      });
    });
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      args.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    args.abortController?.signal.removeEventListener("abort", onAbort);
    args.emit({ type: "turn_end" });
  }

  return finalSessionId;
}

async function createCursorChat(
  binary: string,
  token: string,
  cwd: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["create-chat"], {
      cwd,
      env: {
        ...process.env,
        CURSOR_AUTH_TOKEN: token,
        CURSOR_API_KEY: process.env.CURSOR_API_KEY || token,
        NO_OPEN_BROWSER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.on("close", () => {
      const id = out.trim().split(/\s+/).pop();
      resolve(id && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined);
    });
    child.on("error", () => resolve(undefined));
  });
}
