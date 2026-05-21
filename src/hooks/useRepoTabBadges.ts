import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatStatus, ChatSummary } from "../types.js";

const SEEN_KEY = "buildover.repoTabSeen";

// Priority order for the always-visible tab icon: highest priority first.
// Only these statuses show an icon; idle/finished show nothing.
// "awaiting_input" ranks above "running" because a chat blocking on user
// input is more urgent — the user must act before work can continue.
const ICON_PRIORITY: ChatStatus[] = [
  "awaiting_input", // Highest — agent is blocked, user must respond
  "running",        // Agent is actively working
  "error",          // Something went wrong
  "agent_done",     // Agent finished, awaiting user follow-up
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
 * Computes which status icon to show on each repo tab.
 *
 * The icon always reflects the most important active status across all chats
 * in that repo, using the priority: running > awaiting_input > error > agent_done.
 * This is shown on ALL tabs (active and inactive) so the user always knows
 * what's happening at a glance.
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

  // Compute the most important status icon for each repo (all tabs, active or not).
  const badges: Record<string, ChatStatus | null> = {};
  for (const repoPath of openRepoPaths) {
    const chats = chatsByRepo[repoPath] ?? [];

    let topBadge: ChatStatus | null = null;
    let topPriority = Infinity;

    for (const chat of chats) {
      const priority = ICON_PRIORITY.indexOf(chat.status);
      if (priority === -1) continue; // idle/finished — no icon needed

      if (priority < topPriority) {
        topPriority = priority;
        topBadge = chat.status;
      }
    }

    badges[repoPath] = topBadge;
  }

  return { badges, markSeen };
}
