import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { RecentRepoInfo, RepoInfo } from "../types.js";

const STORAGE_KEY = "buildover.workspace";

interface PersistedState {
  openRepos: RepoInfo[];
  activeRepoPath: string | null;
  activeChatByRepo: Record<string, string | null>;
}

function loadPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      openRepos: Array.isArray(parsed.openRepos) ? parsed.openRepos : [],
      activeRepoPath: parsed.activeRepoPath ?? null,
      activeChatByRepo:
        parsed.activeChatByRepo && typeof parsed.activeChatByRepo === "object"
          ? parsed.activeChatByRepo
          : {},
    };
  } catch {
    return defaultState();
  }
}

function defaultState(): PersistedState {
  return { openRepos: [], activeRepoPath: null, activeChatByRepo: {} };
}

function persist(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

export interface UseWorkspaceReturn {
  openRepos: RepoInfo[];
  activeRepo: RepoInfo | null;
  activeChatId: string | null;
  recents: RecentRepoInfo[];
  reloadRecents: () => Promise<void>;
  openRepo: (path: string) => Promise<RepoInfo>;
  closeRepo: (path: string) => void;
  setActiveRepo: (path: string) => void;
  setActiveChat: (chatId: string | null) => void;
  reorderRepos: (fromPath: string, toPath: string) => void;
}

export function useWorkspace(): UseWorkspaceReturn {
  const [state, setState] = useState<PersistedState>(() => loadPersisted());
  const [recents, setRecents] = useState<RecentRepoInfo[]>([]);

  // Defer persistence to avoid blocking the render that triggered the state
  // change (e.g. switching repo tabs, which is latency-sensitive).
  useEffect(() => {
    const id = setTimeout(() => persist(state), 0);
    return () => clearTimeout(id);
  }, [state]);

  const reloadRecents = useCallback(async () => {
    try {
      setRecents(await api.listRecents());
    } catch {
      setRecents([]);
    }
  }, []);

  useEffect(() => {
    void reloadRecents();
  }, [reloadRecents]);

  const openRepo = useCallback(
    async (path: string) => {
      const repo = await api.openRepo(path);
      setState((prev) => {
        const exists = prev.openRepos.some((r) => r.path === repo.path);
        const openRepos = exists
          ? prev.openRepos
          : [...prev.openRepos, repo];
        return {
          ...prev,
          openRepos,
          activeRepoPath: repo.path,
        };
      });
      void reloadRecents();
      return repo;
    },
    [reloadRecents],
  );

  const closeRepo = useCallback((path: string) => {
    setState((prev) => {
      const openRepos = prev.openRepos.filter((r) => r.path !== path);
      const activeRepoPath =
        prev.activeRepoPath === path
          ? (openRepos[0]?.path ?? null)
          : prev.activeRepoPath;
      const { [path]: _drop, ...rest } = prev.activeChatByRepo;
      return { ...prev, openRepos, activeRepoPath, activeChatByRepo: rest };
    });
  }, []);

  const setActiveRepo = useCallback((path: string) => {
    setState((prev) => ({ ...prev, activeRepoPath: path }));
  }, []);

  const setActiveChat = useCallback(
    (chatId: string | null) => {
      setState((prev) => {
        if (!prev.activeRepoPath) return prev;
        return {
          ...prev,
          activeChatByRepo: {
            ...prev.activeChatByRepo,
            [prev.activeRepoPath]: chatId,
          },
        };
      });
    },
    [],
  );

  const reorderRepos = useCallback((fromPath: string, toPath: string) => {
    setState((prev) => {
      const openRepos = [...prev.openRepos];
      const fromIndex = openRepos.findIndex((r) => r.path === fromPath);
      const toIndex = openRepos.findIndex((r) => r.path === toPath);
      if (fromIndex === -1 || toIndex === -1) return prev;
      const [moved] = openRepos.splice(fromIndex, 1);
      openRepos.splice(toIndex, 0, moved);
      return { ...prev, openRepos };
    });
  }, []);

  const activeRepo =
    state.openRepos.find((r) => r.path === state.activeRepoPath) ?? null;
  const activeChatId = activeRepo
    ? (state.activeChatByRepo[activeRepo.path] ?? null)
    : null;

  return {
    openRepos: state.openRepos,
    activeRepo,
    activeChatId,
    recents,
    reloadRecents,
    openRepo,
    closeRepo,
    setActiveRepo,
    setActiveChat,
    reorderRepos,
  };
}
