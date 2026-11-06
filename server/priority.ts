/**
 * priority.ts — the user's priority tiers on chats, and the watcher behind
 * the "waiting" tier.
 *
 * A waiting chat can watch for things outside buildover: a GitHub PR (looked
 * at hourly through `gh`, so no tokens and no rate limits to speak of), or a
 * Slack / email reply (one small read-only connector agent every 3 hours,
 * checking every open wait at once, and only when there are any). It can also
 * carry a date. When a wait comes good or the date comes round, the chat is
 * flagged "back" with why and rises up the "needs you" list. Its agent is not
 * woken: the user decides what to do next.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { normalisePriority, setSnoozed, updatePriority } from "./chats.js";
import { listChatsEverywhere } from "./master.js";
import { agentFetch, NeedsSignIn } from "./pipelineAgentFetch.js";
import type { ChatPriority, ChatRecord, ChatTier, ChatWait, ChatWaitKind } from "../src/types.js";

const execFileAsync = promisify(execFile);

const TICK_MS = 5 * 60_000;
const PR_EVERY_MS = 60 * 60_000;
const CONNECTOR_EVERY_MS = 3 * 60 * 60_000;
const CONNECTOR_SERVER: Record<Exclude<ChatWaitKind, "github">, string> = {
  slack: "slack",
  email: "gmail",
};

// ── Setting tiers ──

/** Sets the chat's tier (null clears it). Keeping the same tier keeps its
 *  place and, for waiting, what it's watching; a new tier starts afresh. */
export async function setTier(
  repoPath: string,
  chatId: string,
  input: unknown,
): Promise<ChatRecord | null> {
  const next = input == null ? null : normalisePriority(input);
  return updatePriority(repoPath, chatId, (old) => {
    if (!next) return null;
    if (old?.tier !== next.tier) return next;
    const kept: ChatPriority = { ...next };
    if (old.rank != null) kept.rank = old.rank;
    // Re-waiting on a chat that's waiting: same watches, fresh note and date.
    if (next.tier === "waiting" && old.waits?.length && !old.back) kept.waits = old.waits;
    return kept;
  });
}

/** "https://github.com/o/r/pull/12" from that URL or "o/r#12"; null otherwise. */
export function prUrl(target: string): string | null {
  const m =
    target.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/) ??
    target.trim().match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : null;
}

/** Puts the chat in waiting, watching for `kind` on `target` (and/or until a
 *  date). Adds to what it's already watching if it's already waiting. */
export async function addWait(
  repoPath: string,
  chatId: string,
  args: { kind?: ChatWaitKind; target?: string; note?: string; resurfaceAt?: string },
): Promise<ChatRecord | null> {
  let wait: ChatWait | null = null;
  if (args.kind) {
    const target = args.kind === "github" ? prUrl(args.target ?? "") : args.target?.trim();
    if (!target) {
      throw new Error(
        args.kind === "github"
          ? "A PR wait needs the PR's URL (or owner/repo#number)."
          : "Say who or what it's waiting on.",
      );
    }
    const now = new Date().toISOString();
    wait = { id: randomUUID().slice(0, 8), kind: args.kind, target, createdAt: now };
    if (args.kind === "github") {
      // What the PR looks like now, so anything after it counts as news.
      wait.baseline = JSON.stringify(await prState(target));
      wait.checkedAt = now;
    }
  }
  const base = normalisePriority({
    tier: "waiting",
    waitingOn: args.note ?? args.target,
    resurfaceAt: args.resurfaceAt,
  });
  return updatePriority(repoPath, chatId, (old) => {
    const still = old?.tier === "waiting" && !old.back;
    const waits = [...(still ? (old.waits ?? []) : []), ...(wait ? [wait] : [])];
    return {
      ...base,
      ...(still && !base.waitingOn && old.waitingOn && { waitingOn: old.waitingOn }),
      ...(still && !base.resurfaceAt && old.resurfaceAt && { resurfaceAt: old.resurfaceAt }),
      ...(still && old.rank != null && { rank: old.rank }),
      ...(waits.length && { waits }),
    };
  });
}

