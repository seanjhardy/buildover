import type {
  ChatRecord,
  ChatSummary,
  Model,
  PermissionMode,
  RecentRepoInfo,
  RepoInfo,
} from "../types.js";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
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
  const res = await fetch(path, {
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
};
