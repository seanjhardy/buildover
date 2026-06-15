/**
 * OpenAI/Codex agent runner.
 *
 * Provides the same RawAgentEvent stream as runAgentTurn() in agent.ts but
 * uses the OpenAI Chat Completions API instead of the Anthropic Claude Agent
 * SDK.  Supports a core set of coding tools (read_file, write_file, str_replace,
 * bash, list_directory) implemented directly rather than via MCP.
 */
import { exec } from "node:child_process";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import type { RawAgentEvent } from "./agent.js";
import type { Attachment, ChatEvent, ContentBlock, PermissionMode } from "../src/types.js";
import { readCodexCreds } from "./codexAuth.js";

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------

const OPENAI_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the full contents of a file. Returns raw text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative (to cwd) path of the file." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write (create or overwrite) a file. Creates parent directories automatically.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write." },
          content: { type: "string", description: "Full content to write to the file." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "str_replace",
      description:
        "Replace an exact unique substring in a file with new text. Prefer this over write_file for targeted edits.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit." },
          old_str: { type: "string", description: "The exact string to replace (must appear exactly once)." },
          new_str: { type: "string", description: "The replacement string." },
        },
        required: ["path", "old_str", "new_str"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bash",
      description: "Run a shell command and return stdout + stderr. Working directory is the repo root.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
          timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 30000, max: 120000)." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_directory",
      description: "List files and sub-directories at a path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list (default: cwd)." },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

