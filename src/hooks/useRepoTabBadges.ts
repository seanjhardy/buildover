import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatStatus, ChatSummary } from "../types.js";

const SEEN_KEY = "buildover.repoTabSeen";

// Priority order: highest priority first. Only these statuses trigger a badge.
const BADGE_PRIORITY: ChatStatus[] = [
  "awaiting_input",
  "error",
  "running",
  "agent_done",
];

// Shape persisted to localStorage:
//   Record<repoPath, Record<chatId, ChatStatus>>
type SeenState = Record<string, Record<string, ChatStatus>>;

function loadSeenState(): SeenState {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as SeenState;
  } catch {
    return {};
  }
}

function persistSeenState(state: SeenState): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

/**
 * Computes which status badge (if any) to show on each repo tab.
 *
 * A badge appears on an inactive tab when one or more chats in that repo
 * have a notable status that changed since the user last viewed the tab.
 *
 * Priority: awaiting_input > error > running > agent_done
 */
export function useRepoTabBadges(
  openRepoPaths: string[],
  activeRepoPath: string | null,
  chatsByRepo: Record<string, ChatSummary[]>,
): {
  badges: Record<string, ChatStatus | null>;
  markSeen: (repoPath: string) => void;
} {
  const [seenState, setSeenState] = useState<SeenState>(() =>
    loadSeenState(),
  );

  // Keep a ref so markSeen always has current chatsByRepo without stale closure.
  const chatsByRepoRef = useRef(chatsByRepo);
  chatsByRepoRef.current = chatsByRepo;

  const seenStateRef = useRef(seenState);
  seenStateRef.current = seenState;

  // Persist to localStorage whenever seenState changes.
  useEffect(() => {
    persistSeenState(seenState);
  }, [seenState]);

  // Mark a repo as "seen" — snapshot all current chat statuses for that repo.
  const markSeen = useCallback((repoPath: string) => {
    const chats = chatsByRepoRef.current[repoPath] ?? [];
    const snapshot: Record<string, ChatStatus> = {};
    for (const chat of chats) {
      snapshot[chat.id] = chat.status;
    }
    setSeenState((prev) => {
      const next = { ...prev, [repoPath]: snapshot };
      persistSeenState(next);
      return next;
    });
  }, []);

  // When the active tab changes, mark the newly active repo as seen.
  const prevActiveRepoPath = useRef<string | null>(null);
  useEffect(() => {
    if (
      activeRepoPath &&
      activeRepoPath !== prevActiveRepoPath.current
    ) {
      markSeen(activeRepoPath);
    }
    prevActiveRepoPath.current = activeRepoPath;
  }, [activeRepoPath, markSeen]);

  // Compute badges for each repo.
  const badges: Record<string, ChatStatus | null> = {};
  for (const repoPath of openRepoPaths) {
    // Active tab is never badged.
    if (repoPath === activeRepoPath) {
      badges[repoPath] = null;
      continue;
    }

    const chats = chatsByRepo[repoPath] ?? [];
    const seen = seenState[repoPath] ?? {};

    // Find the highest-priority status change since last view.
    let topBadge: ChatStatus | null = null;
    let topPriority = Infinity;

    for (const chat of chats) {
      const priority = BADGE_PRIORITY.indexOf(chat.status);
      if (priority === -1) continue; // not a notable status

      const seenStatus = seen[chat.id];
      const isNew = seenStatus === undefined;
      const changed = seenStatus !== chat.status;

      if ((isNew || changed) && priority < topPriority) {
        topPriority = priority;
        topBadge = chat.status;
      }
    }

    badges[repoPath] = topBadge;
  }

  return { badges, markSeen };
}
