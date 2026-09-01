/**
 * OpenAI Codex runner.
 *
 * Uses Codex app-server over its stdio JSON-RPC transport. Unlike
 * `codex exec --json`, app-server is bidirectional: Codex can pause a turn,
 * ask Buildover for structured user input, and continue with the answer.
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

type PermissionDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
    }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export interface OpenAIRunArgs {
  prompt: string;
  model: string;
  cwd: string;
  permissionMode: PermissionMode;
  codexSessionId?: string;
  attachments?: Attachment[];
  conversationHistory: ChatEvent[];
  emit: (event: RawAgentEvent) => void;
  requestPermission: (req: {
    toolName: string;
    input: Record<string, unknown>;
    suggestions: unknown[];
  }) => Promise<PermissionDecision>;
  abortController?: AbortController;
}

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code?: number; message?: string };
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  summary?: string[];
  content?: string[];
  command?: string;
  cwd?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  status?: string;
  changes?: Array<Record<string, unknown>>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  contentItems?: Array<{ type?: string; text?: string }> | null;
  success?: boolean | null;
  error?: { message?: string } | string | null;
  query?: string;
}

interface AskQuestion {
  id?: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

const APP_SERVER_SESSION_PREFIX = "appserver:";

const ASK_USER_QUESTION_INSTRUCTIONS =
  "Buildover provides an AskUserQuestion tool in every collaboration mode. " +
  "Use it whenever you need a user decision or when the user asks you to show " +
  "a question UI. Keep each header short and provide 2-3 useful options when " +
  "possible; Buildover automatically adds a free-form Other option.";

const ASK_USER_QUESTION_TOOL = {
  type: "function",
  name: "AskUserQuestion",
  description:
    "Ask the user one to three structured questions and wait for their answers. Available in both Default and Plan modes.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string" },
            header: { type: "string" },
            multiSelect: { type: "boolean" },
            options: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
              },
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

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

function appendTextAttachments(
  prompt: string,
  attachments?: Attachment[],
): string {
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeOptions(
  value: unknown,
): Array<{ label: string; description?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    const record = asRecord(option);
    if (typeof record.label !== "string" || !record.label.trim()) return [];
    return [
      {
        label: record.label,
        ...(typeof record.description === "string"
          ? { description: record.description }
          : {}),
      },
    ];
  });
}

function normalizeAskInput(value: unknown): { questions: AskQuestion[] } {
  const input = asRecord(value);
  const candidates = Array.isArray(input.questions)
    ? input.questions
    : typeof input.question === "string"
      ? [input]
      : [];
  const questions = candidates.flatMap((candidate, index) => {
    const question = asRecord(candidate);
    if (typeof question.question !== "string" || !question.question.trim()) {
      return [];
    }
    return [
      {
        ...(typeof question.id === "string" ? { id: question.id } : {}),
        question: question.question,
        header:
          typeof question.header === "string"
            ? question.header
            : `Q${index + 1}`,
        multiSelect: question.multiSelect === true,
        options: normalizeOptions(question.options),
      },
    ];
  });
  return { questions };
}

function decisionText(decision: PermissionDecision): string {
  if (decision.behavior === "deny") {
    return decision.message || "The user skipped this question.";
  }
  const answers = decision.updatedInput?.answers ?? {};
  return `User answers: ${JSON.stringify(answers)}`;
}

function contentItemsText(item: CodexItem): string {
  const text = (item.contentItems ?? [])
    .filter((content) => content.type === "inputText")
    .map((content) => content.text ?? "")
    .filter(Boolean)
    .join("\n");
  return text || (item.success === false ? "Tool call failed" : "Tool completed");
}

function itemError(item: CodexItem): string | null {
  if (typeof item.error === "string") return item.error;
  return item.error?.message ?? null;
}

/**
 * Runs one Buildover turn through Codex app-server. Returns a prefixed thread
 * id so legacy `codex exec` sessions can be migrated once without attempting
 * to resume them without Buildover's dynamic question tool.
 */
