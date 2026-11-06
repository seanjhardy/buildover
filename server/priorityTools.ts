/**
 * priorityTools.ts — set_priority, wait_for and snooze (see priority.ts).
 *
 * Two flavours: the Master's, which take any chat's id and repoPath, and every
 * chat's own, which act on itself. A chat sets its own priority only from what
 * the user tells it; the tier is the user's call and sticks until changed.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { addWait, setTier, snooze } from "./priority.js";
import { CHAT_TIERS } from "../src/types.js";
import type { ChatPriority, ChatRecord } from "../src/types.js";

type Scope = { self: { repoPath: string; chatId: string } } | { self?: undefined };

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** "low", "waiting on PR review (watching 1), back 2026-11-10 09:00Z". */
export function priorityLabel(p: ChatPriority): string {
  if (p.back) return `back from waiting: ${p.back.because}`;
  const parts: string[] = [p.tier];
  if (p.waitingOn) parts.push(`on ${p.waitingOn}`);
  if (p.waits?.length) parts.push(`(watching ${p.waits.map((w) => w.kind).join(", ")})`);
  if (p.resurfaceAt) parts.push(`until ${p.resurfaceAt.slice(0, 16).replace("T", " ")}Z`);
  return parts.join(" ");
}

const TIERS_EXPLAINED =
  "Tiers order the user's 'needs you' list on the grid in sections, overriding its automatic order: urgent and high at the top, medium with untiered chats, low below them, and waiting at the bottom until what it waits on happens or its date comes, when it comes back up flagged.";

export function makePriorityTools(scope: Scope) {
  const whose = scope.self ? "this chat" : "another chat";
  // The Master names the chat; a chat's own tools don't ask.
  const target: Record<string, z.ZodString> = scope.self
    ? {}
    : { chatId: z.string(), repoPath: z.string() };
  const at = (args: object) => {
    const a = args as { chatId?: string; repoPath?: string };
    return scope.self ?? { chatId: a.chatId!, repoPath: a.repoPath! };
  };
  const when = (record: ChatRecord | null, done: (r: ChatRecord) => string) =>
    record ? ok(done(record)) : err("No such chat.");
  const guard = async (run: () => Promise<ReturnType<typeof ok>>) => {
    try {
      return await run();
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  };
  const onlyWhenTold = scope.self
    ? "Only use it when the user tells you something about this chat's priority or what it's waiting on ('this can wait', 'urgent', 'park this until Dan replies'); never decide it yourself."
    : "Only when the user asks (e.g. 'push those to low'). Call once per chat.";

  const set_priority = tool(
    "set_priority",
    [`Set or clear the user's priority tier on ${whose}.`, TIERS_EXPLAINED, onlyWhenTold].join(" "),
    {
      ...target,
      tier: z
        .enum(["none", ...CHAT_TIERS] as [string, ...string[]])
        .describe("The tier, or 'none' to clear it back to the automatic order. For waiting with something to watch, use wait_for."),
      waitingOn: z.string().optional().describe("For 'waiting': what it's waiting on, in a few words."),
      resurfaceAt: z.string().optional().describe("For 'waiting': ISO date/time it comes back up the list."),
    },
    (args) =>
      guard(async () => {
        const { chatId, repoPath } = at(args);
        const record = await setTier(repoPath, chatId, args.tier === "none" ? null : args);
        return when(record, (r) =>
          r.priority ? `"${r.title}" is now ${priorityLabel(r.priority)}.` : `"${r.title}" is back in the automatic order.`,
        );
      }),
  );

  const wait_for = tool(
    "wait_for",
    [
      `Put ${whose} in the waiting tier, watching for something outside buildover; when it happens the chat comes back up the user's list, flagged with what happened. The chat's agent is not woken.`,
      "kind 'github' watches a PR (checked hourly) for reviews, approvals, comments, merge or close; target is its URL.",
      "kind 'slack' / 'email' has a read-only agent look every 3 hours for a reply or news; target says who or what thread in searchable words ('Dan's reply in #infra about the deploy').",
      "Leave kind out to just wait until resurfaceAt. Calling it again on a waiting chat adds another watch.",
      onlyWhenTold,
    ].join(" "),
    {
      ...target,
      kind: z.enum(["github", "slack", "email"]).optional(),
      target: z.string().optional().describe("The PR URL, or who/what thread for slack/email."),
      note: z.string().optional().describe("What it's waiting on, in the user's words, shown on the card."),
      resurfaceAt: z.string().optional().describe("ISO date/time it comes back up the list even if nothing happens."),
    },
    (args) =>
      guard(async () => {
        if (!args.kind && !args.resurfaceAt) return err("Give a kind and target to watch, a resurfaceAt, or both.");
        const { chatId, repoPath } = at(args);
        const record = await addWait(repoPath, chatId, args);
        return when(record, (r) => `"${r.title}" is ${priorityLabel(r.priority!)}.`);
      }),
  );

  const snooze_chat = tool(
    "snooze",
    [
      `Snooze ${whose} off the user's 'needs you' list until a time, or wake it back up (until omitted).`,
      "Unlike waiting it watches nothing and keeps its tier; it just stays out of sight until then.",
      onlyWhenTold,
    ].join(" "),
    {
      ...target,
      until: z.string().optional().describe("ISO date/time it comes back; omit to unsnooze now."),
    },
    (args) =>
      guard(async () => {
        const { chatId, repoPath } = at(args);
        const record = await snooze(repoPath, chatId, args.until ?? null);
        return when(record, (r) =>
          r.snoozedUntil ? `Snoozed "${r.title}" until ${r.snoozedUntil}.` : `"${r.title}" is back on the list.`,
        );
      }),
  );

  return [set_priority, wait_for, snooze_chat];
}
