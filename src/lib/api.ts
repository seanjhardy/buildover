import type {
  ChatRecord,
  ChatSummary,
  Model,
  PermissionMode,
  RecentRepoInfo,
  RepoInfo,
  SearchResult,
  SearchIndexStatus,
} from "../types.js";

// ── Response cache & in-flight deduplication ──────────────────────────────────
// Eliminates redundant network requests when multiple callers fetch the same
// URL in a short window (e.g. badge polls + sidebar polls overlapping), and
// makes tab switches feel instant by serving fresh-enough cached responses.

interface _CacheEntry { data: unknown; expiresAt: number }
const _responseCache = new Map<string, _CacheEntry>();
const _inFlight = new Map<string, Promise<unknown>>();

/** Returns the cache TTL in ms for a given API path. 0 = no caching. */
function _getTtl(path: string): number {
  if (path.startsWith('/api/github/')) return 30_000;  // PR data changes slowly
  if (path.startsWith('/api/git/status')) return 5_000; // git status: short TTL
  if (path.startsWith('/api/git/log')) return 10_000;   // git log: medium TTL
  if (path.startsWith('/api/chats')) return 10_000;     // chat list: short TTL so repo switches are instant
  return 0;
}

/** Evict cached GET entries whose full URL contains the given substring. */
export function invalidateApiCache(urlSubstring: string): void {
  for (const key of _responseCache.keys()) {
    if (key.includes(urlSubstring)) _responseCache.delete(key);
  }
}

// In Electron production, the page is served from file:// so there is no
// implicit base URL for relative fetch() paths. Detect this and prefix all
// API calls with the explicit Express server origin.
function getApiBase(): string {
  return window.location.protocol === "file:" ? "http://localhost:8787" : "";
}