async function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: err?.code != null ? (err.code as number) : 0,
        });
      },
    );
    // Prevent zombie processes from keeping Node alive
    child.unref?.();
  });
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<{ output: string; isError: boolean }> {
  try {
    switch (name) {
      case "read_file": {
        const absPath = resolvePath(cwd, String(args.path ?? ""));
        const content = await readFile(absPath, "utf8");
        return { output: content, isError: false };
      }

      case "write_file": {
        const absPath = resolvePath(cwd, String(args.path ?? ""));
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, String(args.content ?? ""), "utf8");
        return { output: `File written: ${absPath}`, isError: false };
      }

      case "str_replace": {
        const absPath = resolvePath(cwd, String(args.path ?? ""));
        const original = await readFile(absPath, "utf8");
        const oldStr = String(args.old_str ?? "");
        const newStr = String(args.new_str ?? "");
        const count = (original.match(new RegExp(oldStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
        if (count === 0) {
          return { output: `Error: old_str not found in ${absPath}`, isError: true };
        }
        if (count > 1) {
          return {
            output: `Error: old_str appears ${count} times in ${absPath} — must be unique. Add more context to make it unambiguous.`,
            isError: true,
          };
        }
        const updated = original.replace(oldStr, newStr);
        await writeFile(absPath, updated, "utf8");
        return { output: `Edited ${absPath}`, isError: false };
      }

      case "bash": {
        const command = String(args.command ?? "");
        const timeoutMs = Math.min(Number(args.timeout_ms ?? 30_000), 120_000);
        const { stdout, stderr, exitCode } = await runBash(command, cwd, timeoutMs);
        const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        const prefix = exitCode !== 0 ? `Exit code: ${exitCode}\n` : "";
        return { output: prefix + (combined || "(no output)"), isError: exitCode !== 0 };
      }

      case "list_directory": {
        const absPath = resolvePath(cwd, String(args.path ?? "."));
        const entries = await readdir(absPath, { withFileTypes: true });
        const lines = entries.map(
          (e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`,
        );
        return { output: lines.join("\n") || "(empty)", isError: false };
      }

      default:
        return { output: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Conversation history reconstruction
// ---------------------------------------------------------------------------

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Reconstructs an OpenAI message list from persisted ChatEvents so we can
 * resume a conversation without a server-side session.
 */
function buildHistory(events: ChatEvent[]): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  for (const ev of events) {
    if (ev.type === "user_message") {
      messages.push({ role: "user", content: ev.text });
      continue;
    }

    if (ev.type === "assistant") {
      const textBlocks = ev.content.filter((b) => b.type === "text") as Array<{ type: "text"; text: string }>;
      const toolUseBlocks = ev.content.filter((b) => b.type === "tool_use") as Array<{
        type: "tool_use";
        id: string;
        name: string;
        input: unknown;
      }>;

      if (toolUseBlocks.length > 0) {
        messages.push({
          role: "assistant",
          content: textBlocks.map((b) => b.text).join("") || null,
          tool_calls: toolUseBlocks.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
      } else if (textBlocks.length > 0) {
        messages.push({ role: "assistant", content: textBlocks.map((b) => b.text).join("") });
      }
      continue;
    }

    if (ev.type === "user_tool_results") {
      for (const block of ev.content) {
        if (block.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: block.content,
          });
        }
      }
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Approximate context windows per model family
// ---------------------------------------------------------------------------

function contextWindowFor(model: string): number {
  if (model.startsWith("o3") || model.startsWith("o4")) return 200_000;
  if (model.includes("gpt-4o") || model.includes("gpt-4.1")) return 128_000;
  if (model.includes("codex")) return 128_000;
  return 16_384;
}

// ---------------------------------------------------------------------------
// Public runner interface
// ---------------------------------------------------------------------------

export interface OpenAIRunArgs {
  prompt: string;
  model: string;
  cwd: string;
  permissionMode: PermissionMode;
  getPermissionMode?: () => PermissionMode;
  attachments?: Attachment[];
  /** Existing chat events, used to reconstruct conversation history. */
  conversationHistory: ChatEvent[];
  emit: (event: RawAgentEvent) => void;
  requestPermission: (req: {
    toolName: string;
    input: Record<string, unknown>;
    suggestions: unknown[];
  }) => Promise<
    | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
    | { behavior: "deny"; message: string; interrupt?: boolean }
  >;
  abortController?: AbortController;
}

const SYSTEM_PROMPT = `You are an expert AI coding assistant integrated into the Buildover development environment. You have access to tools that let you read/write files, run shell commands, and explore the codebase.

Guidelines:
- Be concise and precise in your responses.
- Always read relevant files before modifying them.
- Use str_replace for targeted edits rather than rewriting whole files.
- Verify your changes by reading the file back or running tests.
- When running bash commands, be explicit about what you are doing and why.`;

/**
 * Runs one user turn through the OpenAI Chat Completions API, emitting events
 * in the same RawAgentEvent format used by runAgentTurn() so the existing
 * session/persistence infrastructure works without modification.
 */
export async function runOpenAIAgentTurn(args: OpenAIRunArgs): Promise<void> {
  const { prompt, model, cwd, emit, requestPermission, abortController } = args;

  const creds = await readCodexCreds();
  const sessionId = `openai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  emit({ type: "turn_start" });
  emit({
    type: "system_init",
    sessionId,
    tools: OPENAI_TOOLS.map((t) => t.function.name),
    mcpServers: [],
    cwd,
    model,
    permissionMode: args.permissionMode,
  });

  // Build full message list: system + history + new user message
  const history = buildHistory(args.conversationHistory);
  const messages: OpenAIMessage[] = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\nWorking directory: ${cwd}` },
    ...history,
    { role: "user", content: prompt },
  ];

  const MAX_ITERATIONS = 50;
  const contextWindow = contextWindowFor(model);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turns = 0;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (abortController?.signal.aborted) {
        emit({ type: "result", sessionId, subtype: "interrupted", durationMs: 0, numTurns: turns });
        emit({ type: "turn_end" });
        return;
      }

      // Call OpenAI
      const apiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          tools: OPENAI_TOOLS,
          tool_choice: "auto",
          max_tokens: 16_384,
        }),
        signal: abortController?.signal,
      });

      if (!apiResponse.ok) {
        const body = await apiResponse.text().catch(() => "");
        const errMsg = `OpenAI API error ${apiResponse.status}: ${body.slice(0, 300)}`;
        emit({ type: "error", message: errMsg });
        emit({ type: "turn_end" });
        return;
      }

      const data = (await apiResponse.json()) as {
        id: string;
        choices: Array<{
          message: {
            role: string;
            content: string | null;
            tool_calls?: OpenAIToolCall[];
          };
          finish_reason: string;
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      turns++;
      const choice = data.choices[0];
      if (!choice) {
        emit({ type: "error", message: "OpenAI returned no choices" });
        emit({ type: "turn_end" });
        return;
      }

      const msg = choice.message;

      // Track token usage
      if (data.usage) {
        totalInputTokens += data.usage.prompt_tokens;
        totalOutputTokens += data.usage.completion_tokens;
        const usedTokens = totalInputTokens + totalOutputTokens;
        emit({
          type: "context_usage",
          usedTokens,
          contextWindowSize: contextWindow,
          pct: Math.min(100, Math.round((usedTokens / contextWindow) * 100)),
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
      }

      // Build ContentBlock array for the assistant event
      const contentBlocks: ContentBlock[] = [];
      if (msg.content) {
        contentBlocks.push({ type: "text", text: msg.content });
      }
      const toolCalls = msg.tool_calls ?? [];
      for (const tc of toolCalls) {
        let input: unknown = {};
        try { input = JSON.parse(tc.function.arguments); } catch { /* keep empty */ }
        contentBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }

      const uuid = `${sessionId}-msg-${i}`;
      emit({ type: "assistant", uuid, sessionId, content: contentBlocks });

      // Add assistant turn to running history
      messages.push({
        role: "assistant",
        content: msg.content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });

      // No tool calls → done
      if (toolCalls.length === 0 || choice.finish_reason === "stop") {
        emit({
          type: "result",
          sessionId,
          subtype: "success",
          durationMs: 0,
          numTurns: turns,
          result: msg.content ?? "",
        });
        emit({ type: "turn_end" });
        return;
      }

      // Handle tool calls one by one
      const toolResultBlocks: ContentBlock[] = [];

      for (const tc of toolCalls) {
        if (abortController?.signal.aborted) {
          emit({ type: "result", sessionId, subtype: "interrupted", durationMs: 0, numTurns: turns });
          emit({ type: "turn_end" });
          return;
        }

        let parsedInput: Record<string, unknown> = {};
        try { parsedInput = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* keep empty */ }

        // Permission check (unless bypass mode)
        const mode = args.getPermissionMode?.() ?? args.permissionMode;
        if (mode !== "bypassPermissions") {
          const decision = await requestPermission({
            toolName: tc.function.name,
            input: parsedInput,
            suggestions: [],
          });

          if (decision.behavior === "deny") {
            const deniedOutput = `Tool use denied: ${decision.message}`;
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: tc.id,
              content: deniedOutput,
              is_error: true,
            });
            messages.push({ role: "tool", tool_call_id: tc.id, content: deniedOutput });

            if (decision.interrupt) {
              emit({ type: "result", sessionId, subtype: "interrupted", durationMs: 0, numTurns: turns });
              emit({ type: "turn_end" });
              return;
            }
            continue;
          }

          if (decision.updatedInput) {
            parsedInput = decision.updatedInput as Record<string, unknown>;
          }
        }

        // Execute the tool
        const { output, isError } = await executeTool(tc.function.name, parsedInput, cwd);

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: output,
          is_error: isError,
        });
        messages.push({ role: "tool", tool_call_id: tc.id, content: output });
      }

      // Emit tool results as a single user_tool_results event
      if (toolResultBlocks.length > 0) {
        emit({
          type: "user_tool_results",
          uuid: `${sessionId}-tr-${i}`,
          sessionId,
          content: toolResultBlocks,
        });
      }
    }

    // Fell out of the loop — max iterations
    emit({ type: "result", sessionId, subtype: "max_turns", durationMs: 0, numTurns: MAX_ITERATIONS });
    emit({ type: "turn_end" });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      emit({ type: "result", sessionId, subtype: "interrupted", durationMs: 0, numTurns: turns });
    } else {
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    emit({ type: "turn_end" });
  }
}

/** Returns true if the model ID refers to an OpenAI / Codex model. */
export function isOpenAIModel(model: string): boolean {
  return !model.startsWith("claude-");
}
