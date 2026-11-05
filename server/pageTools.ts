import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { PAGE_SERVER, type FrontPage, type PageWait } from "../src/lib/frontPage.js";

// Page tools: how an agent talks to the user through its window's front page
// instead of the chat. The handlers do little; the page is folded from these
// calls in the chat history (src/lib/frontPage.ts), so the inputs are the data.
// The handlers only validate, and report waits and closes to the session.

/** Private, per-machine pipeline config. Never part of the repo. */
export const PIPELINES_DIR =
  process.env.BUILDOVER_PIPELINES_DIR ?? join(homedir(), ".buildover", "pipelines");
export const NOTES_FILE = join(PIPELINES_DIR, "NOTES.md");

export interface PageToolHooks {
  /** The page as folded from the history so far (for patch_panel and re-showing panels). */
  getPage: () => Promise<FrontPage>;
  /** The agent parked the item. Saved at once so a message that wakes the chat can't drop it. */
  onWait?: (wait: PageWait) => void;
  /** The agent closed the item. */
  onDone?: (note: string) => void;
  notesFile?: string;
}

const ok = (text = "ok") => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

const PLAIN =
  "Write it as if explaining to a 10-year-old: short, simple sentences in everyday words. No jargon, acronyms, internal names or technical detail unless the user used them first. Every sentence must make sense on its own, without looking back: never use a short label for something (\"Dispatch didn't land\"); say what it is.";

export function createPageToolsServer(hooks: PageToolHooks) {
  const setCard = tool(
    "set_card",
    "Set this item's card: a specific title of at most five words (\"Elevation Labs login\", not \"Bug fix\"), a summary of at most eight words saying the problem or ask in plain words (\"Any user can delete other accounts\"; never priority, status or age), and 1-3 one- or two-word tags for what it is at the highest level: the app or area, and the kind of work (\"Triage\", \"Bug\", \"PR review\", \"Customer\").",
    {
      title: z.string().optional(),
      summary: z.string(),
      tags: z.array(z.string()).max(3).optional(),
    },
    async () => ok(),
  );

  const milestone = tool(
    "milestone",
    `Update the front page the user reads to understand what this item is about and where it stands. ${PLAIN} kind "issue": something the user (or whoever reported it) said is wrong or wanted, in their own words, as close to verbatim as possible. Add one per separate issue. kind "context": two or three simple sentences saying what this is about: what the thing is, what is wrong or needed, and why it matters. It replaces the previous context, so rewrite it whole when your understanding changes; it is not a history of what you did. kind "state": one sentence saying where it stands now ("Waiting for you to check it"), replacing the previous one. Update it whenever it changes.`,
    { text: z.string(), kind: z.enum(["issue", "context", "state"]) },
    async () => ok(),
  );

  const showPanel = tool(
    "show_panel",
    "Show the user a panel on the front page. Panels are how you present anything with substance: findings, a diff, data, a PR summary, a page to test. Pass content to create or replace the panel under `key`; pass only `key` to bring the latest version back to the top. Formats: markdown; html (rendered in a sandboxed iframe); url (embed a running page, e.g. a dev server or a deployed preview; use key \"preview\" for the item's live preview).",
    {
      key: z.string().describe("stable id, e.g. 'summary', 'diff', 'preview'"),
      title: z.string().optional(),
      format: z.enum(["markdown", "html", "url"]).optional(),
      content: z.string().optional(),
    },
    async ({ key, content }) => {
      const prev = (await hooks.getPage()).panels.find((p) => p.key === key);
      if (content === undefined) {
        return prev ? ok(`Showing '${key}' v${prev.version}`) : fail(`No panel '${key}' yet; pass content.`);
      }
      return ok(`Panel '${key}' v${(prev?.version ?? 0) + 1}`);
    },
  );

  const patchPanel = tool(
    "patch_panel",
    "Amend a panel without resending it: replace one exact snippet of its latest content.",
    { key: z.string(), find: z.string(), replace: z.string() },
    async ({ key, find }) => {
      const prev = (await hooks.getPage()).panels.find((p) => p.key === key);
      if (!prev) return fail(`No panel '${key}'; nothing changed.`);
      if (!prev.content.includes(find)) return fail("Snippet not found; nothing changed.");
      return ok(`Panel '${key}' v${prev.version + 1}`);
    },
  );

  const suggestOptions = tool(
    "suggest_options",
    "Offer the user 1-4 answers they can pick with one click. The first is the front page's big action button, so make it the thing you recommend (\"Send the reply\", \"Land the fix\"). They can always type a different answer. The options clear once they answer.",
    {
      options: z
        .array(z.object({ label: z.string(), detail: z.string().optional() }))
        .min(1)
        .max(4),
    },
    async () => ok(),
  );

  const wait = tool(
    "wait",
    "Park this item until a time or an event, e.g. when the user says \"come back tomorrow\" or \"wait for their reply\". It leaves the user's view until then. Say in the note what it's waiting for; give `event` precisely enough that a check can tell when it has happened.",
    {
      note: z.string().describe("what it's waiting for, shown on the card"),
      until: z.string().optional().describe("ISO time"),
      event: z.string().optional().describe("the event in words, precise enough to check"),
    },
    async ({ note, until, event }) => {
      const at = until ? new Date(until) : null;
      if (at && Number.isNaN(at.getTime()))
        return fail(`NOT SAVED: "${until}" isn't a time. Pass an ISO time like 2026-10-29T15:00:00Z. Nothing is parked; don't tell the user it is.`);
      if (at && at.getTime() <= Date.now())
        return fail(`NOT SAVED: ${at.toISOString()} is already in the past. Nothing is parked; don't tell the user it is.`);
      hooks.onWait?.({ note, ...(at ? { until: at.toISOString() } : {}), ...(event ? { event } : {}) });
      const when = at?.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      return ok(when ? `Saved: this item comes back on ${when}.` : "Saved: parked until the event happens or the user picks it back up.");
    },
  );

  const done = tool(
    "done",
    "Mark this item finished. Only when the user agrees it's finished or it no longer needs anything.",
    { note: z.string() },
    async ({ note }) => {
      hooks.onDone?.(note);
      return ok();
    },
  );

  const remember = tool(
    "remember",
    "Save a lasting preference or principle the user expresses about how they work or weigh work, so every agent and the ranking follow it. Write the principle, not their words.",
    { principle: z.string() },
    async ({ principle }) => {
      const file = hooks.notesFile ?? NOTES_FILE;
      try {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, `- ${principle.trim().replace(/\s+/g, " ")}\n`);
        return ok();
      } catch (e) {
        return fail(`Couldn't save the note: ${(e as Error).message}`);
      }
    },
  );

  return createSdkMcpServer({
    name: PAGE_SERVER,
    version: "1.0.0",
    tools: [setCard, milestone, showPanel, patchPanel, suggestOptions, wait, done, remember],
  });
}