async function getJson<T>(path: string): Promise<T> {
  const url = getApiBase() + path;
  const ttl = _getTtl(path);

  // Serve from cache if the entry is still fresh.
  if (ttl > 0) {
    const hit = _responseCache.get(url);
    if (hit && hit.expiresAt > Date.now()) return hit.data as T;
  }

  // Deduplicate concurrent identical requests — return the same Promise.
  const existing = _inFlight.get(url);
  if (existing) return existing as Promise<T>;

  const promise = fetch(url)
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${res.status}: ${text || res.statusText}`);
      }
      const data = (await res.json()) as T;
      if (ttl > 0) {
        _responseCache.set(url, { data, expiresAt: Date.now() + ttl });
      }
      return data;
    })
    .finally(() => { _inFlight.delete(url); });

  _inFlight.set(url, promise);
  return promise as Promise<T>;
}

async function send<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(getApiBase() + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  // Invalidate related GET caches after any mutation so the next poll
  // fetches fresh data rather than serving a stale cached response.
  if (path.startsWith('/api/git/')) invalidateApiCache('/api/git/');
  if (path.startsWith('/api/github/')) invalidateApiCache('/api/github/');
  if (path.startsWith('/api/chats')) invalidateApiCache('/api/chats');
  return (await res.json()) as T;
}

// ── Dashboard & schedule types ─────────────────────────────────────────────

export interface DashboardNote {
  id: string;
  content: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  priority: "low" | "medium" | "high";
  createdAt: string;
  updatedAt: string;
}

export interface Dashboard {
  notes: DashboardNote[];
  todos: TodoItem[];
  updatedAt: string;
}

export interface ScheduledTask {
  id: string;
  label: string;
  cronExpression: string;
  prompt: string;
  repoPath: string;
  chatId?: string;
  model: Model;
  permissionMode: PermissionMode;
  enabled: boolean;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  pickFolder: () =>
    getJson<{ path: string | null }>(`/api/picker/folder`).then((r) => r.path),

  listRecents: () =>
    getJson<{ recents: RecentRepoInfo[] }>(`/api/repos/recents`).then(
      (r) => r.recents,
    ),

  openRepo: (path: string) =>
    send<{ repo: RepoInfo }>("POST", `/api/repos/open`, { path }).then(
      (r) => r.repo,
    ),

  removeRecent: (path: string) =>
    send<{ ok: boolean }>("DELETE", `/api/repos/recents`, { path }),

  listChats: (repoPath: string) =>
    getJson<{ chats: ChatSummary[] }>(
      `/api/chats?repoPath=${encodeURIComponent(repoPath)}`,
    ).then((r) => r.chats),

  createChat: (repoPath: string, model: Model, permissionMode: PermissionMode) =>
    send<{ chat: ChatRecord }>("POST", `/api/chats`, {
      repoPath,
      model,
      permissionMode,
    }).then((r) => r.chat),

  getChat: (repoPath: string, chatId: string) =>
    getJson<{ chat: ChatRecord }>(
      `/api/chats/${chatId}?repoPath=${encodeURIComponent(repoPath)}`,
    ).then((r) => r.chat),

  patchChat: (
    repoPath: string,
    chatId: string,
    body: { userMarkedFinished?: boolean; title?: string },
  ) =>
    send<{ chat: ChatRecord }>("PATCH", `/api/chats/${chatId}`, {
      repoPath,
      ...body,
    }).then((r) => r.chat),

  deleteChat: (repoPath: string, chatId: string) =>
    send<{ ok: boolean }>(
      "DELETE",
      `/api/chats/${chatId}?repoPath=${encodeURIComponent(repoPath)}`,
    ),

  // ── Dashboard ──────────────────────────────────────────────────────────
  getDashboard: () => getJson<Dashboard>(`/api/dashboard`),

  addNote: (content: string, pinned = false) =>
    send<DashboardNote>("POST", `/api/dashboard/notes`, { content, pinned }),

  updateNote: (id: string, patch: Partial<Pick<DashboardNote, "content" | "pinned">>) =>
    send<DashboardNote>("PATCH", `/api/dashboard/notes/${id}`, patch),

  deleteNote: (id: string) =>
    send<{ ok: boolean }>("DELETE", `/api/dashboard/notes/${id}`),

  addTodo: (text: string, priority: TodoItem["priority"] = "medium") =>
    send<TodoItem>("POST", `/api/dashboard/todos`, { text, priority }),

  updateTodo: (id: string, patch: Partial<Pick<TodoItem, "text" | "done" | "priority">>) =>
    send<TodoItem>("PATCH", `/api/dashboard/todos/${id}`, patch),

  deleteTodo: (id: string) =>
    send<{ ok: boolean }>("DELETE", `/api/dashboard/todos/${id}`),

  // ── Schedules ──────────────────────────────────────────────────────────
  listSchedules: () =>
    getJson<{ tasks: ScheduledTask[] }>(`/api/schedules`).then((r) => r.tasks),

  createSchedule: (task: Omit<ScheduledTask, "id" | "createdAt" | "updatedAt" | "lastRunAt">) =>
    send<ScheduledTask>("POST", `/api/schedules`, task),

  updateSchedule: (id: string, patch: Partial<Omit<ScheduledTask, "id" | "createdAt">>) =>
    send<ScheduledTask>("PATCH", `/api/schedules/${id}`, patch),

  deleteSchedule: (id: string) =>
    send<{ ok: boolean }>("DELETE", `/api/schedules/${id}`),
};

// ── Semantic search ────────────────────────────────────────────────────────────
// ── Env var management ─────────────────────────────────────────────────────
export const envApi = {
  getStatus: () =>
    getJson<{ status: Record<string, boolean> }>(`/api/env/status`).then(
      (r) => r.status,
    ),
  setVar: (key: string, value: string) =>
    send<{ ok: boolean }>("POST", `/api/env/set`, { key, value }),
};

export const searchApi = {
  search: (repoPath: string, query: string, limit = 12) =>
    send<{ results: SearchResult[]; status: SearchIndexStatus }>(
      "POST",
      `/api/search`,
      { repoPath, query, limit },
    ),

  status: (repoPath: string) =>
    getJson<SearchIndexStatus>(
      `/api/search/status?repoPath=${encodeURIComponent(repoPath)}`,
    ),
};

export interface GitStatus {
  currentBranch: string;
  branches: string[];
  ahead: number;
  behind: number;
  isDirty: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorDate: string;
  refs: string;
  parents: string[];
}

export interface GitLogResult {
  commits: GitCommit[];
  currentBranch: string;
}

export interface FileDiffStat {
  added: number;
  removed: number;
}

export interface CommitDiffFile {
  filename: string;
  added: number;
  removed: number;
}

export const fileApi = {
  readFile: (filePath: string) =>
    getJson<{ content: string }>(
      `/api/file/read?path=${encodeURIComponent(filePath)}`,
    ).then((r) => r.content),

  listFiles: (repoPath: string) =>
    getJson<{ files: string[] }>(
      `/api/file/list?path=${encodeURIComponent(repoPath)}`,
    ).then((r) => r.files),
};

export interface ChangedFile {
  path: string;
  staged: boolean;
  unstaged: boolean;
  statusCode: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  reviewDecision: string | null;
  statusCheckRollup: 'SUCCESS' | 'FAILURE' | 'PENDING' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  comments: Array<{ id: string; author: string; body: string; createdAt: string }>;
}

export const gitApi = {
  getStatus: (repoPath: string) =>
    getJson<GitStatus>(
      `/api/git/status?repoPath=${encodeURIComponent(repoPath)}`,
    ),

  getStatusFiles: (repoPath: string) =>
    getJson<{ files: ChangedFile[] }>(
      `/api/git/status-files?repoPath=${encodeURIComponent(repoPath)}`,
    ).then((r) => r.files),

  checkout: (repoPath: string, branch: string) =>
    send<{ ok: boolean }>("POST", `/api/git/checkout`, { repoPath, branch }),

  commit: (repoPath: string, message: string) =>
    send<{ ok: boolean }>("POST", `/api/git/commit`, { repoPath, message }),

  push: (repoPath: string) =>
    send<{ ok: boolean }>("POST", `/api/git/push`, { repoPath }),

  forcePush: (repoPath: string) =>
    send<{ ok: boolean }>("POST", `/api/git/force-push`, { repoPath }),

  pull: (repoPath: string) =>
    send<{ ok: boolean }>("POST", `/api/git/pull`, { repoPath }),

  fetch: (repoPath: string) =>
    send<{ ok: boolean }>("POST", `/api/git/fetch`, { repoPath }),

  getDiffStat: (repoPath: string, relPaths: string[]) =>
    getJson<{ stats: Record<string, FileDiffStat> }>(
      `/api/git/diff-stat?repoPath=${encodeURIComponent(repoPath)}&files=${encodeURIComponent(relPaths.join(","))}`,
    ).then((r) => r.stats),

  getDiff: (repoPath: string, relPath: string) =>
    getJson<{ addedLines: number[]; removedGroups: { after: number; lines: string[] }[] }>(
      `/api/git/diff?repoPath=${encodeURIComponent(repoPath)}&file=${encodeURIComponent(relPath)}`,
    ),

  getLog: (repoPath: string, limit = 150) =>
    getJson<GitLogResult>(
      `/api/git/log?repoPath=${encodeURIComponent(repoPath)}&limit=${limit}`,
    ),

  createBranch: (repoPath: string, name: string, fromHash?: string) =>
    send<{ ok: boolean }>("POST", `/api/git/branch`, { repoPath, name, fromHash }),

  deleteBranch: (repoPath: string, name: string) =>
    send<{ ok: boolean }>("DELETE", `/api/git/branch`, { repoPath, name }),

  cherryPick: (repoPath: string, hash: string) =>
    send<{ ok: boolean }>("POST", `/api/git/cherry-pick`, { repoPath, hash }),

  revert: (repoPath: string, hash: string) =>
    send<{ ok: boolean }>("POST", `/api/git/revert`, { repoPath, hash }),

  merge: (repoPath: string, ref: string) =>
    send<{ ok: boolean }>("POST", `/api/git/merge`, { repoPath, ref }),

  rebase: (repoPath: string, onto: string) =>
    send<{ ok: boolean }>("POST", `/api/git/rebase`, { repoPath, onto }),

  reset: (repoPath: string, hash: string, mode: "soft" | "mixed" | "hard") =>
    send<{ ok: boolean }>("POST", `/api/git/reset`, { repoPath, hash, mode }),

  getCommitDiff: (repoPath: string, hash: string) =>
    getJson<{ files: CommitDiffFile[] }>(
      `/api/git/commit-diff?repoPath=${encodeURIComponent(repoPath)}&hash=${encodeURIComponent(hash)}`,
    ).then((r) => r.files),

  getCommitFileDiff: (repoPath: string, hash: string, file: string) =>
    getJson<{ diff: string }>(
      `/api/git/commit-file-diff?repoPath=${encodeURIComponent(repoPath)}&hash=${encodeURIComponent(hash)}&file=${encodeURIComponent(file)}`,
    ).then((r) => r.diff),

  generateCommitMessage: (repoPath: string) =>
    send<{ message: string }>("POST", `/api/git/generate-commit-message`, { repoPath })
      .then((r) => r.message),
};

export const githubApi = {
  listPRs: (repoPath: string) =>
    getJson<{ prs: GitHubPR[] }>(
      `/api/github/prs?repoPath=${encodeURIComponent(repoPath)}`,
    ).then((r) => r.prs),

  getPR: (repoPath: string, number: number) =>
    getJson<{ pr: GitHubPR }>(
      `/api/github/pr?repoPath=${encodeURIComponent(repoPath)}&number=${number}`,
    ).then((r) => r.pr),

  mergePR: (repoPath: string, number: number, method: 'merge' | 'squash' | 'rebase') =>
    send<{ ok: boolean }>('POST', '/api/github/pr/merge', { repoPath, number, method }),

  addComment: (repoPath: string, number: number, body: string) =>
    send<{ ok: boolean }>('POST', '/api/github/pr/comment', { repoPath, number, body }),

  updateBranch: (repoPath: string, number: number) =>
    send<{ ok: boolean }>('POST', '/api/github/pr/update-branch', { repoPath, number }),
};

// ── Self-update ────────────────────────────────────────────────────────────────

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface SelfUpdateStatus {
  hasUpdate: boolean;
  localSHA: string;
  remoteSHA: string;
  commits: CommitInfo[];
  isDirty: boolean;
  localDiff?: string;
  error?: string;
  checkedAt: string;
}

export const selfUpdateApi = {
  getStatus: () =>
    getJson<SelfUpdateStatus>(`/api/self/status`),

  getInfo: () =>
    getJson<{ appRoot: string }>(`/api/self/info`),

  pull: () =>
    send<{ success: boolean; output: string }>("POST", `/api/self/pull`),

  forcePull: () =>
    send<{ success: boolean; output: string }>("POST", `/api/self/force-pull`),
};

// ── Run config ─────────────────────────────────────────────────────────────────

export interface RunConfig {
  repoPath: string;
  previewUrl?: string;
  devPort?: number;
  createdAt: string;
  updatedAt: string;
}

export const runConfigApi = {
  getConfig: (repoPath: string) =>
    getJson<{ config: RunConfig | null }>(
      `/api/run-config?repoPath=${encodeURIComponent(repoPath)}`,
    ).then((r) => r.config),

  getHtml: (repoPath: string) =>
    getJson<{ html: string | null }>(
      `/api/run-config/html?repoPath=${encodeURIComponent(repoPath)}`,
    ).then((r) => r.html),

  checkPort: (port: number) =>
    getJson<{ listening: boolean }>(`/api/port-status?port=${port}`),

  killPort: (port: number) =>
    send<{ ok: boolean }>("POST", `/api/kill-port`, { port }),
};
