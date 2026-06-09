import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createChat, listChats, toSummary, readChat } from "./chats.js";
import { ensureRepo, getRepoMeta, listRecents, touchRecent } from "./repos.js";
import { getSession } from "./sessions.js";
import {
  readDashboard,
  addNote,
  updateNote,
  addTodo,
  updateTodo,
} from "./dashboard.js";
import type {
  Model,
  OrchestratorNav,
  PermissionMode,
} from "../src/types.js";

// Soft cap on how many chats the orchestrator can create per minute. Hard
// cap defends against runaway loops (e.g. a noisy room transcribing into
// repeated "create_chat" calls). When the bucket is empty the tool returns
// a structured error so the model can apologise rather than retry-spam.
const CREATE_CHAT_LIMIT_PER_MIN = 4;

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(
    private capacity: number,
    private perMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }
  take(): boolean {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + (elapsed / this.perMs) * this.capacity,
      );
      this.lastRefill = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface OrchestratorToolDeps {
  emitNav: (nav: OrchestratorNav) => void;
}

interface MakeOrchestratorMcp {
  server: McpSdkServerConfigWithInstance;
  // Reset internal rate-limit state when the user resets the orchestrator.
  resetRateLimits: () => void;
}

function ok(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function err(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

export function makeOrchestratorMcp(
  deps: OrchestratorToolDeps,
): MakeOrchestratorMcp {
  let createBucket = new TokenBucket(
    CREATE_CHAT_LIMIT_PER_MIN,
    60_000,
  );

  const list_repos = tool(
    "list_repos",
    "List repositories the user has open in their workspace and recently opened. Use this to discover which repo the user is referring to before creating or switching chats.",
    {},
    async () => {
      const recents = await listRecents();
      const lines = recents.map(
        (r) => `- ${r.name}  (path: ${r.path})  lastOpened: ${r.lastOpenedAt}`,
      );
      const body = lines.length
        ? `Recent repositories:\n${lines.join("\n")}`
        : "No recent repositories. Ask the user to open one.";
      return ok(body);
    },
  );

  const open_repo = tool(
    "open_repo",
    "Open a repository in the user's workspace and make it the active repo. Pass an absolute filesystem path. Use after list_repos to bring a recent repo to the foreground before creating chats in it.",
    {
      path: z.string().describe("Absolute filesystem path to the repo"),
    },
    async (args) => {
      try {
        const meta = await ensureRepo(args.path);
        await touchRecent(meta);
        deps.emitNav({ action: "open_repo", path: meta.path });
        return ok(`Opened repo "${meta.name}" at ${meta.path}.`);
      } catch (e) {
        return err(
          `Failed to open repo: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  const list_chats = tool(
    "list_chats",
    "List existing chats inside a given repo with their titles, statuses, and last-updated timestamps. Use this to find the chat the user is referring to before switching to it.",
    {
      repoPath: z
        .string()
        .describe("Absolute filesystem path to the repo whose chats to list"),
    },
    async (args) => {
      const meta = await getRepoMeta(args.repoPath);
      if (!meta) {
        return err(
          `Repo not found at ${args.repoPath}. Call open_repo first or list_repos to discover paths.`,
        );
      }
      const chats = await listChats(meta.path);
      if (chats.length === 0) {
        return ok(`No chats yet in "${meta.name}". You can create_chat there.`);
      }
      const lines = chats
        .slice(0, 30)
        .map(
          (c) =>
            `- [${c.id}] "${c.title}"  status:${c.status}  updated:${c.updatedAt}  preview: ${c.preview.slice(0, 80)}`,
        );
      return ok(`Chats in "${meta.name}":\n${lines.join("\n")}`);
    },
  );

  const switch_to_chat = tool(
    "switch_to_chat",
    "Navigate the user to an existing chat. Use when the user wants to resume work on something. Verify the chat exists with list_chats first.",
    {
      repoPath: z.string(),
      chatId: z.string(),
    },
    async (args) => {
      const meta = await getRepoMeta(args.repoPath);
      if (!meta) return err(`Repo not found at ${args.repoPath}.`);
      const record = await readChat(meta.path, args.chatId);
      if (!record) return err(`Chat ${args.chatId} not found.`);
      deps.emitNav({ action: "open_repo", path: meta.path });
      deps.emitNav({
        action: "switch_chat",
        repoPath: meta.path,
        chatId: args.chatId,
      });
      return ok(`Switched to chat "${record.title}".`);
    },
  );

  const create_chat = tool(
    "create_chat",
    [
      "Create a new chat in a repo and immediately fire the user's request as the first turn. THIS IS YOUR DEFAULT ACTION — use it for any coherent request, including ideation, brainstorming, design discussion, code changes, or questions about a repo.",
      "The `prompt` should be a clean, well-formed rewrite of the user's spoken request: disfluencies removed, complete sentences. Do NOT narrow, judge, or refuse the topic — pass through whatever the user asked, faithfully.",
      "Skip this tool only when the input is genuinely unintelligible (pure filler / no actionable content).",
    ].join(" "),
    {
      repoPath: z
        .string()
        .describe("Absolute filesystem path to the repo. Required."),
      prompt: z
        .string()
        .min(8)
        .describe(
          "Cleaned, well-formed first user message for the new chat. Rewrite the user's spoken input into clear instructions for a coding agent.",
        ),
      model: z
        .enum(["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"])
        .optional()
        .describe(
          "Model for the new chat. Defaults to claude-opus-4-8 if omitted.",
        ),
      permissionMode: z
        .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
        .optional(),
    },
    async (args) => {
      if (!createBucket.take()) {
        return err(
          "Rate limit: too many chats created in the last minute. Tell the user you're holding off; they can retry shortly or use the existing chat.",
        );
      }
      const meta = await getRepoMeta(args.repoPath);
      if (!meta) {
        return err(
          `Repo not found at ${args.repoPath}. Call open_repo first.`,
        );
      }
      const model: Model = args.model ?? "claude-opus-4-8";
      const permissionMode: PermissionMode = args.permissionMode ?? "default";
      const record = await createChat(meta.path, { model, permissionMode });

      // Emit nav before kicking off the turn so the UI is already on the new
      // chat by the time messages start streaming.
      deps.emitNav({ action: "open_repo", path: meta.path });
      deps.emitNav({
        action: "create_chat",
        repoPath: meta.path,
        chatId: record.id,
      });

      const session = getSession(meta.path, record.id);
      // Fire-and-forget: the chat's own WS subscribers see the streaming turn.
      session
        .runTurn({ text: args.prompt, model, permissionMode })
        .catch(() => {
          // The chat's own error event surfaces to its subscribers.
        });

      const summary = toSummary(record);
      return ok(
        `Created chat ${summary.id} in "${meta.name}" and started running the rewritten prompt. Tell the user what you started.`,
      );
    },
  );

  // ── Dashboard tools ──────────────────────────────────────────────────────

  const read_dashboard = tool(
    "read_dashboard",
    "Read the user's global dashboard — their pinned notes and todo items. Use this when the user asks what's on their list, what they need to do, or to check their notes.",
    {},
    async () => {
      const db = await readDashboard();
      const lines: string[] = [];

      if (db.notes.length === 0 && db.todos.length === 0) {
        return ok("Dashboard is empty.");
      }

      if (db.notes.length > 0) {
        lines.push("## Notes");
        for (const n of db.notes) {
          lines.push(`[${n.id}]${n.pinned ? " 📌" : ""} ${n.content}`);
        }
      }

      if (db.todos.length > 0) {
        lines.push("## Todos");
        for (const t of db.todos) {
          const status = t.done ? "✅" : t.priority === "high" ? "🔴" : t.priority === "medium" ? "🟡" : "⚪";
          lines.push(`[${t.id}] ${status} ${t.text}`);
        }
      }

      return ok(lines.join("\n"));
    },
  );

  const write_dashboard = tool(
    "write_dashboard",
    "Add or update items on the user's global dashboard. Use this to add a note, add a todo, mark a todo done, or update existing items. Always confirm with the user what you added.",
    {
      action: z.enum(["add_note", "add_todo", "complete_todo", "update_note", "update_todo"])
        .describe("The operation to perform"),
      id: z.string().optional()
        .describe("ID of the existing note or todo to update/complete. Required for update_note, update_todo, complete_todo."),
      content: z.string().optional()
        .describe("Note content (markdown). Required for add_note and update_note."),
      text: z.string().optional()
        .describe("Todo text. Required for add_todo and update_todo."),
      priority: z.enum(["low", "medium", "high"]).optional()
        .describe("Todo priority. Default: medium."),
      pinned: z.boolean().optional()
        .describe("Whether to pin the note. Default: false."),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "add_note": {
            if (!args.content) return err("content required for add_note");
            const note = await addNote(args.content, args.pinned ?? false);
            return ok(`Added note [${note.id}].`);
          }
          case "add_todo": {
            if (!args.text) return err("text required for add_todo");
            const todo = await addTodo(args.text, args.priority ?? "medium");
            return ok(`Added todo [${todo.id}]: "${todo.text}"`);
          }
          case "complete_todo": {
            if (!args.id) return err("id required for complete_todo");
            const done = await updateTodo(args.id, { done: true });
            if (!done) return err(`Todo ${args.id} not found`);
            return ok(`Marked todo [${args.id}] as done.`);
          }
          case "update_note": {
            if (!args.id) return err("id required for update_note");
            const note = await updateNote(args.id, {
              content: args.content,
              pinned: args.pinned,
            });
            if (!note) return err(`Note ${args.id} not found`);
            return ok(`Updated note [${args.id}].`);
          }
          case "update_todo": {
            if (!args.id) return err("id required for update_todo");
            const todo = await updateTodo(args.id, {
              text: args.text,
              priority: args.priority,
            });
            if (!todo) return err(`Todo ${args.id} not found`);
            return ok(`Updated todo [${args.id}].`);
          }
        }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const server = createSdkMcpServer({
    name: "buildover-orchestrator",
    version: "0.1.0",
    tools: [list_repos, open_repo, list_chats, switch_to_chat, create_chat, read_dashboard, write_dashboard],
  });

  return {
    server,
    resetRateLimits: () => {
      createBucket = new TokenBucket(CREATE_CHAT_LIMIT_PER_MIN, 60_000);
    },
  };
}
