import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ChatStatus, ChatSummary, ItemState, PipelinesView } from "../src/types.js";

export type { ItemState };
import { hasFrontPage, pageFromEvents } from "../src/lib/frontPage.js";
import { createChat, listChats, readChat } from "./chats.js";
import { addToGrid, markGridChatDone, readGrid } from "./grid.js";
import { NOTES_FILE, PIPELINES_DIR } from "./pageTools.js";
import {
  checkClosed,
  fetchRows,
  loadSettings,
  loadSources,
  takeFetchCost,
  type IdeasContext,
  type PipelineSettings,
  type SourceConfig,
  type SourceRow,
} from "./pipelineSources.js";
import { NeedsSignIn } from "./pipelineAgentFetch.js";
import { rankItems } from "./pipelineRank.js";
import { notifyAgentNeedsInput } from "./push.js";
import { getRepoMeta } from "./repos.js";
import { getSession } from "./sessions.js";
import { nextSweep } from "./sweeps.js";
import { sampleUsage, weeklyShareUsd } from "./spendLedger.js";

// The pipeline engine. Each source's items get a hidden chat whose agent
// researches them and writes a front page. Items that need the user wait for
// the next sweep, when up to `slots` per source go onto the canvas; urgent ones
// go at once. Items closed at the source close here, quietly. News on an item
// (its source row's version changes) wakes its chat again, reopening it if
// closed, so one thing keeps one chat. Before each sweep a cheap check asks
// every chat waiting on an event whether it has happened.
//
//   new ─research─▶ working ─turn ends─▶ ready ─sweep─▶ shown ─closed─▶ done
//                      ▲          └─wait──▶ waiting ─wakes─┘


export interface PipelineItem {
  source: string;
  key: string;
  title: string;
  url?: string;
  data?: unknown;
  repoPath: string;
  chatId?: string;
  state: ItemState;
  /** Lower is more important, within its source. */
  rank: number;
  urgent?: boolean;
  /** The agent's card summary, once written. */
  summary?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  closedReason?: string;
  /** The chat's updatedAt when last read, so unchanged chats aren't re-read. */
  seenAt?: string;
  /** The chat's cost already counted into the weekly spend. */
  costSeen?: number;
  /** What the front page said when last read. */
  page?: PageFacts;
  /** The source row's version when last synced. */
  version?: string;
  /** News to wake the chat with when an agent is free. */
  wake?: string;
  /** When an event check started in the chat, until it settles. */
  checking?: string;
  /** The sweep the last event check was for. */
  checkedFor?: string;
  /** The chat is mid-turn or asking for something, so nothing is sent to it. */
  busy?: boolean;
  /** Another item's key whose chat this one joined; its news goes there. */
  joinedTo?: string;
  /** Its chat went on the canvas when work started; gone from there means the user closed it. */
  placed?: boolean;
}

export interface PageFacts {
  written?: boolean;
  waiting?: boolean;
  done?: string;
  /** What it's waiting for, when it waits on an event. */
  event?: string;
}

export interface PipelineStore {
  items: PipelineItem[];
  syncedAt: Record<string, string>;
  /** Last attempt per source, so a failing one backs off. */
  triedAt?: Record<string, string>;
  /** Last sweep the engine released at. */
  releasedAt?: string;
  spend: { weekStart: string; usd: number; bySource: Record<string, number> };
  errors: Record<string, string>;
  /** Connectors a source needs signed in before it can be read. */
  signIn?: Record<string, string[]>;
  /** Sources the user paused, with when: not read on schedule, nothing new started or shown. */
  paused?: Record<string, string>;
}

const STORE_FILE = join(PIPELINES_DIR, "items.json");
const TICK_MS = 60_000;
const DEFAULT_MAX_AGENTS = 2;
const DEFAULT_SLOTS = 3;
const DEFAULT_MODEL = "claude-opus-5-5";
/** A just-started chat shows "idle" until its turn persists. */
const START_GRACE_MS = 5 * 60_000;
const CHECK_MODEL = "claude-haiku-4-5-20251001";
/** Event checks run this long before a sweep. */
const CHECK_AHEAD_MS = 30 * 60_000;
const CHECK_GRACE_MS = 2 * 60_000;
/** A source whose last check failed waits this long before the next try. */
const RETRY_MS = 15 * 60_000;
/** Sources checked only before sweeps are checked this long before each. */
const SYNC_AHEAD_MS = 60 * 60_000;

