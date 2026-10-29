/**
 * grid.ts — Registry for the Grid page.
 *
 * The Grid shows a cross-repo board of chats that were *explicitly* created
 * from the grid (so ordinary repo chats don't pollute it). Membership is a
 * small registry persisted to ~/.buildover/grid.json — the chats themselves
 * live in their repos exactly like any other chat, so a grid chat also appears
 * in its repo's sidebar.
 *
 * "Mark done" removes the entry from the grid and marks the chat finished;
 * nothing is deleted — the chat, its transcript and its branches stay in the
 * repo, reachable from the repo sidebar's Archive and from the grid's
 * "Recent chats" picker. Adding a chat back to the grid un-finishes it, so
 * the pair is a clean round trip.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createChat,
  listChats,
  readChat,
  setUserFinished,
} from "./chats.js";
import { getRepoMeta, listRecents } from "./repos.js";
import { DEFAULT_MODEL } from "../src/types.js";
import type { ChatSummary, Model, PermissionMode } from "../src/types.js";

const BUILDOVER_DIR = join(homedir(), ".buildover");
const GRID_FILE = join(BUILDOVER_DIR, "grid.json");

// ── Types ──────────────────────────────────────────────────────────────────

export interface GridEntry {
  chatId: string;
  repoPath: string;
  /** Ascending sort key; drag-to-reorder rewrites these. */
  order: number;
  addedAt: string;
}

export interface GridRegistry {
  entries: GridEntry[];
  updatedAt: string;
}

/** A grid entry enriched with its chat summary + repo name for the client. */
export interface GridChatEntry extends GridEntry {
  repoName: string;
  chat: ChatSummary;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

let writeLock: Promise<unknown> = Promise.resolve();
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve!: () => void;
  writeLock = new Promise<void>((r) => {
    resolve = r;
  });
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    resolve();
  }
}

// ── Persistence ────────────────────────────────────────────────────────────

export async function readGrid(): Promise<GridRegistry> {
  try {
    const raw = await readFile(GRID_FILE, "utf8");
    const parsed = JSON.parse(raw) as GridRegistry;
    if (!Array.isArray(parsed.entries)) return { entries: [], updatedAt: nowIso() };
    return parsed;
  } catch (err: any) {
    if (err?.code === "ENOENT") return { entries: [], updatedAt: nowIso() };
    throw err;
  }
}

async function writeGrid(registry: GridRegistry): Promise<void> {
  await mkdir(BUILDOVER_DIR, { recursive: true });
  registry.updatedAt = nowIso();
  await atomicWrite(GRID_FILE, registry);
}

// ── Mutations ────────────────────────────────────────────────────────────────

/** Append a chat to the grid (idempotent). Returns the stored entry. */
export async function addToGrid(
  chatId: string,
  repoPath: string,
): Promise<GridEntry> {
  const entry = await withLock(async () => {
    const registry = await readGrid();
    const existing = registry.entries.find((e) => e.chatId === chatId);
    if (existing) return existing;
    const maxOrder = registry.entries.reduce((m, e) => Math.max(m, e.order), -1);
    const next: GridEntry = {
      chatId,
      repoPath,
      order: maxOrder + 1,
      addedAt: nowIso(),
    };
    registry.entries.push(next);
    await writeGrid(registry);
    return next;
  });
  // Putting a chat back on the board is the exact undo of "Mark done", so it
  // clears the finished flag too. Without this a reopened chat sits on the
  // grid still archived: keep-warm stays suppressed and it stays out of the
  // Master's default `list_chats`.
  const record = await readChat(repoPath, chatId).catch(() => null);
  if (record?.userMarkedFinished) {
    await setUserFinished(repoPath, chatId, false).catch(() => null);
  }
  return entry;
}

/** Remove a chat from the grid. Does not delete the chat. */
export async function removeFromGrid(chatId: string): Promise<boolean> {
  return withLock(async () => {
    const registry = await readGrid();
    const before = registry.entries.length;
    registry.entries = registry.entries.filter((e) => e.chatId !== chatId);
    if (registry.entries.length === before) return false;
    await writeGrid(registry);
    return true;
  });
}

/** Rewrite entry order to match the given chatId sequence. Unknown ids are
 *  ignored; entries not listed keep their relative order after the listed ones. */
