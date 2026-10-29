/**
 * master.ts — the Master agent: one permanent, cross-repo chat that oversees
 * every other chat.
 *
 * It lives in its own "repo" (`~/.buildover/master`) so it isn't tied to a
 * project and never shows up in a repo's sidebar, and it is pinned to the left
 * of the Grid page. Unlike a coordinator (per-repo, owns a plan board), the
 * Master's job is situational awareness: it can list and read every chat in
 * every known repo, message them, and manage their keep-warm state.
 *
 * It is kept warm aggressively (MASTER_KEEP_WARM_HOURS) because it is the chat
 * the user returns to most often, and a cold restart on a large transcript
 * costs far more than the pings do (see the keep-warm notes in sessions.ts).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createChat, listChats, readChat, setKeepWarm } from "./chats.js";
import { ensureRepo, getRepoMeta, listRecents } from "./repos.js";
import type { ChatSummary, Model } from "../src/types.js";

const BUILDOVER_DIR = join(homedir(), ".buildover");
const MASTER_FILE = join(BUILDOVER_DIR, "master.json");

/** Home directory of the master chat — a directory, not a real project. */
export const MASTER_REPO_PATH = join(BUILDOVER_DIR, "master");

/**
 * How long the master chat keeps itself warm after its last real message.
 * Deliberately longer than the per-chat default: this is the chat the user
 * dips in and out of all day.
 */
export const MASTER_KEEP_WARM_HOURS = 4;

/** The prompt cache TTL the keep-warm machinery works against (1h, minus a
 *  margin) — shared with the client's warm indicator via /api/master. */
export const CACHE_TTL_MS = 60 * 60_000;

export interface MasterInfo {
  repoPath: string;
  chatId: string;
  keepWarmHours: number;
  /** Current model of the master chat, so the client can seed its Composer. */
  model: Model;
}

