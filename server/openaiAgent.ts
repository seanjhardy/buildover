/**
 * OpenAI Codex runner.
 *
 * Runs the official Codex CLI in non-interactive JSONL mode. This deliberately
 * delegates authentication, model transport, tools, sandboxing, and session
 * persistence to Codex instead of reimplementing its private Responses API.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawAgentEvent } from "./agent.js";
import type {
  Attachment,
  ChatEvent,
  ContentBlock,
  PermissionMode,
} from "../src/types.js";
import { readCodexCreds, resolveCodexCommand } from "./codexAuth.js";

export interface OpenAIRunArgs {
  prompt: string;
  model: string;
  cwd: string;
  permissionMode: PermissionMode;
  codexSessionId?: string;
  attachments?: Attachment[];
  conversationHistory: ChatEvent[];
  emit: (event: RawAgentEvent) => void;
  abortController?: AbortController;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | string | null;
  query?: string;
  items?: Array<{ text?: string; completed?: boolean }>;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  usage?: CodexUsage;
  error?: { message?: string } | string;
  message?: string;
  item?: CodexItem;
}

function contextWindowFor(model: string): number {
  if (/^gpt-5\.(4|5|6)/.test(model)) return 272_000;
  if (/^gpt-5/.test(model)) return 400_000;
  return 200_000;
}

function buildHistoryPreamble(
  events: ChatEvent[],
  currentPrompt: string,
): string {
  const lines: string[] = [];
  let lastUserIndex = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type === "user_message") {
      lastUserIndex = index;
      break;
    }
  }
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.type === "user_message") {
      if (index === lastUserIndex && event.text === currentPrompt) continue;
      lines.push(`User: ${event.text}`);
    } else if (event.type === "assistant") {
      const text = event.content
        .filter(
          (block): block is { type: "text"; text: string } =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("");
      if (text.trim()) lines.push(`Assistant: ${text}`);
    }
  }
  if (lines.length === 0) return "";
  let body = lines.join("\n\n");
  if (body.length > 16_000) body = body.slice(-16_000);
  return [
    "Previous conversation in this Buildover chat (continue naturally):",
    "",
    body,
    "",
    "---",
    "",
  ].join("\n");
}

function appendTextAttachments(prompt: string, attachments?: Attachment[]): string {
  const textAttachments = (attachments ?? []).filter(
    (attachment) => attachment.contents != null,
  );
  if (textAttachments.length === 0) return prompt;
  return [
    prompt,
    ...textAttachments.map(
      (attachment) =>
        `\n---\nAttached file: ${attachment.name} (${attachment.mime})\n\`\`\`\n${attachment.contents}\n\`\`\``,
    ),
  ].join("\n");
}

async function materializeImages(
  attachments?: Attachment[],
): Promise<{ dir: string | null; paths: string[] }> {
  const images = (attachments ?? []).filter(
    (attachment) => attachment.dataUrl?.includes(";base64,"),
  );
  if (images.length === 0) return { dir: null, paths: [] };

  const dir = await mkdtemp(join(tmpdir(), "buildover-codex-"));
  const paths: string[] = [];
  for (let index = 0; index < images.length; index++) {
    const attachment = images[index]!;
    const encoded = attachment.dataUrl!.split(";base64,")[1] ?? "";
    const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = join(dir, `${index}-${safeName}`);
    await writeFile(path, Buffer.from(encoded, "base64"));
    paths.push(path);
  }
  return { dir, paths };
}

function errorMessage(event: CodexEvent): string {
  if (typeof event.error === "string") return event.error;
  if (event.error?.message) return event.error.message;
  return event.message || "Codex turn failed";
}

function itemError(item: CodexItem): string | null {
  if (typeof item.error === "string") return item.error;
  return item.error?.message ?? null;
}

/**
 * Runs one Buildover turn through `codex exec --json`.
 * Returns the Codex thread id used for future `codex exec resume` calls.
 */