export async function reorderGrid(orderedChatIds: string[]): Promise<void> {
  await withLock(async () => {
    const registry = await readGrid();
    const rank = new Map<string, number>();
    orderedChatIds.forEach((id, i) => rank.set(id, i));
    registry.entries.sort((a, b) => {
      const ra = rank.has(a.chatId) ? rank.get(a.chatId)! : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.chatId) ? rank.get(b.chatId)! : Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.order - b.order;
    });
    registry.entries.forEach((e, i) => {
      e.order = i;
    });
    await writeGrid(registry);
  });
}

/**
 * Create a brand-new chat and add it to the grid. The chat is a normal chat in
 * `repoPath`, so it also shows in that repo's sidebar.
 */
export async function createGridChat(opts: {
  repoPath: string;
  model?: Model;
  permissionMode?: PermissionMode;
  title?: string;
}): Promise<GridEntry> {
  const meta = await getRepoMeta(opts.repoPath);
  if (!meta) throw new Error(`Repo not found: ${opts.repoPath}`);
  const record = await createChat(opts.repoPath, {
    model: opts.model ?? DEFAULT_MODEL,
    permissionMode: opts.permissionMode ?? "default",
    ...(opts.title ? { title: opts.title } : {}),
  });
  return addToGrid(record.id, opts.repoPath);
}

/** Mark a grid chat done: remove from the grid and finish the chat. */
export async function markGridChatDone(
  chatId: string,
  repoPath: string,
): Promise<boolean> {
  const removed = await removeFromGrid(chatId);
  await setUserFinished(repoPath, chatId, true).catch(() => null);
  return removed;
}

// ── Read (enriched) ──────────────────────────────────────────────────────────

/**
 * Returns grid entries ordered by `order`, each enriched with its repo name and
 * chat summary. Prunes entries whose chat or repo no longer exists.
 */
export async function listGridChats(): Promise<GridChatEntry[]> {
  const registry = await readGrid();
  if (registry.entries.length === 0) return [];

  // Group by repo so each repo's chat index is loaded once.
  const byRepo = new Map<string, GridEntry[]>();
  for (const e of registry.entries) {
    const list = byRepo.get(e.repoPath) ?? [];
    list.push(e);
    byRepo.set(e.repoPath, list);
  }

  const result: GridChatEntry[] = [];
  const stale: string[] = [];

  for (const [repoPath, entries] of byRepo) {
    const meta = await getRepoMeta(repoPath).catch(() => null);
    if (!meta) {
      for (const e of entries) stale.push(e.chatId);
      continue;
    }
    const summaries = await listChats(repoPath).catch(() => [] as ChatSummary[]);
    const byId = new Map(summaries.map((s) => [s.id, s]));
    for (const e of entries) {
      const chat = byId.get(e.chatId);
      if (!chat) {
        stale.push(e.chatId);
        continue;
      }
      result.push({ ...e, repoName: meta.name, chat });
    }
  }

  // Prune entries whose chat/repo vanished so the grid self-heals.
  if (stale.length > 0) {
    await withLock(async () => {
      const current = await readGrid();
      current.entries = current.entries.filter((e) => !stale.includes(e.chatId));
      await writeGrid(current);
    });
  }

  result.sort((a, b) => a.order - b.order);
  return result;
}

/** A chat from any recent repo, for the grid's "Recent chats" picker. */
export interface RecentChatEntry {
  repoPath: string;
  repoName: string;
  chat: ChatSummary;
}

/**
 * The most recently active user chats across every recent repo (subagent and
 * coordinator chats are skipped), newest first.
 */
export async function listRecentChats(limit = 10): Promise<RecentChatEntry[]> {
  const repos = await listRecents();
  const perRepo = await Promise.all(
    repos.map(async (r): Promise<RecentChatEntry[]> => {
      const meta = await getRepoMeta(r.path).catch(() => null);
      if (!meta) return [];
      const summaries = await listChats(r.path).catch(() => [] as ChatSummary[]);
      return summaries
        .filter((c) => !c.kind || c.kind === "user")
        .slice(0, limit)
        .map((chat) => ({ repoPath: r.path, repoName: meta.name, chat }));
    }),
  );
  return perRepo
    .flat()
    .sort(
      (a, b) =>
        new Date(b.chat.updatedAt).getTime() - new Date(a.chat.updatedAt).getTime(),
    )
    .slice(0, limit);
}