/** Snoozes the chat off the "needs you" list until `until` (ISO); null wakes it. */
export async function snooze(repoPath: string, chatId: string, until: string | null) {
  let at: string | null = null;
  if (until) {
    const ms = Date.parse(until);
    if (!Number.isFinite(ms)) throw new Error("Snooze needs a date and time.");
    at = new Date(ms).toISOString();
  }
  return setSnoozed(repoPath, chatId, at);
}

/** Drag-and-drop: each chat lands in `tier` (null: untiered) at `rank`. */
export async function placeChats(
  items: { repoPath: string; chatId: string; tier: ChatTier | null; rank: number }[],
): Promise<void> {
  for (const it of items) {
    await updatePriority(it.repoPath, it.chatId, (old) => {
      if (!it.tier) return null;
      // Dropped back into waiting, it waits afresh.
      const keep = old?.tier === it.tier && !old.back ? old : { tier: it.tier };
      return { ...keep, rank: it.rank };
    });
  }
}

// ── The watcher ──

interface PrState {
  state: string;
  reviewDecision: string;
  reviews: { author: string; state: string }[];
  comments: { author: string }[];
}

async function prState(url: string): Promise<PrState> {
  const { stdout } = await execFileAsync(
    "gh",
    ["pr", "view", url, "--json", "state,reviewDecision,reviews,comments"],
    { timeout: 30_000 },
  );
  const raw = JSON.parse(stdout) as {
    state?: string;
    reviewDecision?: string;
    reviews?: { author?: { login?: string }; state?: string }[];
    comments?: { author?: { login?: string } }[];
  };
  return {
    state: raw.state ?? "",
    reviewDecision: raw.reviewDecision ?? "",
    reviews: (raw.reviews ?? []).map((r) => ({ author: r.author?.login ?? "?", state: r.state ?? "" })),
    comments: (raw.comments ?? []).map((c) => ({ author: c.author?.login ?? "?" })),
  };
}

/** What changed on a PR, in a line, or null if nothing did. */
export function prNews(url: string, before: PrState, now: PrState): string | null {
  const pr = `PR #${url.split("/").pop()}`;
  const who = (xs: { author: string }[]) => [...new Set(xs.map((x) => x.author))].join(", ");
  if (now.state !== before.state && now.state === "MERGED") return `${pr} was merged`;
  if (now.state !== before.state && now.state === "CLOSED") return `${pr} was closed`;
  const newReviews = now.reviews.slice(before.reviews.length);
  const newComments = now.comments.slice(before.comments.length);
  if (now.reviewDecision !== before.reviewDecision && now.reviewDecision === "APPROVED") {
    const by = who(newReviews.filter((r) => r.state === "APPROVED"));
    return `${pr} was approved${by ? ` by ${by}` : ""}`;
  }
  if (now.reviewDecision !== before.reviewDecision && now.reviewDecision === "CHANGES_REQUESTED") {
    const by = who(newReviews.filter((r) => r.state === "CHANGES_REQUESTED"));
    return `${pr}: changes requested${by ? ` by ${by}` : ""}`;
  }
  const news = [...newReviews, ...newComments];
  if (news.length) return `${pr}: ${news.length} new review${news.length === 1 ? "" : "s"} or comment${news.length === 1 ? "" : "s"} from ${who(news)}`;
  return null;
}

/** Flags a waiting chat back up the list, and stops its watches. */
async function markBack(repoPath: string, chatId: string, because: string) {
  await updatePriority(repoPath, chatId, (old) => {
    if (old?.tier !== "waiting" || old.back) return old ?? null;
    const { waits: _done, ...rest } = old;
    return { ...rest, back: { at: new Date().toISOString(), because } };
  });
  console.log(`[waits] back up the list (${chatId}): ${because}`);
}

/** Records when a wait was last looked at (and the PR's state then). */
async function touchWait(repoPath: string, chatId: string, waitId: string, baseline?: string) {
  const at = new Date().toISOString();
  await updatePriority(repoPath, chatId, (old) => {
    if (!old?.waits) return old ?? null;
    return {
      ...old,
      waits: old.waits.map((w) => (w.id === waitId ? { ...w, checkedAt: at, ...(baseline && { baseline }) } : w)),
    };
  });
}

interface Due {
  repoPath: string;
  chatId: string;
  title: string;
  wait: ChatWait;
}

/** One look at everything waiting: dates, PRs that are due a check, and (all
 *  at once, per connector) Slack and email waits that are due one. */
