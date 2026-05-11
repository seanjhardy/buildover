import type {
  ChatRecord,
  ChatSummary,
  Model,
  PermissionMode,
  RecentRepoInfo,
  RepoInfo,
} from "../types.js";

// In Electron production, the page is served from file:// so there is no
// implicit base URL for relative fetch() paths. Detect this and prefix all
// API calls with the explicit Express server origin.
function getApiBase(): string {
  return window.location.protocol === "file:" ? "http://localhost:8787" : "";
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(getApiBase() + path);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
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

export const fileApi = {
  readFile: (filePath: string) =>
    getJson<{ content: string }>(
      `/api/file/read?path=${encodeURIComponent(filePath)}`,
    ).then((r) => r.content),
};

export const gitApi = {
  getStatus: (repoPath: string) =>
    getJson<GitStatus>(
      `/api/git/status?repoPath=${encodeURIComponent(repoPath)}`,
    ),

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
};