const nowIso = () => new Date().toISOString();

/** Monday 00:00 local of the week containing `d`. */
export function weekStart(d: Date): Date {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

function emptyStore(): PipelineStore {
  return { items: [], syncedAt: {}, spend: { weekStart: weekStart(new Date()).toISOString(), usd: 0, bySource: {} }, errors: {} };
}

async function readStore(): Promise<PipelineStore> {
  try {
    const s = JSON.parse(await readFile(STORE_FILE, "utf8")) as PipelineStore;
    return { ...emptyStore(), ...s };
  } catch {
    return emptyStore();
  }
}

async function writeStore(store: PipelineStore): Promise<void> {
  await mkdir(PIPELINES_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  await rename(tmp, STORE_FILE);
}

// ── Pure decisions (tested) ─────────────────────────────────────────────────

export interface ChatInfo {
  /** Null when the chat no longer exists. */
  status: ChatStatus | null;
  onGrid: boolean;
}

/** An item's next state from its chat. */
export function nextState(item: PipelineItem, info: ChatInfo, now: number): { state: ItemState; reason?: string } {
  if (item.state === "new" || item.state === "done") return { state: item.state };
  if (!info.status) return { state: "done", reason: "Its chat was deleted" };
  if (info.status === "finished") return { state: "done", reason: "Closed" };
  if (item.page?.done) return { state: "done", reason: item.page.done };
  // On the canvas the window is the user's: it stays until they close it.
  if (item.state === "shown" || item.placed) {
    if (!info.onGrid) return { state: "done", reason: "Closed" };
    if (item.state === "shown") return { state: "shown" };
  }
  if (info.status === "running") return { state: "working" };
  if (item.page?.waiting) return { state: "waiting" };
  if (info.status === "queued") return { state: "working" };
  const justStarted = !!item.startedAt && now - Date.parse(item.startedAt) < START_GRACE_MS;
  if (info.status === "idle" && !item.page?.written && justStarted) return { state: "working" };
  return { state: "ready" };
}

const byRank = (a: PipelineItem, b: PipelineItem) => a.rank - b.rank || a.createdAt.localeCompare(b.createdAt);

/** Whether a woken item can be sent its news now. */
const wakeable = (i: PipelineItem) => !!i.wake && !!i.chatId && i.state !== "working" && !i.busy && !i.checking;

/**
 * Items to work now, until `maxAgents` are working: woken items first (news on
 * something already under way), then the best new item of each source that
 * has fewer than `ahead` items researched and waiting, taking turns across
 * sources.
 */
export function pickResearch(items: PipelineItem[], sources: string[], maxAgents: number, ahead: number): PipelineItem[] {
  let free = maxAgents - items.filter((i) => i.state === "working").length;
  const out: PipelineItem[] = [];
  for (const i of items.filter((x) => wakeable(x) && sources.includes(x.source)).sort(byRank)) {
    if (free <= 0) break;
    out.push(i);
    free--;
  }
  const queues = sources.map((s) => {
    const mine = items.filter((i) => i.source === s);
    const queued = mine.filter((i) => i.state === "working" || i.state === "ready").length;
    return mine.filter((i) => i.state === "new").sort(byRank).slice(0, Math.max(0, ahead - queued));
  });
  while (free > 0 && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (free > 0 && q.length) {
        out.push(q.shift()!);
        free--;
      }
    }
  }
  return out;
}

/** Items to put on the canvas: urgent ones always; at a sweep, the best ready ones up to `slots` per source. */
export function pickRelease(items: PipelineItem[], sweep: boolean, slots: number): PipelineItem[] {
  const out: PipelineItem[] = [];
  const sources = [...new Set(items.map((i) => i.source))];
  for (const s of sources) {
    const mine = items.filter((i) => i.source === s);
    let shown = mine.filter((i) => i.state === "shown").length;
    // A woken item's page is stale until its news has been worked.
    for (const i of mine.filter((x) => x.state === "ready" && !x.wake).sort(byRank)) {
      if (i.urgent) out.push(i), shown++;
      else if (sweep && shown < slots) out.push(i), shown++;
    }
  }
  return out;
}

// ── Research prompt ─────────────────────────────────────────────────────────

async function readText(file: string): Promise<string> {
  return readFile(file, "utf8").catch(() => "");
}

async function researchPrompt(src: SourceConfig, item: PipelineItem): Promise<string> {
  const notes = (await readText(NOTES_FILE)).trim();
  return [
    `You're working an item from the "${src.name}" pipeline in the background. The user isn't watching. They will only see this chat's front page, and only if it needs them; they can then reply in this chat.`,
    "",
    "1. Research it: what it is, what's wrong or wanted, and what should happen. Read code, data and history as needed. Draft a fix or a reply only when it's easy or obvious.",
    "2. Write the front page with the page tools: set_card, milestone (the issue in the reporter's words, the context, the state), show_panel for findings, and suggest_options with the action you recommend first.",
    "3. If it needs nothing from the user (already fixed, a duplicate, not theirs), call done saying why. If it's waiting on something, call wait.",
    "4. Set urgent on set_card only if it can't wait for the next scheduled check-in.",
    "",
    `Item: ${item.title}`,
    ...(item.url ? [`Link: ${item.url}`] : []),
    ...(item.data !== undefined ? ["Source data:", "```json", JSON.stringify(item.data, null, 2).slice(0, 12_000), "```"] : []),
    ...(src.prompt ? ["", src.prompt] : []),
    ...(notes ? ["", "The user's standing notes on how they work and weigh work:", notes] : []),
  ].join("\n");
}

// ── The tick ────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let ticking: Promise<void> | null = null;
let forceRelease = false;
/** Sources asked to run now, whatever their schedule. */
const forceRun = new Set<string>();
/** The source being read right now. */
let reading: string | null = null;
/** Pauses asked for since the last tick read the store; it saves them. */
const pauseChanges = new Map<string, boolean>();

export function startPipelines(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  void tick();
}

/** Run a tick now (serialised with the timer). */
export function tick(): Promise<void> {
  ticking ??= runTick()
    .catch((err) => console.warn("[pipelines] tick failed:", err instanceof Error ? err.message : err))
    .finally(() => {
      ticking = null;
    });
  return ticking;
}

/** Release ready items now instead of waiting for the next sweep. */
export async function releaseNow(): Promise<void> {
  await ticking;
  forceRelease = true;
  await tick();
}

/** Pause or resume one source. Takes effect at the next tick, which saves it. */
export function setPaused(id: string, paused: boolean): void {
  pauseChanges.set(id, paused);
  void (async () => {
    await ticking;
    await tick();
  })();
}

function applyPauses(store: PipelineStore) {
  for (const [id, paused] of pauseChanges) {
    if (paused) (store.paused ??= {})[id] ??= nowIso();
    else delete store.paused?.[id];
  }
  pauseChanges.clear();
}

const isPaused = (store: PipelineStore, id: string) => pauseChanges.get(id) ?? !!store.paused?.[id];

/** Read a source now and start work on its best new item, outside its schedule. */
export function runNow(id: string): void {
  forceRun.add(id);
  void (async () => {
    await ticking;
    await tick();
  })();
}

async function runTick(): Promise<void> {
  const sources = loadSources();
  if (!sources.length) return;
  const settings = loadSettings();
  const store = await readStore();
  applyPauses(store);
  const live: SourceConfig[] = [];
  for (const src of sources) {
    if (await getRepoMeta(src.repoPath).catch(() => null)) live.push(src);
    else store.errors[src.id] = `${src.repoPath} isn't a buildover repo`;
  }

  const added = new Set<string>();
  const forced = live.filter((s) => forceRun.has(s.id));
  for (const id of forceRun) forceRun.delete(id);
  const atCap = (await researchAgents(store, settings)) === 0;
  for (const src of live) {
    const asked = forced.includes(src);
    if (!asked) {
      if (isPaused(store, src.id)) continue;
      if (!syncDue(src, store.syncedAt[src.id], settings)) continue;
      // Coming up with ideas is research too: not once the budget is spent.
      if (atCap && src.fetch.kind === "ideas") continue;
      const triedAt = store.triedAt?.[src.id];
      if (store.errors[src.id] && triedAt && Date.parse(triedAt) + RETRY_MS > Date.now()) continue;
    }
    const startedAt = nowIso();
    (store.triedAt ??= {})[src.id] = startedAt;
    reading = src.id;
    try {
      if (await syncSource(src, store)) added.add(src.id);
      store.syncedAt[src.id] = startedAt;
      delete store.errors[src.id];
      delete store.signIn?.[src.id];
    } catch (err) {
      store.errors[src.id] = err instanceof Error ? err.message : String(err);
      if (err instanceof NeedsSignIn) (store.signIn ??= {})[src.id] = err.servers;
    } finally {
      reading = null;
    }
    const cost = takeFetchCost(src.id);
    rollWeek(store);
    store.spend.usd += cost;
    store.spend.bySource[src.id] = (store.spend.bySource[src.id] ?? 0) + cost;
    // Some sources take minutes; what's been read so far shows meanwhile.
    await writeStore(store);
  }

  await refreshItems(store);

  for (const src of live.filter((s) => added.has(s.id))) {
    await rankItems(src, store.items.filter((i) => i.source === src.id && i.state !== "done" && i.state !== "shown"), settings)
      .catch((err) => console.warn(`[pipelines] ranking ${src.id} failed:`, err instanceof Error ? err.message : err));
  }

  await sampleUsage().catch(() => undefined);
  const agents = await researchAgents(store, settings);
  const running = live.filter((s) => !isPaused(store, s.id));
  for (const item of pickResearch(store.items, running.map((s) => s.id), agents, settings.slots ?? DEFAULT_SLOTS)) {
    const src = live.find((s) => s.id === item.source)!;
    await (item.state === "new" ? startResearch(src, item, settings) : startWake(src, item, settings));
  }
  // Asked to run now: its best new item starts even when the agents are busy.
  for (const src of forced) {
    const mine = store.items.filter((i) => i.source === src.id);
    const best = mine.filter((i) => i.state === "new").sort(byRank)[0];
    if (best && !mine.some((i) => i.state === "working")) await startResearch(src, best, settings);
  }
  await startChecks(store, settings);

  const sweepDue = forceRelease || (!!store.releasedAt && nextSweep(new Date(store.releasedAt), settings.sweeps).getTime() <= Date.now());
  store.releasedAt ??= nowIso();
  const releasable = store.items.filter((i) => !isPaused(store, i.source));
  for (const item of pickRelease(releasable, sweepDue, settings.slots ?? DEFAULT_SLOTS)) {
    await addToGrid(item.chatId!, item.repoPath);
    if (item.urgent) {
      void notifyAgentNeedsInput(item.title, basename(item.repoPath), item.summary).catch(() => undefined);
    }
    setState(item, "shown");
  }
  if (sweepDue) {
    store.releasedAt = nowIso();
    forceRelease = false;
  }

  await writeStore(store);
}

/** When a source is next read (now, if it's due). */
export function nextCheck(src: SourceConfig, syncedAt: string | undefined, settings: PipelineSettings, now = new Date()): Date {
  if (syncDue(src, syncedAt, settings, now)) return now;
  if (src.beforeSweeps) {
    const sweep = nextSweep(now, settings.sweeps);
    const opens = sweep.getTime() - SYNC_AHEAD_MS;
    // Already read in this sweep's hour: the hour before the one after.
    if (now.getTime() < opens) return new Date(opens);
    return new Date(nextSweep(new Date(sweep.getTime() + 60_000), settings.sweeps).getTime() - SYNC_AHEAD_MS);
  }
  return new Date(Date.parse(syncedAt!) + (src.everyMinutes ?? 10) * 60_000);
}

/** Whether a source is due a check: every few minutes, or once in the hour before each sweep. */
export function syncDue(src: SourceConfig, syncedAt: string | undefined, settings: PipelineSettings, now = new Date()): boolean {
  const last = Date.parse(syncedAt ?? "");
  if (src.beforeSweeps) {
    const opens = nextSweep(now, settings.sweeps).getTime() - SYNC_AHEAD_MS;
    return now.getTime() >= opens && !(last >= opens);
  }
  return !Number.isFinite(last) || last + (src.everyMinutes ?? 10) * 60_000 <= now.getTime();
}

/** Add news to an item's pending wake. */
function addWake(item: PipelineItem, news: string) {
  if (!item.wake) item.wake = news;
  else if (!item.wake.includes(news)) item.wake += `\n\n${news}`;
}

const NEWS = "There's news on this at the source since you last looked. See what changed, act on it, and update the front page.";
const joinedNews = (src: SourceConfig, r: SourceRow) =>
  [`Someone brought this up on ${src.name}:`, "```json", JSON.stringify(r.data ?? r.title, null, 2).slice(0, 8_000), "```", "Take it into account, reply there if it needs one (ask the user first), and update the front page."].join("\n");

function setState(item: PipelineItem, state: ItemState, reason?: string) {
  if (item.state === state) return;
  item.state = state;
  item.updatedAt = nowIso();
  if (reason) item.closedReason = reason;
}

/** Add new items and close ones gone at the source. True when anything was added. */
async function syncSource(src: SourceConfig, store: PipelineStore): Promise<boolean> {
  const mine = store.items.filter((i) => i.source === src.id);
  const open = mine.filter((i) => i.state !== "done");
  let rows: SourceRow[];
  if (src.rolling) {
    const closed = await checkClosed(src, open.map((i) => i.key));
    for (const i of open) if (closed.has(i.key)) await closeItem(i, "Closed at the source");
    const room = src.rolling.active - open.filter((i) => !closed.has(i.key)).length;
    rows = room > 0 ? await fetchRows(src, { seen: mine.map((i) => i.key), room }) : [];
  } else if (src.feed) {
    rows = await fetchRows(src, {
      seen: [],
      room: 0,
      since: store.syncedAt[src.id],
      ...(src.fetch.kind === "ideas" ? { ideas: await ideasContext(store, src) } : {}),
    });
  } else {
    rows = await fetchRows(src, { seen: [], room: 0 });
    const live = new Set(rows.map((r) => r.id));
    for (const i of open) if (!live.has(i.key)) await closeItem(i, "Closed or reassigned at the source");
  }
  let added = false;
  for (const r of rows) {
    const existing = mine.find((i) => i.key === r.id);
    const joinKey = existing?.joinedTo ?? r.joins;
    const target = joinKey ? store.items.find((i) => i.key === joinKey && i.chatId) : undefined;
    if (existing) {
      // Still open at the source: refresh what the agent will see next time.
      existing.title = r.title;
      existing.data = r.data;
      existing.url = r.url;
      if (r.version !== undefined) {
        if (existing.version !== undefined && r.version !== existing.version) {
          if (existing.joinedTo) target && addWake(target, joinedNews(src, r));
          else if (existing.chatId) addWake(existing, NEWS);
        }
        existing.version = r.version;
      }
      continue;
    }
    const at = nowIso();
    if (target) {
      // It's about something already under way (a review request for a PR
      // that has a chat): it goes to that chat instead of starting another.
      addWake(target, joinedNews(src, r));
      store.items.push({
        source: src.id,
        key: r.id,
        title: r.title,
        url: r.url,
        data: r.data,
        ...(r.version !== undefined ? { version: r.version } : {}),
        repoPath: target.repoPath,
        state: "done",
        closedReason: `Joined "${target.title}"`,
        joinedTo: target.key,
        rank: Number.MAX_SAFE_INTEGER,
        createdAt: at,
        updatedAt: at,
      });
      continue;
    }
    store.items.push({
      source: src.id,
      key: r.id,
      title: r.title,
      url: r.url,
      data: r.data,
      ...(r.version !== undefined ? { version: r.version } : {}),
      repoPath: await rowRepo(r, src),
      state: "new",
      rank: Number.MAX_SAFE_INTEGER,
      createdAt: at,
      updatedAt: at,
    });
    added = true;
  }
  return added;
}

/** What an ideas source sees: the user's notes, open work, and every past idea's fate. */
async function ideasContext(store: PipelineStore, src: SourceConfig): Promise<IdeasContext> {
  const notes = (await readText(NOTES_FILE)).trim();
  const open = store.items.filter((i) => i.source !== src.id && i.state !== "done").map((i) => i.title).slice(0, 60);
  const past = store.items
    .filter((i) => i.source === src.id)
    .map((i) => ({
      title: i.title,
      outcome: i.state === "done" ? `closed: ${i.closedReason ?? "no reason given"}` : i.state === "new" ? "not looked at yet" : "still open",
    }));
  return { notes, open, past };
}

/** The row's own repo when it names a buildover repo, else the source's. */
async function rowRepo(r: SourceRow, src: SourceConfig): Promise<string> {
  if (r.repoPath && r.repoPath !== src.repoPath && (await getRepoMeta(r.repoPath).catch(() => null))) return r.repoPath;
  return src.repoPath;
}

async function closeItem(item: PipelineItem, reason: string): Promise<void> {
  if (item.chatId) await markGridChatDone(item.chatId, item.repoPath).catch(() => null);
  setState(item, "done", reason);
}

/** Follow each item's chat: its status, front page, spend. */
async function refreshItems(store: PipelineStore): Promise<void> {
  const tracked = store.items.filter((i) => i.chatId && i.state !== "done" && i.state !== "new");
  if (!tracked.length) return;
  const grid = new Set((await readGrid()).entries.map((e) => e.chatId));
  const summaries = new Map<string, Map<string, ChatSummary>>();
  rollWeek(store);
  for (const item of tracked) {
    if (!summaries.has(item.repoPath)) {
      const list = await listChats(item.repoPath).catch(() => [] as ChatSummary[]);
      summaries.set(item.repoPath, new Map(list.map((s) => [s.id, s])));
    }
    const summary = summaries.get(item.repoPath)!.get(item.chatId!);
    if (summary && summary.updatedAt !== item.seenAt) {
      const record = await readChat(item.repoPath, item.chatId!).catch(() => null);
      if (record) {
        const page = pageFromEvents(record.events);
        item.page = {
          written: hasFrontPage(page),
          waiting: !!page.waiting,
          ...(page.waiting?.event ? { event: page.waiting.event } : {}),
          ...(page.done ? { done: page.done } : {}),
        };
        item.summary = page.summary ?? item.summary;
        item.urgent = page.urgent ?? item.urgent;
        const cost = record.cost?.totalUsd ?? 0;
        const delta = Math.max(0, cost - (item.costSeen ?? 0));
        store.spend.usd += delta;
        store.spend.bySource[item.source] = (store.spend.bySource[item.source] ?? 0) + delta;
        item.costSeen = cost;
      }
      item.seenAt = summary.updatedAt;
    }
    // Work started before everything went on the canvas goes there now.
    if (!item.placed && item.state !== "shown" && item.state !== "done") {
      if (!grid.has(item.chatId!)) await addToGrid(item.chatId!, item.repoPath).catch(() => null);
      grid.add(item.chatId!);
      item.placed = true;
    }
    const status = summary?.status;
    item.busy = status === "running" || status === "queued" || status === "awaiting_input";
    if (item.checking && status && !item.busy && Date.now() - Date.parse(item.checking) > CHECK_GRACE_MS) {
      delete item.checking;
      if (!item.page?.waiting) {
        item.wake = "What you were waiting for has happened (see the check above). Carry on with the work and update the front page.";
      }
    }
    const next = nextState(item, { status: summary?.status ?? null, onGrid: grid.has(item.chatId!) }, Date.now());
    if (next.state === "done" && item.state !== "shown") await markGridChatDone(item.chatId!, item.repoPath).catch(() => null);
    setState(item, next.state, next.reason);
  }
}

function rollWeek(store: PipelineStore) {
  const start = weekStart(new Date()).toISOString();
  if (store.spend.weekStart !== start) store.spend = { weekStart: start, usd: 0, bySource: {} };
}

const DEFAULT_SHARE = 0.02;

/** The weekly cap in API dollars, or null while the rate is still being learned. */
export async function budgetCap(settings: PipelineSettings): Promise<number | null> {
  return settings.budget?.weeklyUsd ?? (await weeklyShareUsd(settings.budget?.share ?? DEFAULT_SHARE));
}

/**
 * At the cap, no new research starts (ranking and checks carry on). While the
 * cap is still unknown, research runs one agent at a time so its own spend
 * teaches the rate.
 */
async function researchAgents(store: PipelineStore, settings: PipelineSettings): Promise<number> {
  const cap = await budgetCap(settings);
  if (cap === null) return 1;
  return store.spend.usd >= cap ? 0 : settings.maxAgents ?? DEFAULT_MAX_AGENTS;
}

async function startResearch(src: SourceConfig, item: PipelineItem, settings: PipelineSettings): Promise<void> {
  const model = src.model ?? settings.model ?? DEFAULT_MODEL;
  const record = await createChat(item.repoPath, {
    model,
    permissionMode: "bypassPermissions",
    title: item.title,
    pipeline: { source: src.id, key: item.key },
  });
  item.chatId = record.id;
  item.startedAt = nowIso();
  setState(item, "working");
  await addToGrid(record.id, item.repoPath);
  item.placed = true;
  const text = await researchPrompt(src, item);
  void getSession(item.repoPath, record.id)
    .runTurn({ text, model, permissionMode: "bypassPermissions" })
    .catch((err) => console.warn(`[pipelines] research on ${item.key} failed:`, err instanceof Error ? err.message : err));
}

/** Send a woken item's news to its chat. */
async function startWake(src: SourceConfig, item: PipelineItem, settings: PipelineSettings): Promise<void> {
  const model = src.model ?? settings.model ?? DEFAULT_MODEL;
  const text = [
    item.wake,
    ...(item.url ? ["", `Link: ${item.url}`] : []),
    ...(item.data !== undefined ? ["", "Source data now:", "```json", JSON.stringify(item.data, null, 2).slice(0, 12_000), "```"] : []),
  ].join("\n");
  delete item.wake;
  delete item.closedReason;
  // The new turn clears any wait or close on the page.
  item.page = { written: item.page?.written };
  item.startedAt = nowIso();
  if (item.state !== "shown") setState(item, "working");
  // Reopened news goes back on the canvas.
  await addToGrid(item.chatId!, item.repoPath);
  item.placed = true;
  void getSession(item.repoPath, item.chatId!)
    .runTurn({ text, model, permissionMode: "bypassPermissions" })
    .catch((err) => console.warn(`[pipelines] waking ${item.key} failed:`, err instanceof Error ? err.message : err));
}

/** Shortly before each sweep, ask each chat waiting on an event whether it has happened. */
async function startChecks(store: PipelineStore, settings: PipelineSettings): Promise<void> {
  const upcoming = nextSweep(new Date(), settings.sweeps);
  if (upcoming.getTime() - Date.now() > CHECK_AHEAD_MS) return;
  const sweep = upcoming.toISOString();
  const due = store.items.filter(
    (i) => !isPaused(store, i.source) && i.chatId && i.page?.event && (i.state === "waiting" || i.state === "shown") && !i.busy && !i.checking && !i.wake && i.checkedFor !== sweep,
  );
  for (const item of due) {
    item.checking = nowIso();
    item.checkedFor = sweep;
    const text = [
      `Quick check, don't do the work yet. You're waiting for: "${item.page!.event}".`,
      "Find out whether it has happened, looking only as far as you need.",
      "If it hasn't, call wait again with the same event and note, then stop.",
      "If it has, say in one line what happened and stop; you'll be asked to carry on.",
    ].join(" ");
    void getSession(item.repoPath, item.chatId!)
      .runTurn({ text, model: CHECK_MODEL, permissionMode: "bypassPermissions" })
      .catch((err) => console.warn(`[pipelines] checking ${item.key} failed:`, err instanceof Error ? err.message : err));
  }
}

// ── Read model for the canvas ───────────────────────────────────────────────

export async function pipelinesView(): Promise<PipelinesView> {
  const sources = loadSources();
  const settings = loadSettings();
  const store = await readStore();
  rollWeek(store);
  return {
    sources: sources.map((src) => {
      const items = store.items.filter((i) => i.source === src.id && i.state !== "done").sort(byRank);
      const counts = { new: 0, working: 0, ready: 0, shown: 0, waiting: 0, done: 0 } as Record<ItemState, number>;
      for (const i of items) counts[i.state]++;
      return {
        id: src.id,
        name: src.name,
        repoPath: src.repoPath,
        counts,
        spendUsd: store.spend.bySource[src.id] ?? 0,
        reading: reading === src.id || forceRun.has(src.id),
        ...(isPaused(store, src.id) ? { pausedAt: store.paused?.[src.id] ?? nowIso() } : {}),
        ...(store.syncedAt[src.id] ? { checkedAt: store.syncedAt[src.id] } : {}),
        nextCheckAt: nextCheck(src, store.syncedAt[src.id], settings).toISOString(),
        ...(store.errors[src.id] ? { error: store.errors[src.id] } : {}),
        ...(store.signIn?.[src.id]?.length ? { signIn: store.signIn[src.id] } : {}),
        items: items.map(({ key, title, summary, state, chatId, repoPath, rank, urgent, url }) => ({
          key,
          title,
          summary,
          state,
          chatId,
          repoPath,
          rank,
          urgent,
          url,
        })),
      };
    }),
    budget: { spentUsd: store.spend.usd, capUsd: await budgetCap(settings), warnAt: settings.budget?.warnAt ?? 0.75 },
    nextSweep: nextSweep(new Date(), settings.sweeps).toISOString(),
  };
}
