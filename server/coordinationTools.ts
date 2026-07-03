import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  createChat,
  findCoordinatorChat,
  listChats,
  readChat,
  setWorktreeInfo,
  toSummary,
} from "./chats.js";
import { contextDir } from "./repos.js";
import {
  ensureWorktree,
  mergeWorktreeBack,
  shouldUseWorktree,
} from "./worktrees.js";
import {
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
} from "./plans.js";
import { getSession, tryGetSession } from "./sessions.js";
import type {
  ChatEvent,
  ChatKind,
  Model,
  PermissionMode,
  PlanTicket,
} from "../src/types.js";
import { SUBAGENT_MODEL } from "../src/types.js";

// In-process MCP server exposing the agent-coordination toolset. Registered
// for coordinator and subagent chats (delegation can nest — a subagent may
// spawn its own helpers). Normal user chats don't get these tools.
//
// NOTE on imports: this module and sessions.ts import each other. That's fine
// in ESM because all cross-calls happen inside tool handlers at runtime, never
// during module initialization.

export interface CoordinationCtx {
  repoPath: string;
  chatId: string;
  kind: ChatKind;
  parentChatId?: string;
  task?: string;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function formatTicket(t: PlanTicket): string {
  const sub = t.subagentChatId ? ` | subagent: ${t.subagentChatId}` : "";
  return `${t.order + 1}. [${t.status}] ${t.title} (id: ${t.id}${sub})\n   ${t.description.split("\n").join("\n   ")}`;
}

// Renders one persisted chat event as compact transcript lines (an assistant
// event can yield several — one per text/tool_use block). Returns [] for
// event types that aren't useful in a transcript view.
function formatEventLines(ev: ChatEvent): string[] {
  switch (ev.type) {
    case "user_message": {
      const who =
        ev.origin && ev.origin !== "user"
          ? ev.originLabel
            ? `${ev.origin}: ${ev.originLabel}`
            : ev.origin
          : "user";
      return [`[${who}] ${ev.text.slice(0, 500)}`];
    }
    case "assistant": {
      const lines: string[] = [];
      for (const block of ev.content) {
        if (block.type === "text" && block.text.trim()) {
          lines.push(`[assistant] ${block.text.slice(0, 500)}`);
        } else if (block.type === "tool_use") {
          lines.push(`[tool] ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
        }
      }
      return lines;
    }
    case "result":
      return [`[turn result] ${ev.subtype} (${ev.numTurns} steps, ${Math.round(ev.durationMs / 1000)}s)`];
    case "error":
      return [`[error] ${ev.message}`];
    default:
      return [];
  }
}

// Pushes the current ticket list to everyone watching the repo's plans panel.
// Plans events travel over the coordinator chat's channel because the sidebar
// and panel are already subscribed to it.
export async function broadcastPlansUpdated(repoPath: string): Promise<void> {
  try {
    const coordinator = await findCoordinatorChat(repoPath);
    if (!coordinator) return;
    const tickets = await listTickets(repoPath);
    getSession(repoPath, coordinator.id).pushEvent({
      type: "plans_updated",
      chatId: coordinator.id,
      tickets,
    });
  } catch (e) {
    console.warn("[plans] broadcast failed:", e);
  }
}

// Hard cap on how many lines of any single file go into a context bundle.
// Subagents are told to pass line ranges for big files; this is the backstop
// so one giant file can't bloat the bundle (and the parent's context) unbounded.
const MAX_BUNDLE_LINES_PER_FILE = 1200;

interface SharedFileSpec {
  path: string;
  reason: string;
  startLine?: number;
  endLine?: number;
}

interface RenderedFile {
  displayPath: string;
  rangeLabel: string;
  reason: string;
  block: string;
}

// Reads one file (optionally a line range), returning it as a numbered code
// block ready to drop into a bundle. `baseDir` resolves repo-relative paths.
async function renderSharedFile(
  baseDir: string,
  spec: SharedFileSpec,
): Promise<RenderedFile> {
  const abs = isAbsolute(spec.path) ? spec.path : resolve(baseDir, spec.path);
  const rel = relative(baseDir, abs);
  const displayPath = rel && !rel.startsWith("..") ? rel : spec.path;
  const raw = await readFile(abs, "utf8");
  const allLines = raw.split("\n");

  let start = spec.startLine ?? 1;
  let end = spec.endLine ?? allLines.length;
  start = Math.max(1, start);
  end = Math.min(allLines.length, end);
  if (end < start) end = start;

  let truncated = false;
  if (end - start + 1 > MAX_BUNDLE_LINES_PER_FILE) {
    end = start + MAX_BUNDLE_LINES_PER_FILE - 1;
    truncated = true;
  }

  const width = String(end).length;
  const body = allLines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(width)}  ${line}`)
    .join("\n");

  const rangeLabel =
    start === 1 && end === allLines.length
      ? `${allLines.length} lines`
      : `lines ${start}–${end} of ${allLines.length}`;

  return {
    displayPath,
    rangeLabel: truncated ? `${rangeLabel} (truncated to ${MAX_BUNDLE_LINES_PER_FILE})` : rangeLabel,
    reason: spec.reason,
    block: "```\n" + body + "\n```",
  };
}

export function makeCoordinationMcp(
  ctx: CoordinationCtx,
): McpSdkServerConfigWithInstance {
  const spawn_subagent = tool(
    "spawn_subagent",
    [
      "Spawn a subagent in its own chat to work on a task (research, implementation, debugging — anything).",
      "It appears in the user's sidebar and starts working immediately.",
      "Pass ticketId when the task corresponds to a plan ticket — this links the ticket and moves it to in_progress.",
      "The subagent will message you back in this chat when it finishes or needs direction.",
    ].join(" "),
    {
      task: z
        .string()
        .min(10)
        .describe(
          "Full task brief for the subagent. It starts cold — include goals, relevant context/paths, and what 'done' looks like.",
        ),
      title: z
        .string()
        .min(1)
        .describe("Short chat title shown in the sidebar (e.g. 'Research: auth flow')."),
      ticketId: z
        .string()
        .optional()
        .describe("Plan ticket this subagent will work on, if any."),
      permissionMode: z
        .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
        .optional()
        .describe("Defaults to your own permission mode."),
    },
    async (args) => {
      try {
        const me = await readChat(ctx.repoPath, ctx.chatId);
        // Subagents always run on Haiku 4.5 (also enforced per-turn in runTurn):
        // fast and cheap, suited to the focused work handed off here.
        const model: Model = SUBAGENT_MODEL;
        const permissionMode =
          (args.permissionMode as PermissionMode | undefined) ??
          me?.permissionMode ??
          "default";

        const record = await createChat(ctx.repoPath, {
          model,
          permissionMode,
          title: args.title,
          kind: "subagent",
          parentChatId: ctx.chatId,
          task: args.task,
        });

        // Worktree isolation is reserved for the repo the live backend runs
        // from (in-place edits there can hot-reload/crash the backend). Every
        // other repo is worked on directly in its main tree so the user can
        // test changes immediately. A worktree failure is non-fatal: the
        // subagent simply falls back to the main tree.
        if (await shouldUseWorktree(permissionMode, ctx.repoPath)) {
          const wt = await ensureWorktree(ctx.repoPath, record.id);
          if (wt) await setWorktreeInfo(ctx.repoPath, record.id, wt);
        }

        // Let the sidebar know immediately (it's subscribed to this chat).
        getSession(ctx.repoPath, ctx.chatId).pushEvent({
          type: "chat_created",
          chatId: ctx.chatId,
          summary: toSummary(record),
        });

        if (args.ticketId) {
          const ticket = await updateTicket(ctx.repoPath, args.ticketId, {
            status: "in_progress",
            subagentChatId: record.id,
          });
          if (ticket) await broadcastPlansUpdated(ctx.repoPath);
        }

        // Kick off the subagent's first turn in the background. Errors surface
        // through its own chat's event stream.
        getSession(ctx.repoPath, record.id)
          .runTurn({ text: args.task, model, permissionMode })
          .catch((e) => console.warn("[spawn_subagent] first turn failed:", e));

        return ok(
          `Spawned subagent ${record.id} ("${record.title}"). It is now working; it will message you here when it reports back.`,
        );
      } catch (e) {
        return err(`Failed to spawn subagent: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const send_message_to_subagent = tool(
    "send_message_to_subagent",
    "Send a message to one of your subagents (feedback, course-corrections, follow-up questions). Delivered as a turn in its chat; if it's mid-turn the message is queued and delivered when the current turn ends.",
    {
      chatId: z.string().describe("The subagent's chat id"),
      message: z.string().min(1),
    },
    async (args) => {
      try {
        const record = await readChat(ctx.repoPath, args.chatId);
        if (!record) return err(`No chat ${args.chatId} in this repository.`);
        await getSession(ctx.repoPath, args.chatId).deliverMessage({
          text: `[Coordinator ${ctx.chatId}] ${args.message}`,
          origin: "system",
          originLabel: "Coordinator",
        });
        return ok(`Message delivered to ${args.chatId}.`);
      } catch (e) {
        return err(`Failed to send: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const stop_subagent = tool(
    "stop_subagent",
    "Interrupt a subagent's current turn (it stops what it's doing; the chat remains and can be resumed with send_message_to_subagent).",
    { chatId: z.string() },
    async (args) => {
      const session = tryGetSession(ctx.repoPath, args.chatId);
      if (!session) return ok(`Subagent ${args.chatId} has no active session — nothing to stop.`);
      session.interrupt();
      return ok(`Interrupted ${args.chatId}.`);
    },
  );

  const read_subagent = tool(
    "read_subagent",
    "Inspect a subagent: current status plus the tail of its transcript (recent messages and tool calls). Use this to check progress or review work.",
    {
      chatId: z.string(),
      maxEvents: z.number().int().min(1).max(200).optional()
        .describe("How many recent transcript events to include (default 30)."),
    },
    async (args) => {
      const record = await readChat(ctx.repoPath, args.chatId);
      if (!record) return err(`No chat ${args.chatId} in this repository.`);
      const lines: string[] = [
        `Chat ${record.id} ("${record.title}")`,
        `Status: ${record.status}${record.task ? ` | Task: ${record.task.slice(0, 200)}` : ""}`,
        `--- transcript tail ---`,
      ];
      const tail = record.events.slice(-(args.maxEvents ?? 30));
      for (const ev of tail) lines.push(...formatEventLines(ev));
      return ok(lines.join("\n"));
    },
  );

  const list_subagents = tool(
    "list_subagents",
    "List the subagents you've spawned in this repository, with their status and task.",
    {},
    async () => {
      const chats = await listChats(ctx.repoPath);
      const mine = chats.filter((c) => c.parentChatId === ctx.chatId);
      if (mine.length === 0) {
        return ok("You have no subagents yet. Use spawn_subagent to delegate work.");
      }
      return ok(
        mine
          .map((c) => `- ${c.id} [${c.status}] "${c.title}"${c.task ? ` — ${c.task.slice(0, 120)}` : ""}`)
          .join("\n"),
      );
    },
  );

  // ---- Plan / ticket tools ----

  const create_ticket = tool(
    "create_ticket",
    "Add a ticket to the repository's plan board (shown to the user beside the coordinator chat). A ticket is one fully self-contained piece of work — like a coding ticket, never a todo-style step. Never create multiple tickets for the same piece of work; whoever picks it up can split execution internally. New tickets start as drafts awaiting the user's approval. You are recorded as the ticket's author — if the user sends feedback on it from the panel before a worker is linked, that feedback arrives in this chat.",
    {
      title: z.string().min(3),
      description: z
        .string()
        .min(10)
        .describe("Technical specification (markdown), written for the agent that will implement it: concrete files, symbols, data structures, approach, and acceptance criteria — rich enough that a fresh agent could pick it up cold."),
      humanDescription: z
        .string()
        .min(10)
        .describe("Plain-language version (markdown), written strictly for the user: the high-level business logic of the change and any big-picture structural shifts that matter — core concepts only, no file paths, function names, or variable names. Shown to the user by default."),
      order: z.number().int().min(0).optional()
        .describe("Insert position in the priority list (0 = top). Appends when omitted."),
    },
    async (args) => {
      const ticket = await createTicket(ctx.repoPath, {
        title: args.title,
        description: args.description,
        humanDescription: args.humanDescription,
        order: args.order,
        createdByChatId: ctx.chatId,
      });
      await broadcastPlansUpdated(ctx.repoPath);
      return ok(`Created draft ticket ${ticket.id} at position ${ticket.order + 1}.`);
    },
  );

  const update_ticket = tool(
    "update_ticket",
    [
      "Update a plan ticket: edit title/description, reorder, or change status.",
      "Statuses: draft → approved (user's call, but apply it on their behalf when they approve conversationally) → in_progress → agent_done (you judged the work complete) → done (user's final sign-off — leave that to them) | rejected.",
    ].join(" "),
    {
      ticketId: z.string(),
      title: z.string().optional(),
      description: z.string().optional()
        .describe("Technical specification (markdown) for the implementing agent."),
      humanDescription: z.string().optional()
        .describe("Plain-language version (markdown) for the user — no code-level detail."),
      status: z
        .enum(["draft", "approved", "in_progress", "agent_done", "done", "rejected"])
        .optional(),
      order: z.number().int().min(0).optional(),
      subagentChatId: z.string().optional(),
    },
    async (args) => {
      const { ticketId, ...patch } = args;
      const ticket = await updateTicket(ctx.repoPath, ticketId, patch);
      if (!ticket) return err(`No ticket ${ticketId}.`);
      await broadcastPlansUpdated(ctx.repoPath);
      return ok(`Updated ${ticketId}: now [${ticket.status}] "${ticket.title}" at position ${ticket.order + 1}.`);
    },
  );

  const read_chat_history = tool(
    "read_chat_history",
    [
      "Read or search the complete stored transcript of a chat — your own by default.",
      "Your in-context view of this conversation may be trimmed or compacted over time, but the stored record is complete: use this to recover earlier details (decisions, file paths, exact wording) instead of guessing.",
      "Pass query to search the whole history, or offset/limit to page through it chronologically; with neither you get the most recent events.",
    ].join(" "),
    {
      chatId: z
        .string()
        .optional()
        .describe("Chat to read. Defaults to this chat (your own history)."),
      query: z
        .string()
        .optional()
        .describe("Case-insensitive substring to search for. Returns the most recent matching lines, oldest first."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Event index to start reading from (0 = oldest). Ignored when query is set."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum transcript lines to return (default 40)."),
    },
    async (args) => {
      const chatId = args.chatId ?? ctx.chatId;
      const record = await readChat(ctx.repoPath, chatId);
      if (!record) return err(`No chat ${chatId} in this repository.`);
      const limit = args.limit ?? 40;

      // Flatten the event log into transcript lines, each tagged with the
      // index of its source event so results can be paged with offset.
      const all: { idx: number; line: string }[] = [];
      record.events.forEach((ev, idx) => {
        for (const line of formatEventLines(ev)) all.push({ idx, line });
      });

      const render = (rows: { idx: number; line: string }[]) =>
        rows.map((r) => `#${r.idx} ${r.line}`).join("\n");

      if (args.query) {
        const q = args.query.toLowerCase();
        const matches = all.filter((r) => r.line.toLowerCase().includes(q));
        if (matches.length === 0) {
          return ok(`No matches for "${args.query}" in chat ${chatId} (${record.events.length} events).`);
        }
        const shown = matches.slice(-limit);
        return ok(
          [
            `${matches.length} matching line(s) for "${args.query}" in chat ${chatId} (${record.events.length} events total)${shown.length < matches.length ? `; showing the ${shown.length} most recent` : ""}:`,
            render(shown),
          ].join("\n"),
        );
      }

      const rows =
        args.offset != null
          ? all.filter((r) => r.idx >= args.offset!).slice(0, limit)
          : all.slice(-limit);
      if (rows.length === 0) return ok(`Chat ${chatId} has no transcript content in that range.`);
      const first = rows[0].idx;
      const last = rows[rows.length - 1].idx;
      return ok(
        [
          `Chat ${chatId} ("${record.title}") — events ${first}–${last} of ${record.events.length} (lines are prefixed #eventIndex; use offset to page):`,
          render(rows),
        ].join("\n"),
      );
    },
  );

  const list_tickets = tool(
    "list_tickets",
    "Read the repository's plan board: all tickets in priority order with status and description.",
    {},
    async () => {
      const tickets = await listTickets(ctx.repoPath);
      if (tickets.length === 0) return ok("The plan board is empty.");
      return ok(tickets.map(formatTicket).join("\n\n"));
    },
  );

  // Typed as the SDK's expected tools array so heterogeneous zod schemas can
  // be pushed without the inferred-union mismatch.
  const tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]> = [
    spawn_subagent,
    send_message_to_subagent,
    stop_subagent,
    read_subagent,
    list_subagents,
    read_chat_history,
    create_ticket,
    update_ticket,
    list_tickets,
  ];

  // ---- Parent-facing tools (only for chats that have a parent) ----

  if (ctx.parentChatId) {
    const parentChatId = ctx.parentChatId;

    const report_to_parent = tool(
      "report_to_parent",
      "Send a message to the coordinator/agent that spawned you — interim findings, blockers, questions. Use mark_task_finished instead when the whole assignment is complete.",
      { message: z.string().min(1) },
      async (args) => {
        try {
          const me = await readChat(ctx.repoPath, ctx.chatId);
          await getSession(ctx.repoPath, parentChatId).deliverMessage({
            text: `[Subagent ${ctx.chatId}${ctx.task ? ` — "${ctx.task.slice(0, 80)}"` : ""}] ${args.message}`,
            origin: "subagent",
            originLabel: me?.title ?? "Subagent",
          });
          return ok("Reported to your coordinator.");
        } catch (e) {
          return err(`Failed to report: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    const mark_task_finished = tool(
      "mark_task_finished",
      "Declare your assignment complete. Notifies your coordinator for review, and moves your linked plan ticket (if any) to agent_done.",
      {
        summary: z
          .string()
          .min(10)
          .describe("What you did, key files touched, and how you verified the result."),
      },
      async (args) => {
        try {
          // Idempotence guard. Merging this subagent's edits into the live
          // backend's own code restarts that backend, which kills this very
          // turn before the tool result reaches the model — the SDK then
          // retries the turn and the model calls mark_task_finished again.
          // If our finish report already reached the parent since our last
          // instruction, this call IS that retry: acknowledge and do nothing
          // (no duplicate report, and crucially no re-merge to re-trigger the
          // restart loop).
          const me0 = await readChat(ctx.repoPath, ctx.chatId);
          const parentRecord = await readChat(ctx.repoPath, parentChatId);
          const lastInstructionTs =
            [...(me0?.events ?? [])]
              .reverse()
              .find((e) => e.type === "user_message")?.ts ?? "";
          const finishPrefix = `[Subagent ${ctx.chatId} — task finished]`;
          const alreadyReported = (parentRecord?.events ?? []).some(
            (e) =>
              e.type === "user_message" &&
              e.text.startsWith(finishPrefix) &&
              e.ts >= lastInstructionTs,
          );
          if (alreadyReported) {
            return ok(
              [
                "Your finish report was already delivered to the coordinator — an earlier mark_task_finished call completed its delivery but was interrupted (most likely by a backend restart triggered by merging your changes) before you saw its result.",
                "The assignment is wrapped up; do NOT call mark_task_finished again.",
                me0?.worktreePath
                  ? `Note: your worktree branch (${me0.worktreeBranch}) is still in place — the merge into the main tree did not complete. Leave it for the coordinator/user to resolve.`
                  : "",
              ]
                .filter(Boolean)
                .join(" "),
            );
          }

          // Move the linked ticket (matched by subagentChatId) to agent_done.
          const tickets = await listTickets(ctx.repoPath);
          const mine = tickets.find(
            (t) => t.subagentChatId === ctx.chatId && t.status === "in_progress",
          );
          if (mine) {
            await updateTicket(ctx.repoPath, mine.id, { status: "agent_done" });
            await broadcastPlansUpdated(ctx.repoPath);
          }

          // If this subagent ran in an isolated worktree, merge its edits back
          // into the main branch now. On a clean merge the worktree is torn
          // down; on conflict it is left in place for manual resolution. The
          // outcome is appended to the report so the coordinator can react.
          const me = await readChat(ctx.repoPath, ctx.chatId);
          let mergeNote = "";
          if (me?.worktreePath && me?.worktreeBranch) {
            const result = await mergeWorktreeBack(
              ctx.repoPath,
              ctx.chatId,
              me.worktreePath,
              me.worktreeBranch,
            );
            switch (result.status) {
              case "merged":
                mergeNote = `\n\n[worktree] Edits on branch ${result.branch} merged into the main branch; worktree cleaned up.`;
                await setWorktreeInfo(ctx.repoPath, ctx.chatId, null);
                break;
              case "no_changes":
                mergeNote = `\n\n[worktree] No file changes to merge; worktree cleaned up.`;
                await setWorktreeInfo(ctx.repoPath, ctx.chatId, null);
                break;
              case "conflict":
                mergeNote = `\n\n[worktree] ⚠️ MERGE CONFLICT — branch ${result.branch} could not be auto-merged into the main branch and was NOT applied. The worktree (${result.path}) and branch are left in place for manual resolution.\nDetails:\n${result.detail}`;
                break;
              case "error":
                mergeNote = `\n\n[worktree] Merge attempt failed: ${result.detail}. The worktree and branch are left in place.`;
                break;
            }
          }

          await getSession(ctx.repoPath, parentChatId).deliverMessage({
            text: `[Subagent ${ctx.chatId} — task finished]${mine ? ` (ticket ${mine.id} → agent_done)` : ""}\n\n${args.summary}${mergeNote}`,
            origin: "subagent",
            originLabel: me?.title ?? "Subagent",
          });
          return ok(
            `Marked finished and notified your coordinator.${mergeNote ? ` Worktree merge result:${mergeNote}` : ""} Stay responsive — they may come back with review feedback in this chat.`,
          );
        } catch (e) {
          return err(`Failed to mark finished: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    const share_files_with_parent = tool(
      "share_files_with_parent",
      [
        "Hand your coordinator the actual relevant code so it can reason about it directly — not just your summary of it.",
        "Use this after research/exploration: pick the files (and the specific line ranges) that matter, say why each is relevant, and they're written to a context bundle the coordinator reads.",
        "The coordinator runs on a stronger model and does the deep thinking; your job is to find and curate the right context for it. Be selective — share what's relevant, with tight line ranges for large files, not whole directories.",
      ].join(" "),
      {
        headline: z
          .string()
          .min(3)
          .describe("One line: what this context is and the question it helps answer."),
        notes: z
          .string()
          .optional()
          .describe(
            "Optional findings or a map of how the pieces fit together — the connective tissue the raw files don't show.",
          ),
        files: z
          .array(
            z.object({
              path: z.string().describe("File path (repo-relative or absolute)."),
              reason: z
                .string()
                .min(3)
                .describe("Why this file/section is relevant — your curation insight."),
              startLine: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe("First line to include (1-based). Omit to include from the top."),
              endLine: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe("Last line to include. Omit to include to the end. Use ranges for large files."),
            }),
          )
          .min(1)
          .max(40)
          .describe("The relevant files, most important first."),
      },
      async (args) => {
        try {
          const me = await readChat(ctx.repoPath, ctx.chatId);
          const baseDir = me?.worktreePath ?? ctx.repoPath;

          const rendered: RenderedFile[] = [];
          const failures: string[] = [];
          for (const spec of args.files as SharedFileSpec[]) {
            try {
              rendered.push(await renderSharedFile(baseDir, spec));
            } catch (e) {
              failures.push(`${spec.path}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          if (rendered.length === 0) {
            return err(
              `Could not read any of the files you listed:\n${failures.join("\n")}`,
            );
          }

          // Assemble the bundle document.
          const header = [
            `# Context bundle from subagent ${ctx.chatId}`,
            ctx.task ? `**Task:** ${ctx.task}` : "",
            `**Headline:** ${args.headline}`,
            args.notes ? `\n**Notes:**\n\n${args.notes}` : "",
            failures.length ? `\n**Could not read:** ${failures.join("; ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");

          const body = rendered
            .map(
              (f) =>
                `## ${f.displayPath} — ${f.reason}\n_(${f.rangeLabel})_\n\n${f.block}`,
            )
            .join("\n\n");

          const dir = contextDir(ctx.repoPath);
          await mkdir(dir, { recursive: true });
          const bundlePath = join(dir, `${ctx.chatId}-${Date.now()}.md`);
          await writeFile(bundlePath, `${header}\n\n${body}\n`, "utf8");

          // The message the coordinator sees: headline, notes, an index of what's
          // in the bundle, and the path to read for the full code.
          const index = rendered
            .map((f) => `- \`${f.displayPath}\` (${f.rangeLabel}) — ${f.reason}`)
            .join("\n");
          const message = [
            `[Subagent ${ctx.chatId} — shared context] ${args.headline}`,
            args.notes ? `\n${args.notes}` : "",
            `\nRelevant files (full contents written to the bundle below — **Read that file** to see the actual code):`,
            index,
            failures.length ? `\nCould not read: ${failures.join("; ")}` : "",
            `\nContext bundle: ${bundlePath}`,
          ]
            .filter(Boolean)
            .join("\n");

          await getSession(ctx.repoPath, parentChatId).deliverMessage({
            text: message,
            origin: "subagent",
            originLabel: me?.title ?? "Subagent",
          });

          return ok(
            `Shared ${rendered.length} file(s) with your coordinator (bundle: ${bundlePath}).${failures.length ? ` ${failures.length} file(s) could not be read.` : ""}`,
          );
        } catch (e) {
          return err(`Failed to share files: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    tools.push(report_to_parent, mark_task_finished, share_files_with_parent);
  }

  return createSdkMcpServer({
    name: "buildover-agents",
    version: "1.0.0",
    tools,
  });
}

export { getTicket };