export async function runOpenAIAgentTurn(
  args: OpenAIRunArgs,
): Promise<string | undefined> {
  const startedAt = Date.now();
  const command = resolveCodexCommand();
  const creds = await readCodexCreds();
  const images = await materializeImages(args.attachments);
  const storedSessionId = args.codexSessionId;
  const resumeId = storedSessionId?.startsWith(APP_SERVER_SESSION_PREFIX)
    ? storedSessionId.slice(APP_SERVER_SESSION_PREFIX.length)
    : undefined;
  let threadId = resumeId;
  let sessionId = resumeId
    ? `${APP_SERVER_SESSION_PREFIX}${resumeId}`
    : undefined;
  let turnId: string | undefined;
  let initialized = false;
  let sawTerminalEvent = false;
  let lastErrorMessage = "";
  let lastAgentText = "";
  let assistantCounter = 0;
  let toolTurns = 0;
  const runNonce = `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const startedItems = new Set<string>();

  const publicSessionId = () => sessionId ?? `codex-${Date.now()}`;

  const emitAssistant = (content: ContentBlock[]) => {
    if (content.length === 0) return;
    assistantCounter++;
    args.emit({
      type: "assistant",
      uuid: `${publicSessionId()}-run-${runNonce}-a-${assistantCounter}`,
      sessionId: publicSessionId(),
      content,
    });
  };

  const emitInit = () => {
    if (initialized || !sessionId) return;
    initialized = true;
    args.emit({
      type: "system_init",
      sessionId,
      tools: [
        "Shell",
        "Read",
        "Write",
        "Edit",
        "WebSearch",
        "AskUserQuestion",
      ],
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
      uuid: `${publicSessionId()}-run-${runNonce}-tr-${id}`,
      sessionId: publicSessionId(),
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
    const completed = eventType === "item/completed";
    switch (item.type) {
      case "agentMessage":
        if (completed && item.text) {
          lastAgentText = item.text;
          emitAssistant([{ type: "text", text: item.text }]);
        }
        break;
      case "plan":
        if (completed && item.text) {
          lastAgentText = item.text;
          emitAssistant([{ type: "text", text: item.text }]);
        }
        break;
      case "reasoning": {
        const thinking = [...(item.summary ?? []), ...(item.content ?? [])]
          .filter(Boolean)
          .join("\n");
        if (completed && thinking) {
          emitAssistant([{ type: "thinking", thinking }]);
        }
        break;
      }
      case "commandExecution":
        emitToolStart(item, "Bash", {
          command: item.command ?? "",
          ...(item.cwd ? { cwd: item.cwd } : {}),
        });
        if (completed) {
          const output = [
            item.exitCode != null ? `Exit code: ${item.exitCode}` : "",
            item.aggregatedOutput ?? "",
          ]
            .filter(Boolean)
            .join("\n");
          emitToolResult(
            item,
            output,
            item.status === "failed" || (item.exitCode ?? 0) !== 0,
          );
        }
        break;
      case "fileChange":
        if (completed) {
          const changes = item.changes ?? [];
          emitToolStart(item, "Edit", { changes });
          emitToolResult(
            item,
            changes
              .map((change) => {
                const path = String(change.path ?? "unknown");
                const kind = String(change.kind ?? "update");
                return `${kind}: ${path}`;
              })
              .join("\n"),
            item.status === "failed" || item.status === "declined",
          );
        }
        break;
      case "mcpToolCall": {
        const name = item.tool
          ? `mcp__${item.server ?? "server"}__${item.tool}`
          : "MCP";
        emitToolStart(item, name, { arguments: item.arguments ?? {} });
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
      case "dynamicToolCall": {
        const input = item.tool === "AskUserQuestion"
          ? normalizeAskInput(item.arguments)
          : asRecord(item.arguments);
        emitToolStart(item, item.tool ?? "Tool", input);
        if (completed) {
          emitToolResult(item, contentItemsText(item), item.success === false);
        }
        break;
      }
      case "webSearch":
        emitToolStart(item, "WebSearch", { query: item.query ?? "" });
        if (completed) {
          emitToolResult(item, `Search completed: ${item.query ?? ""}`);
        }
        break;
    }
  };

  let prompt = appendTextAttachments(args.prompt, args.attachments);
  // Raw ids belong to the old non-interactive runner. Start one app-server
  // thread and inject Buildover's transcript as context during that migration.
  if (!resumeId) {
    prompt = buildHistoryPreamble(args.conversationHistory, args.prompt) + prompt;
  }
  if (args.permissionMode === "plan") {
    prompt =
      "Plan only. Inspect the project as needed, but do not modify files or run destructive commands. Present an implementation plan for the user.\n\n" +
      prompt;
  }

  const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  if (creds.kind === "chatgpt") delete childEnv.OPENAI_API_KEY;
  else childEnv.OPENAI_API_KEY = creds.apiKey;

  const child = spawn(
    command.command,
    [...command.args, "app-server", "--stdio"],
    {
      cwd: args.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
  });

  const send = (message: unknown) => {
    if (child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const stopServer = () => {
    if (child.exitCode != null || child.signalCode != null) return;
    child.kill("SIGTERM");
    stopTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    }, 1_000);
    stopTimer.unref?.();
  };

  const sandbox =
    args.permissionMode === "bypassPermissions"
      ? "danger-full-access"
      : args.permissionMode === "acceptEdits"
        ? "workspace-write"
        : "read-only";

  const turnInput: Array<Record<string, unknown>> = [
    { type: "text", text: prompt, text_elements: [] },
    ...images.paths.map((path) => ({ type: "localImage", path })),
  ];

  const startTurn = () => {
    if (!threadId) return;
    send({
      method: "turn/start",
      id: 3,
      params: {
        threadId,
        input: turnInput,
        cwd: args.cwd,
        model: args.model,
        approvalPolicy: "never",
      },
    });
  };

  const answerBuildoverQuestion = async (
    rpcId: string | number,
    itemId: string,
    rawInput: unknown,
    nativeQuestions?: Array<Record<string, unknown>>,
  ) => {
    const input = normalizeAskInput(rawInput);
    emitToolStart({ id: itemId }, "AskUserQuestion", input);
    const decision = await args.requestPermission({
      toolName: "AskUserQuestion",
      input,
      suggestions: [],
    });

    if (nativeQuestions) {
      const resolved = decision.behavior === "allow"
        ? asRecord(decision.updatedInput?.answers)
        : {};
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of nativeQuestions) {
        const id = typeof question.id === "string" ? question.id : "";
        const text =
          typeof question.question === "string" ? question.question : "";
        if (!id) continue;
        const value = resolved[text];
        answers[id] = {
          answers: Array.isArray(value)
            ? value.map(String)
            : value == null || value === ""
              ? []
              : [String(value)],
        };
      }
      send({ id: rpcId, result: { answers } });
      emitToolResult(
        { id: itemId },
        decisionText(decision),
        decision.behavior === "deny",
      );
      return;
    }

    send({
      id: rpcId,
      result: {
        contentItems: [{ type: "inputText", text: decisionText(decision) }],
        // A Skip is still a valid answer to the dynamic tool. Returning a
        // successful textual result lets Codex continue instead of failing the turn.
        success: true,
      },
    });
  };

  const handleServerRequest = async (message: RpcMessage) => {
    if (message.id == null || !message.method) return;
    if (message.method === "item/tool/call") {
      const params = message.params ?? {};
      if (params.tool === "AskUserQuestion") {
        await answerBuildoverQuestion(
          message.id,
          String(params.callId ?? `codex-question-${Date.now()}`),
          params.arguments,
        );
        return;
      }
      send({
        id: message.id,
        result: {
          contentItems: [
            { type: "inputText", text: `Unsupported dynamic tool: ${params.tool}` },
          ],
          success: false,
        },
      });
      return;
    }
    if (message.method === "item/tool/requestUserInput") {
      const params = message.params ?? {};
      const nativeQuestions = Array.isArray(params.questions)
        ? (params.questions as Array<Record<string, unknown>>)
        : [];
      await answerBuildoverQuestion(
        message.id,
        String(params.itemId ?? `codex-question-${Date.now()}`),
        { questions: nativeQuestions },
        nativeQuestions,
      );
      return;
    }
    if (message.method === "item/commandExecution/requestApproval") {
      send({ id: message.id, result: { decision: "decline" } });
      return;
    }
    if (message.method === "item/fileChange/requestApproval") {
      send({ id: message.id, result: { decision: "decline" } });
      return;
    }
    send({
      id: message.id,
      error: { code: -32601, message: `Unsupported server request: ${message.method}` },
    });
  };

  const onAbort = () => {
    if (threadId && turnId) {
      send({
        method: "turn/interrupt",
        id: 4,
        params: { threadId, turnId },
      });
      const timer = setTimeout(stopServer, 750);
      timer.unref?.();
    } else {
      stopServer();
    }
  };
  args.abortController?.signal.addEventListener("abort", onAbort);

  args.emit({ type: "turn_start" });

  try {
    await new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (!line.trim()) return;
        let message: RpcMessage;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          return;
        }

        if (message.method && message.id != null) {
          void handleServerRequest(message).catch((error) => {
            send({
              id: message.id,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              },
            });
          });
          return;
        }

        if (message.error && message.id != null) {
          sawTerminalEvent = true;
          lastErrorMessage = message.error.message ?? "Codex app-server request failed";
          args.emit({ type: "error", message: lastErrorMessage });
          stopServer();
          return;
        }

        if (message.id === 1) {
          send({ method: "initialized" });
          if (resumeId) {
            send({
              method: "thread/resume",
              id: 2,
              params: {
                threadId: resumeId,
                model: args.model,
                cwd: args.cwd,
                approvalPolicy: "never",
                sandbox,
                developerInstructions: ASK_USER_QUESTION_INSTRUCTIONS,
                excludeTurns: true,
              },
            });
          } else {
            send({
              method: "thread/start",
              id: 2,
              params: {
                model: args.model,
                cwd: args.cwd,
                approvalPolicy: "never",
                sandbox,
                developerInstructions: ASK_USER_QUESTION_INSTRUCTIONS,
                dynamicTools: [ASK_USER_QUESTION_TOOL],
              },
            });
          }
          return;
        }

        if (message.id === 2 && message.result?.thread?.id) {
          threadId = String(message.result.thread.id);
          sessionId = `${APP_SERVER_SESSION_PREFIX}${threadId}`;
          emitInit();
          startTurn();
          return;
        }

        if (message.id === 3 && message.result?.turn?.id) {
          turnId = String(message.result.turn.id);
          return;
        }

        if (message.method === "turn/started") {
          turnId = String(message.params?.turn?.id ?? turnId ?? "");
          return;
        }

        if (
          message.method === "item/started" ||
          message.method === "item/completed"
        ) {
          const item = message.params?.item as CodexItem | undefined;
          if (item) onItem(message.method, item);
          return;
        }

        if (message.method === "thread/tokenUsage/updated") {
          const usage = message.params?.tokenUsage;
          const total = usage?.total ?? {};
          const usedTokens = Number(total.totalTokens ?? 0);
          const contextWindowSize = Number(
            usage?.modelContextWindow ?? 200_000,
          );
          args.emit({
            type: "context_usage",
            usedTokens,
            contextWindowSize,
            pct: Math.min(100, (usedTokens / contextWindowSize) * 100),
            inputTokens: Number(total.inputTokens ?? 0),
            outputTokens: Number(total.outputTokens ?? 0),
            cacheReadTokens: Number(total.cachedInputTokens ?? 0),
            cacheWriteTokens: 0,
          });
          return;
        }

        if (message.method === "error") {
          const willRetry = message.params?.willRetry === true;
          lastErrorMessage =
            message.params?.error?.message ?? "Codex turn failed";
          if (!willRetry) args.emit({ type: "error", message: lastErrorMessage });
          return;
        }

        if (message.method === "turn/completed") {
          sawTerminalEvent = true;
          const turn = message.params?.turn ?? {};
          const status = String(turn.status ?? "completed");
          const durationMs = Number(turn.durationMs ?? Date.now() - startedAt);
          if (status === "failed") {
            const failure =
              turn.error?.message || lastErrorMessage || "Codex turn failed";
            if (failure !== lastErrorMessage) {
              args.emit({ type: "error", message: failure });
            }
          } else {
            args.emit({
              type: "result",
              sessionId: publicSessionId(),
              subtype: status === "interrupted" ? "interrupted" : "success",
              durationMs,
              numTurns: Math.max(1, toolTurns),
              result: lastAgentText,
            });
          }
          stopServer();
        }
      });

      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (stopTimer) clearTimeout(stopTimer);
        if (args.abortController?.signal.aborted && !sawTerminalEvent) {
          sawTerminalEvent = true;
          args.emit({
            type: "result",
            sessionId: publicSessionId(),
            subtype: "interrupted",
            durationMs: Date.now() - startedAt,
            numTurns: toolTurns,
          });
        } else if (!sawTerminalEvent && code !== 0) {
          args.emit({
            type: "error",
            message:
              stderr.trim().slice(-1200) ||
              `Codex app-server exited with ${
                signal ? `signal ${signal}` : `code ${code}`
              }`,
          });
        } else if (!sawTerminalEvent) {
          args.emit({
            type: "error",
            message: "Codex app-server exited without completing the turn.",
          });
        }
        resolve();
      });

      send({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "buildover",
            title: "Buildover",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
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
