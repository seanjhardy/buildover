/**
 * masterTools.ts — the cross-repo toolset for the Master chat (see master.ts).
 *
 * Registered as the in-process MCP server "buildover-master", and only for the
 * one chat whose kind is "master". Everything here is deliberately cross-repo:
 * the per-repo coordination toolset (coordinationTools.ts) is scoped to its own
 * repo, which is exactly what the Master is not.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readChat, setKeepWarm, setUserFinished } from "./chats.js";
import { formatEventLines } from "./coordinationTools.js";
import { addToGrid, createGridChat, listGridChats, removeFromGrid } from "./grid.js";
import {
  keepWarmHoursLeft,
  listChatsEverywhere,
  warmMinutesLeft,
  type AnyChatEntry,
} from "./master.js";
import { getRepoMeta, listRecents } from "./repos.js";
import { getSession } from "./sessions.js";
import { DEFAULT_MODEL, KEEP_WARM_BUDGET_HOURS } from "../src/types.js";
import type { Model } from "../src/types.js";

export interface MasterCtx {
  repoPath: string;
  chatId: string;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** "3m" / "2h" / "4d" since an ISO timestamp. */
function ago(iso: string): string {
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return "?";
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

/** One chat as a compact status line for the Master's context. */
function formatChatLine(e: AnyChatEntry, onGrid: Set<string>): string {
  const { chat } = e;
  const warm = warmMinutesLeft(chat.lastApiAt);
  const warmLabel = warm == null ? "cold" : `warm ${warm}m left`;
  const flags = [
    chat.kind === "coordinator" ? "coordinator" : null,
    chat.kind === "subagent" ? `subagent of ${chat.parentChatId}` : null,
    chat.keepWarm
      ? `keep-warm ${keepWarmHoursLeft(chat.keepWarmUntil) ?? 0}h of budget left`
      : null,
    onGrid.has(chat.id) ? "on grid" : null,
    chat.queuePaused ? "queue paused" : null,
    chat.queuedTurn ? "turn queued" : null,
  ].filter(Boolean);
  return [
    `- ${e.repoName} | "${chat.title}" | ${chat.status} | last activity ${ago(chat.updatedAt)} | ${warmLabel}`,
    `  id: ${chat.id} | repoPath: ${e.repoPath} | model: ${chat.model}${flags.length ? ` | ${flags.join(", ")}` : ""}`,
    chat.preview ? `  latest: ${chat.preview.slice(0, 240).replace(/\s+/g, " ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function makeMasterMcp(ctx: MasterCtx): McpSdkServerConfigWithInstance {
  const list_chats = tool(
    "list_chats",
    [
      "List every chat across every repo buildover knows about, newest activity first.",
      "Each line carries the chat's id and repoPath (needed by the other tools), its status, how long since it was last active, whether its prompt cache is still warm and how many minutes of warmth are left, whether keep-warm pings are on, and a preview of the latest message.",
      "Call this whenever you need the current state of the user's work — it is cheap and always current.",
    ].join(" "),
    {
      repoPath: z
        .string()
        .optional()
        .describe("Only chats in this repo. Omit for every repo."),
      includeSubagents: z
        .boolean()
        .optional()
        .describe("Include subagent chats spawned by other agents (default false)."),
      includeFinished: z
        .boolean()
        .optional()
        .describe("Include chats the user marked finished (default false)."),
      limit: z.number().int().min(1).max(200).optional().describe("Default 40."),
    },
    async (args) => {
      const all = await listChatsEverywhere({
        includeSubagents: args.includeSubagents,
        includeFinished: args.includeFinished,
      });
      const filtered = args.repoPath
        ? all.filter((e) => e.repoPath === args.repoPath)
        : all;
      if (filtered.length === 0) return ok("No chats match.");
      const grid = await listGridChats().catch(() => []);
      const onGrid = new Set(grid.map((g) => g.chatId));
      const limit = args.limit ?? 40;
      const shown = filtered.slice(0, limit);
      return ok(
        [
          `${filtered.length} chat(s)${shown.length < filtered.length ? `, showing ${shown.length}` : ""}:`,
          ...shown.map((e) => formatChatLine(e, onGrid)),
        ].join("\n"),
      );
    },
  );

  const read_chat = tool(
    "read_chat",
    [
      "Read or search the stored transcript of any chat in any repo — this is how you find out what another agent actually did.",
      "Pass query to search the whole history, or offset/limit to page through it chronologically; with neither you get the most recent events.",
      "Pass your own chatId to recover earlier details from this conversation after it has been trimmed or compacted.",
    ].join(" "),
    {
      chatId: z.string().describe("Chat to read (from list_chats)."),
      repoPath: z
        .string()
        .optional()
        .describe("Repo the chat lives in (from list_chats). Omit for your own chat."),
      query: z
        .string()
        .optional()
        .describe("Case-insensitive substring to search for. Returns the most recent matching lines."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Event index to start from (0 = oldest). Ignored when query is set."),
      limit: z.number().int().min(1).max(200).optional().describe("Max lines (default 40)."),
    },
    async (args) => {
      const repoPath = args.repoPath ?? ctx.repoPath;
      const record = await readChat(repoPath, args.chatId).catch(() => null);
      if (!record) return err(`No chat ${args.chatId} in ${repoPath}.`);
      const limit = args.limit ?? 40;

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
          return ok(`No matches for "${args.query}" in "${record.title}" (${record.events.length} events).`);
        }
        const shown = matches.slice(-limit);
        return ok(
          [
            `${matches.length} matching line(s) for "${args.query}" in "${record.title}"${shown.length < matches.length ? `; showing the ${shown.length} most recent` : ""}:`,
            render(shown),
          ].join("\n"),
        );
      }

      const rows =
        args.offset != null
          ? all.filter((r) => r.idx >= args.offset!).slice(0, limit)
          : all.slice(-limit);
      if (rows.length === 0) return ok(`Chat ${args.chatId} has no transcript content in that range.`);
      return ok(
        [
          `"${record.title}" (${record.status}, ${repoPath}) — events ${rows[0].idx}–${rows[rows.length - 1].idx} of ${record.events.length} (lines prefixed #eventIndex; use offset to page):`,
          render(rows),
        ].join("\n"),
      );
    },
  );

  const send_to_chat = tool(
    "send_to_chat",
    [
      "Send a message to another chat — this is how you delegate work or ask an agent for a status update.",
      "It arrives in that chat labelled as coming from you (not from the user) and runs as soon as that chat is free; a chat mid-turn queues it.",
      "The agent's reply appears in its own chat, not here — read it back with read_chat.",
      "Be explicit about what you want and that the user is not the sender.",
    ].join(" "),
    {
      chatId: z.string(),
      repoPath: z.string(),
      message: z.string().min(1),
    },
    async (args) => {
      const record = await readChat(args.repoPath, args.chatId).catch(() => null);
      if (!record) return err(`No chat ${args.chatId} in ${args.repoPath}.`);
      try {
        await getSession(args.repoPath, args.chatId).deliverMessage({
          text: args.message,
          origin: "system",
          originLabel: "Master",
        });
      } catch (e) {
        return err(`Delivery failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return ok(
        `Delivered to "${record.title}" (${args.chatId}). Read its reply later with read_chat.`,
      );
    },
  );

  const set_keep_warm = tool(
    "set_keep_warm",
    [
      "Turn keep-warm pings on or off for another chat.",
      "A chat with keep-warm on is pinged every 55 minutes so its prompt cache never expires, which makes the user's next message there a cheap cache read instead of a full re-send at cache-write price.",
      `Warmth is a budget, not a switch: turning it on buys ${KEEP_WARM_BUDGET_HOURS} hours of pings, after which the chat goes cold on its own. Turning it on again on a chat that is already warm leaves its remaining budget alone.`,
      "It only pays off if the user actually returns to that chat within a few hours: switch it on for chats they're clearly mid-task in, and off for ones that look finished.",
      "A chat whose cache has already gone cold is left alone until its next real message.",
    ].join(" "),
    {
      chatId: z.string(),
      repoPath: z.string(),
      enabled: z.boolean(),
      reason: z
        .string()
        .optional()
        .describe("Short note on why — surfaced in the server log for the user."),
    },
    async (args) => {
      const record = await setKeepWarm(args.repoPath, args.chatId, args.enabled).catch(
        () => null,
      );
      if (!record) return err(`No chat ${args.chatId} in ${args.repoPath}.`);
      await getSession(args.repoPath, args.chatId)
        .syncKeepWarm()
        .catch(() => undefined);
      console.log(
        `[master] keep-warm ${args.enabled ? "on" : "off"} for "${record.title}" (${args.chatId})${args.reason ? `: ${args.reason}` : ""}`,
      );
      const warm = warmMinutesLeft(record.cost?.lastApiAt);
      const budget = keepWarmHoursLeft(record.keepWarmUntil);
      return ok(
        `Keep-warm ${args.enabled ? `on for ${budget ?? KEEP_WARM_BUDGET_HOURS}h` : "off"} for "${record.title}". Cache is currently ${
          warm == null ? "cold (pings resume after its next real message)" : `warm, ${warm}m left`
        }.`,
      );
    },
  );

  const set_finished = tool(
    "set_finished",
    [
      "Mark another chat finished, or un-mark one.",
      "Finished is the user's 'this is done' state: the chat drops out of list_chats (pass includeFinished to see it again) and shows as finished on the grid.",
      "It is a visibility state, not an archive — a finished chat is still readable with read_chat and can still be messaged with send_to_chat, which un-finishing it first is not required for.",
      "Marking a chat finished also switches its keep-warm pings off, since there is no point paying to keep a done chat's cache alive. Un-marking does not switch warmth back on — use set_keep_warm if the user is picking the work back up.",
      "Only mark a chat finished when the work in it is actually complete or abandoned, not merely idle.",
    ].join(" "),
    {
      chatId: z.string(),
      repoPath: z.string(),
      enabled: z.boolean().describe("true marks the chat finished, false un-marks it."),
      reason: z
        .string()
        .optional()
        .describe("Short note on why — surfaced in the server log for the user."),
    },
    async (args) => {
      const record = await setUserFinished(args.repoPath, args.chatId, args.enabled).catch(
        () => null,
      );
      if (!record) return err(`No chat ${args.chatId} in ${args.repoPath}.`);
      // Finishing a chat drops its keep-warm pings for good: syncKeepWarm would
      // stop them while it stays finished, but clearing the flag means
      // un-finishing doesn't silently resume paying for them.
      const warmDropped = args.enabled && record.keepWarm;
      if (warmDropped) await setKeepWarm(args.repoPath, args.chatId, false).catch(() => undefined);
      await getSession(args.repoPath, args.chatId)
        .syncKeepWarm()
        .catch(() => undefined);
      console.log(
        `[master] ${args.enabled ? "finished" : "un-finished"} "${record.title}" (${args.chatId})${args.reason ? `: ${args.reason}` : ""}`,
      );
      return ok(
        args.enabled
          ? `Marked "${record.title}" finished${warmDropped ? " and turned its keep-warm off" : ""}. It is out of the default list_chats; read_chat and send_to_chat still work on it.`
          : `Un-marked "${record.title}" — it is back in the default list_chats. Keep-warm is still off; use set_keep_warm if the user is returning to it.`,
      );
    },
  );

  const set_on_grid = tool(
    "set_on_grid",
    [
      "Put an existing chat onto the user's grid, or take it off.",
      "Taking a chat off only removes it from the grid; the chat, its transcript and its finished state are untouched.",
      "Putting a chat on the grid also un-marks it finished, the same as the user re-adding it from the grid.",
      "list_chats shows 'on grid' for chats that are on it.",
    ].join(" "),
    {
      chatId: z.string(),
      repoPath: z.string(),
      enabled: z.boolean().describe("true puts the chat on the grid, false takes it off."),
    },
    async (args) => {
      const record = await readChat(args.repoPath, args.chatId).catch(() => null);
      if (!record) return err(`No chat ${args.chatId} in ${args.repoPath}.`);
      if (args.enabled) {
        await addToGrid(args.chatId, args.repoPath);
        return ok(`"${record.title}" is on the grid.`);
      }
      const removed = await removeFromGrid(args.chatId);
      return ok(
        removed
          ? `Took "${record.title}" off the grid. The chat itself is kept.`
          : `"${record.title}" was not on the grid.`,
      );
    },
  );

  const list_repos = tool(
    "list_repos",
    "List the repos buildover knows about, most recently opened first, with how many live chats each has.",
    {},
    async () => {
      const recents = await listRecents();
      if (recents.length === 0) return ok("No repos known yet.");
      const chats = await listChatsEverywhere();
      const lines = recents.map((r) => {
        const mine = chats.filter((c) => c.repoPath === r.path);
        const attention = mine.filter(
          (c) =>
            c.chat.status === "awaiting_input" ||
            c.chat.status === "agent_done" ||
            c.chat.status === "error",
        ).length;
        const running = mine.filter((c) => c.chat.status === "running").length;
        return `- ${r.name} (${r.path}) — ${mine.length} chat(s), ${running} running, ${attention} needing attention, last opened ${ago(r.lastOpenedAt)} ago`;
      });
      return ok(lines.join("\n"));
    },
  );

  const start_chat = tool(
    "start_chat",
    [
      "Start a brand-new chat in a repo, put it on the user's grid, and send it a first message.",
      "Use this to delegate a self-contained piece of work that doesn't belong in an existing conversation. Prefer send_to_chat when a relevant chat already exists.",
      "Write the first message as a complete brief: the goal, the repo context, what 'done' looks like.",
    ].join(" "),
    {
      repoPath: z.string(),
      title: z.string().describe("Short sidebar label, e.g. 'Fix flaky auth test'."),
      message: z.string().min(1).describe("The opening brief for the new agent."),
      model: z.string().optional().describe(`Model id. Default ${DEFAULT_MODEL}.`),
    },
    async (args) => {
      const meta = await getRepoMeta(args.repoPath).catch(() => null);
      if (!meta) return err(`Unknown repo ${args.repoPath}. Use list_repos.`);
      try {
        const entry = await createGridChat({
          repoPath: args.repoPath,
          model: (args.model as Model | undefined) ?? DEFAULT_MODEL,
          permissionMode: "bypassPermissions",
          title: args.title,
        });
        await addToGrid(entry.chatId, args.repoPath);
        await getSession(args.repoPath, entry.chatId).deliverMessage({
          text: args.message,
          origin: "system",
          originLabel: "Master",
        });
        return ok(
          `Started "${args.title}" in ${meta.name} (id: ${entry.chatId}) and sent the brief. It is on the grid; read its progress with read_chat.`,
        );
      } catch (e) {
        return err(`Could not start the chat: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "buildover-master",
    version: "1.0.0",
    tools: [
      list_chats,
      read_chat,
      send_to_chat,
      set_keep_warm,
      set_finished,
      set_on_grid,
      list_repos,
      start_chat,
    ],
  });
}