interface MasterRegistry {
  chatId: string;
  repoPath: string;
  createdAt: string;
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

async function readRegistry(): Promise<MasterRegistry | null> {
  try {
    return JSON.parse(await readFile(MASTER_FILE, "utf8")) as MasterRegistry;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

let provisioning: Promise<MasterInfo> | null = null;

/**
 * Model for a freshly created master chat. Only a default: once the chat
 * exists, its stored model (the user's choice) is always what's reported.
 */
const MASTER_DEFAULT_MODEL: Model = "claude-opus-5-5";

/**
 * Returns the master chat, creating it (and its home directory) the first
 * time. Concurrent callers share one provisioning pass so a cold start with
 * several clients connected can't create two master chats. The pass is only
 * shared while in flight, never memoized: a cached result would carry the
 * model from server start, and the client seeds its Composer from it, so a
 * remount would quietly revert the user's model choice on the next turn.
 */
export async function ensureMasterChat(model?: Model): Promise<MasterInfo> {
  if (provisioning) return provisioning;
  provisioning = (async () => {
    await mkdir(MASTER_REPO_PATH, { recursive: true });
    await ensureRepo(MASTER_REPO_PATH);

    const existing = await readRegistry();
    if (existing?.chatId) {
      const record = await readChat(MASTER_REPO_PATH, existing.chatId).catch(() => null);
      if (record) {
        // Keep-warm is not optional for the master chat; re-assert it in case
        // it was toggled off from a generic chat control.
        if (!record.keepWarm) {
          await setKeepWarm(MASTER_REPO_PATH, existing.chatId, true).catch(() => null);
        }
        return {
          repoPath: MASTER_REPO_PATH,
          chatId: existing.chatId,
          keepWarmHours: MASTER_KEEP_WARM_HOURS,
          model: record.model,
        };
      }
      // Registry pointed at a chat that no longer exists — fall through and
      // make a fresh one.
    }

    const record = await createChat(MASTER_REPO_PATH, {
      model: model ?? MASTER_DEFAULT_MODEL,
      permissionMode: "bypassPermissions",
      title: "Master",
      kind: "master",
    });
    await setKeepWarm(MASTER_REPO_PATH, record.id, true).catch(() => null);
    await mkdir(BUILDOVER_DIR, { recursive: true });
    await atomicWrite(MASTER_FILE, {
      chatId: record.id,
      repoPath: MASTER_REPO_PATH,
      createdAt: new Date().toISOString(),
    } satisfies MasterRegistry);
    return {
      repoPath: MASTER_REPO_PATH,
      chatId: record.id,
      keepWarmHours: MASTER_KEEP_WARM_HOURS,
      model: record.model,
    };
  })();
  try {
    return await provisioning;
  } finally {
    provisioning = null;
  }
}

/** The master chat if it has been created, without creating one. */
export async function getMasterChat(): Promise<MasterInfo | null> {
  const existing = await readRegistry();
  if (!existing?.chatId) return null;
  const record = await readChat(MASTER_REPO_PATH, existing.chatId).catch(() => null);
  if (!record) return null;
  return {
    repoPath: MASTER_REPO_PATH,
    chatId: existing.chatId,
    keepWarmHours: MASTER_KEEP_WARM_HOURS,
    model: record.model,
  };
}

/**
 * Re-point the registry at a new master chat — used when the Master hands off
 * to a fresh chat so its context doesn't grow forever. The old transcript is
 * untouched; it just stops being *the* master chat.
 */
export async function setMasterChatId(chatId: string): Promise<void> {
  const existing = await readRegistry();
  await mkdir(BUILDOVER_DIR, { recursive: true });
  await atomicWrite(MASTER_FILE, {
    chatId,
    repoPath: MASTER_REPO_PATH,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  } satisfies MasterRegistry);
  await setKeepWarm(MASTER_REPO_PATH, chatId, true).catch(() => null);
}

// ── Cross-repo chat listing ────────────────────────────────────────────────

export interface AnyChatEntry {
  repoPath: string;
  repoName: string;
  chat: ChatSummary;
}

/**
 * Every chat in every known repo (recents plus any extra paths), newest first.
 * Driven off each repo's summary index, so no transcripts are read.
 */
export async function listChatsEverywhere(opts?: {
  /** Include subagent / coordinator chats. Default: user + coordinator only. */
  includeSubagents?: boolean;
  /** Include chats the user marked finished. Default false. */
  includeFinished?: boolean;
  extraRepoPaths?: string[];
}): Promise<AnyChatEntry[]> {
  const recents = await listRecents();
  const paths = new Set<string>(recents.map((r) => r.path));
  for (const p of opts?.extraRepoPaths ?? []) paths.add(p);
  paths.delete(MASTER_REPO_PATH); // the master never reports on itself

  const perRepo = await Promise.all(
    [...paths].map(async (repoPath): Promise<AnyChatEntry[]> => {
      const meta = await getRepoMeta(repoPath).catch(() => null);
      if (!meta) return [];
      const summaries = await listChats(repoPath).catch(() => [] as ChatSummary[]);
      return summaries
        .filter((c) => {
          if (c.kind === "master") return false;
          if (!opts?.includeSubagents && c.kind === "subagent") return false;
          if (!opts?.includeFinished && c.userMarkedFinished) return false;
          return true;
        })
        .map((chat) => ({ repoPath, repoName: meta.name, chat }));
    }),
  );
  return perRepo
    .flat()
    .sort(
      (a, b) =>
        new Date(b.chat.updatedAt).getTime() - new Date(a.chat.updatedAt).getTime(),
    );
}

/** Hours of warmth *budget* left on a chat (how long we've agreed to keep
 *  paying for pings), rounded up, or null when there is none. Distinct from
 *  warmMinutesLeft, which is the cache's own life. */
export function keepWarmHoursLeft(keepWarmUntil: string | undefined): number | null {
  if (!keepWarmUntil) return null;
  const ms = Date.parse(keepWarmUntil);
  if (!Number.isFinite(ms)) return null;
  const left = ms - Date.now();
  return left > 0 ? Math.max(1, Math.round(left / 3_600_000)) : null;
}

/** Minutes of prompt-cache life left for a chat, or null when already cold. */
export function warmMinutesLeft(lastApiAt: string | undefined): number | null {
  if (!lastApiAt) return null;
  const ms = Date.parse(lastApiAt);
  if (!Number.isFinite(ms)) return null;
  const left = ms + CACHE_TTL_MS - Date.now();
  return left > 0 ? Math.round(left / 60_000) : null;
}
