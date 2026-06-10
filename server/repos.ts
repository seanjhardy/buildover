import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export interface RepoMeta {
  id: string;
  path: string;
  name: string;
  createdAt: string;
}

export interface RecentRepo {
  path: string;
  name: string;
  lastOpenedAt: string;
}

const BUILDOVER_HOME = join(homedir(), ".buildover");
const RECENTS_DIR = BUILDOVER_HOME;
const RECENTS_FILE = join(RECENTS_DIR, "recents.json");
const RECENTS_LIMIT = 20;
const REPOS_DATA_DIR = join(BUILDOVER_HOME, "repos");

function repoBuildoverDir(repoPath: string): string {
  const name = basename(repoPath) || "unnamed";
  return join(REPOS_DATA_DIR, name);
}

function repoMetaPath(repoPath: string): string {
  return join(repoBuildoverDir(repoPath), "meta.json");
}

export function chatsDir(repoPath: string): string {
  return join(repoBuildoverDir(repoPath), "chats");
}

export function indexPath(repoPath: string): string {
  return join(chatsDir(repoPath), "index.json");
}

/** Per-repo plans/tickets file used by the coordinator workflow. */
export function plansPath(repoPath: string): string {
  return join(repoBuildoverDir(repoPath), "plans.json");
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function normalizePath(p: string): string {
  return resolve(p);
}

export async function ensureRepo(rawPath: string): Promise<RepoMeta> {
  if (!rawPath || !isAbsolute(rawPath)) {
    throw new Error("Repo path must be absolute");
  }
  const path = normalizePath(rawPath);
  const s = await stat(path).catch(() => null);
  if (!s || !s.isDirectory()) {
    throw new Error(`Not a directory: ${path}`);
  }
  await mkdir(chatsDir(path), { recursive: true });

  const existing = await readJson<RepoMeta>(repoMetaPath(path));
  if (existing) {
    if (existing.path !== path) {
      const updated: RepoMeta = { ...existing, path };
      await writeJson(repoMetaPath(path), updated);
      return updated;
    }
    return existing;
  }

  const meta: RepoMeta = {
    id: `repo_${Math.random().toString(36).slice(2, 10)}`,
    path,
    name: basename(path) || path,
    createdAt: new Date().toISOString(),
  };
  await writeJson(repoMetaPath(path), meta);
  return meta;
}

export async function getRepoMeta(repoPath: string): Promise<RepoMeta | null> {
  return readJson<RepoMeta>(repoMetaPath(normalizePath(repoPath)));
}

async function readRecents(): Promise<RecentRepo[]> {
  const data = await readJson<{ recents: RecentRepo[] }>(RECENTS_FILE);
  return data?.recents ?? [];
}

async function writeRecents(recents: RecentRepo[]): Promise<void> {
  await mkdir(RECENTS_DIR, { recursive: true });
  await writeJson(RECENTS_FILE, { recents });
}

export async function listRecents(): Promise<RecentRepo[]> {
  const recents = await readRecents();
  // Drop entries whose directory no longer exists.
  const checked = await Promise.all(
    recents.map(async (r) => {
      const s = await stat(r.path).catch(() => null);
      return s?.isDirectory() ? r : null;
    }),
  );
  return checked.filter((r): r is RecentRepo => r !== null);
}

export async function touchRecent(meta: RepoMeta): Promise<void> {
  const recents = await readRecents();
  const filtered = recents.filter((r) => r.path !== meta.path);
  filtered.unshift({
    path: meta.path,
    name: meta.name,
    lastOpenedAt: new Date().toISOString(),
  });
  await writeRecents(filtered.slice(0, RECENTS_LIMIT));
}

export async function removeRecent(path: string): Promise<void> {
  const target = normalizePath(path);
  const recents = await readRecents();
  await writeRecents(recents.filter((r) => r.path !== target));
}