export async function checkWaits(now = Date.now()): Promise<void> {
  const chats = await listChatsEverywhere({ includeSubagents: true });
  const prs: Due[] = [];
  const connector: Due[] = [];
  for (const { repoPath, chat } of chats) {
    const p = chat.priority;
    if (p?.tier !== "waiting" || p.back) continue;
    const at = p.resurfaceAt ? Date.parse(p.resurfaceAt) : NaN;
    if (at <= now) {
      await markBack(repoPath, chat.id, "Its date came round");
      continue;
    }
    for (const wait of p.waits ?? []) {
      const last = Date.parse(wait.checkedAt ?? wait.createdAt);
      const every = wait.kind === "github" ? PR_EVERY_MS : CONNECTOR_EVERY_MS;
      // Slack and email waits get their first look as soon as there's a tick.
      const due = wait.checkedAt ? last + every <= now : wait.kind !== "github" || last + every <= now;
      if (!due) continue;
      (wait.kind === "github" ? prs : connector).push({ repoPath, chatId: chat.id, title: chat.title, wait });
    }
  }

  // Several chats can wait on one PR: look it up once.
  const seen = new Map<string, Promise<PrState>>();
  for (const d of prs) {
    try {
      if (!seen.has(d.wait.target)) seen.set(d.wait.target, prState(d.wait.target));
      const state = await seen.get(d.wait.target)!;
      const before = d.wait.baseline ? (JSON.parse(d.wait.baseline) as PrState) : null;
      const news = before && prNews(d.wait.target, before, state);
      if (news) await markBack(d.repoPath, d.chatId, news);
      else await touchWait(d.repoPath, d.chatId, d.wait.id, JSON.stringify(state));
    } catch (e) {
      console.warn(`[waits] couldn't check ${d.wait.target}:`, e instanceof Error ? e.message : e);
      await touchWait(d.repoPath, d.chatId, d.wait.id);
    }
  }

  for (const kind of ["slack", "email"] as const) {
    const due = connector.filter((d) => d.wait.kind === kind);
    if (due.length) await checkConnector(kind, due);
  }
}

async function checkConnector(kind: "slack" | "email", due: Due[]): Promise<void> {
  const where = kind === "slack" ? "Slack (their DMs, mentions and the threads named)" : "their email";
  const lines = due.map(
    (d) =>
      `- id ${d.wait.id}: waiting on ${d.wait.target} (for the chat "${d.title}"), since ${d.wait.checkedAt ?? d.wait.createdAt}`,
  );
  const prompt = [
    `The user is waiting on replies or news in ${where}. For each wait below, look for anything since its time that answers it or moves it on (a reply from the person, a new message in the thread, a decision).`,
    "",
    ...lines,
    "",
    "Return one row only for each wait that now has news: id = the wait's id exactly as given, title = one short line of what happened (who said what), data = the message(s) quoted with who and when. Leave out waits with nothing new.",
  ].join("\n");
  try {
    const { rows, costUsd } = await agentFetch([CONNECTOR_SERVER[kind]], prompt, undefined);
    console.log(`[waits] checked ${due.length} ${kind} wait(s), $${costUsd.toFixed(3)}`);
    const news = new Map<string, string>();
    for (const r of rows as { id?: unknown; title?: unknown }[]) {
      if (typeof r.id === "string" && typeof r.title === "string") news.set(r.id, r.title);
    }
    for (const d of due) {
      const said = news.get(d.wait.id);
      if (said) await markBack(d.repoPath, d.chatId, said.slice(0, 200));
      else await touchWait(d.repoPath, d.chatId, d.wait.id);
    }
  } catch (e) {
    const why = e instanceof NeedsSignIn ? e.message : e instanceof Error ? e.message : String(e);
    console.warn(`[waits] couldn't check ${kind} waits: ${why}`);
    // Try again at the next 3-hourly look, not every tick.
    for (const d of due) await touchWait(d.repoPath, d.chatId, d.wait.id);
  }
}

let started = false;
let running = false;

export function startWaitWatcher(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await checkWaits();
    } catch (e) {
      console.warn("[waits] check failed:", e);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), 60_000);
  setInterval(() => void tick(), TICK_MS);
}