export async function runOpenAIAgentTurn(
  args: OpenAIRunArgs,
): Promise<string | undefined> {
  const startedAt = Date.now();
  const command = resolveCodexCommand();
  const creds = await readCodexCreds();
  const images = await materializeImages(args.attachments);
  const resumeId = args.codexSessionId;
  let sessionId = resumeId;
  let initialized = false;
  let sawTerminalEvent = false;
  let lastAgentText = "";
  let assistantCounter = 0;
  let toolTurns = 0;
  const startedItems = new Set<string>();

  const emitAssistant = (content: ContentBlock[]) => {
    if (content.length === 0) return;
    assistantCounter++;
    args.emit({
      type: "assistant",
      uuid: `${sessionId ?? "codex"}-a-${assistantCounter}`,
      sessionId: sessionId ?? "codex-pending",
      content,
    });
  };

  const emitInit = () => {
    if (initialized) return;
    initialized = true;
    args.emit({
      type: "system_init",
      sessionId: sessionId ?? `codex-${Date.now()}`,
      tools: ["Shell", "Read", "Write", "Edit", "WebSearch"],
      mcpServers: [],
      cwd: args.cwd,
      model: args.model,
      permissionMode: args.permissionMode,
    });
  };

  const emitToolStart = (
    item: CodexItem,
    name: string,
    input: Record<string, unknown>,
  ) => {
    const id = item.id ?? `codex-tool-${Date.now()}-${toolTurns}`;
    if (startedItems.has(id)) return;
    startedItems.add(id);
    toolTurns++;
    emitAssistant([{ type: "tool_use", id, name, input }]);
  };

  const emitToolResult = (
    item: CodexItem,
    content: string,
    isError = false,
  ) => {
    const id = item.id ?? `codex-tool-${Date.now()}-${toolTurns}`;
    args.emit({
      type: "user_tool_results",
      uuid: `${sessionId ?? "codex"}-tr-${id}`,
      sessionId: sessionId ?? "codex-pending",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: content || "(no output)",
          is_error: isError,
        },
      ],
    });
  };

  const onItem = (eventType: string, item: CodexItem) => {
    const completed = eventType === "item.completed";
    switch (item.type) {
      case "agent_message":
        if (completed && item.text) {
          lastAgentText = item.text;
          emitAssistant([{ type: "text", text: item.text }]);
        }
        break;
      case "reasoning":
        if (completed && item.text) {
          emitAssistant([{ type: "thinking", thinking: item.text }]);
        }
        break;
      case "command_execution":
        emitToolStart(item, "Bash", { command: item.command ?? "" });
        if (completed) {
          const output = [
            item.exit_code != null ? `Exit code: ${item.exit_code}` : "",
            item.aggregated_output ?? "",
          ]
            .filter(Boolean)
            .join("\n");
          emitToolResult(
            item,
            output,
            item.status === "failed" || (item.exit_code ?? 0) !== 0,
          );
        }
        break;
      case "file_change":
        if (completed) {
          const changes = item.changes ?? [];
          emitToolStart(item, "Edit", { changes });
          emitToolResult(
            item,
            changes
              .map(
                (change) =>
                  `${change.kind ?? "update"}: ${change.path ?? "unknown"}`,
              )
              .join("\n"),
            item.status === "failed",
          );
        }
        break;
      case "mcp_tool_call": {
        const name = item.tool
          ? `mcp__${item.server ?? "server"}__${item.tool}`
          : "MCP";
        emitToolStart(item, name, {
          arguments: item.arguments ?? {},
        });
        if (completed) {
          const failure = itemError(item);
          emitToolResult(
            item,
            failure || JSON.stringify(item.result ?? "(no output)"),
            Boolean(failure) || item.status === "failed",
          );
        }
        break;
      }
      case "web_search":
        emitToolStart(item, "WebSearch", { query: item.query ?? "" });
        if (completed) {
          emitToolResult(item, `Search completed: ${item.query ?? ""}`);
        }
        break;
      case "todo_list":
        emitAssistant([
          {
            type: "tool_use",
            id: item.id ?? `codex-todo-${Date.now()}`,
            name: "TodoWrite",
            input: {
              todos: (item.items ?? []).map((todo, index) => ({
                id: `${item.id ?? "todo"}-${index}`,
                content: todo.text ?? "",
                status: todo.completed ? "completed" : "pending",
              })),
            },
          },
        ]);
        break;
      case "error":
        if (completed) {
          args.emit({
            type: "error",
            message: itemError(item) ?? item.text ?? "Codex item failed",
          });
        }
        break;
    }
  };

  const cliArgs = [...command.args, "exec"];
  if (resumeId) cliArgs.push("resume");
  cliArgs.push("--json", "--model", args.model);
  if (!resumeId) cliArgs.push("--color", "never");
  if (!resumeId) cliArgs.push("--cd", args.cwd);
  cliArgs.push("--skip-git-repo-check");

  if (args.permissionMode === "bypassPermissions") {
    cliArgs.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (resumeId) {
    cliArgs.push(
      "--config",
      `sandbox_mode="${
        args.permissionMode === "default" || args.permissionMode === "plan"
          ? "read-only"
          : "workspace-write"
      }"`,
      "--config",
      'approval_policy="never"',
    );
  } else {
    cliArgs.push(
      "--sandbox",
      args.permissionMode === "default" || args.permissionMode === "plan"
        ? "read-only"
        : "workspace-write",
      "--config",
      'approval_policy="never"',
    );
  }
  for (const path of images.paths) cliArgs.push("--image", path);
  if (resumeId) cliArgs.push(resumeId);
  cliArgs.push("-");

  let prompt = appendTextAttachments(args.prompt, args.attachments);
  if (!resumeId) {
    prompt = buildHistoryPreamble(args.conversationHistory, args.prompt) + prompt;
  }
  if (args.permissionMode === "plan") {
    prompt =
      "Plan only. Inspect the project as needed, but do not modify files or run destructive commands. Present an implementation plan for the user.\n\n" +
      prompt;
  }

  args.emit({ type: "turn_start" });
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  // A stale OPENAI_API_KEY in Buildover's .env must not silently switch a
  // ChatGPT-authenticated Codex install to metered API billing.
  if (creds.kind === "chatgpt") delete childEnv.OPENAI_API_KEY;
  else childEnv.OPENAI_API_KEY = creds.apiKey;
  const child = spawn(command.command, cliArgs, {
    cwd: args.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
  });
  child.stdin.end(prompt);

  const onAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Process may already have exited.
    }
  };
  args.abortController?.signal.addEventListener("abort", onAbort);

  try {
    await new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (!line.trim()) return;
        let event: CodexEvent;
        try {
          event = JSON.parse(line) as CodexEvent;
        } catch {
          return;
        }

        if (event.type === "thread.started" && event.thread_id) {
          sessionId = event.thread_id;
          emitInit();
          return;
        }
        emitInit();

        if (
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed"
        ) {
          if (event.item) onItem(event.type, event.item);
          return;
        }

        if (event.type === "turn.completed") {
          sawTerminalEvent = true;
          const usage = event.usage ?? {};
          const inputTokens = usage.input_tokens ?? 0;
          const outputTokens = usage.output_tokens ?? 0;
          const contextWindowSize = contextWindowFor(args.model);
          const usedTokens = inputTokens + outputTokens;
          args.emit({
            type: "context_usage",
            usedTokens,
            contextWindowSize,
            pct: Math.min(100, (usedTokens / contextWindowSize) * 100),
            inputTokens,
            outputTokens,
            cacheReadTokens: usage.cached_input_tokens ?? 0,
            cacheWriteTokens: 0,
          });
          args.emit({
            type: "result",
            sessionId: sessionId ?? `codex-${Date.now()}`,
            subtype: "success",
            durationMs: Date.now() - startedAt,
            numTurns: Math.max(1, toolTurns),
            result: lastAgentText,
          });
          return;
        }

        if (event.type === "turn.failed" || event.type === "error") {
          sawTerminalEvent = true;
          args.emit({ type: "error", message: errorMessage(event) });
        }
      });

      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (args.abortController?.signal.aborted) {
          sawTerminalEvent = true;
          args.emit({
            type: "result",
            sessionId: sessionId ?? `codex-${Date.now()}`,
            subtype: "interrupted",
            durationMs: Date.now() - startedAt,
            numTurns: toolTurns,
          });
        } else if (!sawTerminalEvent && code !== 0) {
          args.emit({
            type: "error",
            message:
              stderr.trim().slice(-1200) ||
              `Codex exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
          });
        } else if (!sawTerminalEvent) {
          args.emit({
            type: "error",
            message: "Codex exited without completing the turn.",
          });
        }
        resolve();
      });
    });
  } finally {
    args.abortController?.signal.removeEventListener("abort", onAbort);
    if (images.dir) await rm(images.dir, { recursive: true, force: true });
    args.emit({ type: "turn_end" });
  }

  return sessionId;
}

export { isOpenAIModel } from "./modelProvider.js";
