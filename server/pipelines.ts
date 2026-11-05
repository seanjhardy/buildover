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
  type PipelineSettings,
  type SourceConfig,
  type SourceRow,
} from "./pipelineSources.js";
import { rankItems } from "./pipelineRank.js";
import { notifyAgentNeedsInput } from "./push.js";
import { getRepoMeta } from "./repos.js";
import { getSession } from "./sessions.js";
import { nextSweep } from "./sweeps.js";
import { sampleUsage, weeklyShareUsd } from "./spendLedger.js";

// The pipeline engine. Each source's items get a hidden chat whose agent
// researches them and writes a front page. Items that need the user wait for
// the next sweep, when up to `slots` per source go onto the canvas; urgent ones
// go at once. Items closed at the source close here, quietly.
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
}

export interface PageFacts {
  written?: boolean;
  waiting?: boolean;
  done?: string;
}

export interface PipelineStore {
  items: PipelineItem[];
  syncedAt: Record<string, string>;
  /** Last sweep the engine released at. */
  releasedAt?: string;
  spend: { weekStart: string; usd: number; bySource: Record<string, number> };
  errors: Record<string, string>;
}

const STORE_FILE = join(PIPELINES_DIR, "items.json");
const TICK_MS = 60_000;
const DEFAULT_MAX_AGENTS = 2;
const DEFAULT_SLOTS = 3;
const DEFAULT_MODEL = "claude-opus-5-5";
/** A just-started chat shows "idle" until its turn persists. */
const START_GRACE_MS = 5 * 60_000;

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
  if (item.state === "shown") return { state: info.onGrid ? "shown" : "done", reason: info.onGrid ? undefined : "Closed" };
  if (info.status === "running") return { state: "working" };
  if (item.page?.waiting) return { state: "waiting" };
  if (info.status === "queued") return { state: "working" };
  const justStarted = !!item.startedAt && now - Date.parse(item.startedAt) < START_GRACE_MS;
  if (info.status === "idle" && !item.page?.written && justStarted) return { state: "working" };
  return { state: "ready" };
}

const byRank = (a: PipelineItem, b: PipelineItem) => a.rank - b.rank || a.createdAt.localeCompare(b.createdAt);

/**
 * Items to research now: the best new item of each source that has fewer than
 * `ahead` items researched and waiting, taking turns across sources, until
 * `maxAgents` are working.
 */
export function pickResearch(items: PipelineItem[], sources: string[], maxAgents: number, ahead: number): PipelineItem[] {
  let free = maxAgents - items.filter((i) => i.state === "working").length;
  const out: PipelineItem[] = [];
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
    for (const i of mine.filter((x) => x.state === "ready").sort(byRank)) {
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

async function runTick(): Promise<void> {
  const sources = loadSources();
  if (!sources.length) return;
  const settings = loadSettings();
  const store = await readStore();
  const live: SourceConfig[] = [];
  for (const src of sources) {
    if (await getRepoMeta(src.repoPath).catch(() => null)) live.push(src);
    else store.errors[src.id] = `${src.repoPath} isn't a buildover repo`;
  }

  const added = new Set<string>();
  for (const src of live) {
    const due = Date.parse(store.syncedAt[src.id] ?? "") + (src.everyMinutes ?? 10) * 60_000;
    if (Number.isFinite(due) && due > Date.now()) continue;
    try {
      if (await syncSource(src, store)) added.add(src.id);
      store.syncedAt[src.id] = nowIso();
      delete store.errors[src.id];
    } catch (err) {
      store.errors[src.id] = err instanceof Error ? err.message : String(err);
    }
  }

  await refreshItems(store);

  for (const src of live.filter((s) => added.has(s.id))) {
    await rankItems(src, store.items.filter((i) => i.source === src.id && i.state !== "done" && i.state !== "shown"), settings)
      .catch((err) => console.warn(`[pipelines] ranking ${src.id} failed:`, err instanceof Error ? err.message : err));
  }

  await sampleUsage().catch(() => undefined);
  const agents = await researchAgents(store, settings);
  for (const item of pickResearch(store.items, live.map((s) => s.id), agents, settings.slots ?? DEFAULT_SLOTS)) {
    await startResearch(live.find((s) => s.id === item.source)!, item, settings);
  }

  const sweepDue = forceRelease || (!!store.releasedAt && nextSweep(new Date(store.releasedAt), settings.sweeps).getTime() <= Date.now());
  store.releasedAt ??= nowIso();
  for (const item of pickRelease(store.items, sweepDue, settings.slots ?? DEFAULT_SLOTS)) {
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
  } else {
    rows = await fetchRows(src, { seen: [], room: 0 });
    const live = new Set(rows.map((r) => r.id));
    for (const i of open) if (!live.has(i.key)) await closeItem(i, "Closed or reassigned at the source");
  }
  let added = false;
  for (const r of rows) {
    const existing = mine.find((i) => i.key === r.id);
    if (existing) {
      // Still open at the source: refresh what the agent will see next time.
      existing.title = r.title;
      existing.data = r.data;
      existing.url = r.url;
      continue;
    }
    const at = nowIso();
    store.items.push({
      source: src.id,
      key: r.id,
      title: r.title,
      url: r.url,
      data: r.data,
      repoPath: src.repoPath,
      state: "new",
      rank: Number.MAX_SAFE_INTEGER,
      createdAt: at,
      updatedAt: at,
    });
    added = true;
  }
  return added;
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
        item.page = { written: hasFrontPage(page), waiting: !!page.waiting, ...(page.done ? { done: page.done } : {}) };
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
  const record = await createChat(src.repoPath, {
    model,
    permissionMode: "bypassPermissions",
    title: item.title,
    pipeline: { source: src.id, key: item.key },
  });
  item.chatId = record.id;
  item.startedAt = nowIso();
  setState(item, "working");
  const text = await researchPrompt(src, item);
  void getSession(src.repoPath, record.id)
    .runTurn({ text, model, permissionMode: "bypassPermissions" })
    .catch((err) => console.warn(`[pipelines] research on ${item.key} failed:`, err instanceof Error ? err.message : err));
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
        ...(store.errors[src.id] ? { error: store.errors[src.id] } : {}),
        items: items.map(({ key, title, summary, state, chatId, rank, urgent, url }) => ({ key, title, summary, state, chatId, rank, urgent, url })),
      };
    }),
    budget: { spentUsd: store.spend.usd, capUsd: await budgetCap(settings), warnAt: settings.budget?.warnAt ?? 0.75 },
    nextSweep: nextSweep(new Date(), settings.sweeps).toISOString(),
  };
}
