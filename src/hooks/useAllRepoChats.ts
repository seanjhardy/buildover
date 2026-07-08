import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { agentSocket } from "../lib/agentSocket.js";
import type { AgentEvent, ChatSummary } from "../types.js";

/**
 * Manages live chat lists for multiple repos simultaneously.
 * Returns a map of repoPath → ChatSummary[] with live status updates
 * via WebSocket subscriptions (same mechanism as useChats, but for all
 * open repos so inactive tabs can show badge indicators).
 */
export function useAllRepoChats(
  openRepoPaths: string[],
): Record<string, ChatSummary[]> {
  const [chatsByRepo, setChatsByRepo] = useState<Record<string, ChatSummary[]>>(
    {},
  );

  // Keep a stable ref so subscription callbacks don't close over stale values.
  const chatsByRepoRef = useRef(chatsByRepo);
  chatsByRepoRef.current = chatsByRepo;

  // Track subscribed chat IDs across all repos so we don't double-subscribe.
  const subscribedRef = useRef<Set<string>>(new Set());

  // Track which repo paths we currently have loaded so we can clean up removed ones.
  const openRepoPathsRef = useRef<string[]>(openRepoPaths);
  openRepoPathsRef.current = openRepoPaths;

  // Use a stable key to detect when the set of repos changes.
  const pathsKey = openRepoPaths.slice().sort().join("|");

  useEffect(() => {
    const paths = openRepoPaths;
    if (paths.length === 0) return;

    const cleanups: (() => void)[] = [];
    const subscribed = subscribedRef.current;

    // Subscribe to a specific list of chats for a repo. Unlike subscribeNewChats
    // below, this takes a list directly so callers can subscribe immediately after
    // a REST fetch without waiting for the chatsByRepoRef to update (React state
    // updates are async, so the ref may still hold the old value at call time).
    function subscribeChats(repoPath: string, chats: ChatSummary[]) {
      for (const chat of chats) {
        if (subscribed.has(chat.id)) continue;
        subscribed.add(chat.id);

        const handler = (event: AgentEvent) => {
          // Only apply if this repo is still open.
          if (!openRepoPathsRef.current.includes(repoPath)) return;
          applyEventToMap(setChatsByRepo, repoPath, event);
        };

        const unsubscribeListener = agentSocket.onChatEvent(chat.id, handler);
        agentSocket.send({
          type: "subscribe",
          chatId: chat.id,
          repoPath,
          withReplay: false,
        });

        cleanups.push(() => {
          unsubscribeListener();
          subscribed.delete(chat.id);
          setTimeout(
            () => agentSocket.send({ type: "unsubscribe", chatId: chat.id }),
            0,
          );
        });
      }
    }

    // Wire up WS subscriptions for any chats now in the ref that aren't yet
    // subscribed. Used by the interval to catch any stragglers.
    function subscribeNewChats() {
      const currentPaths = openRepoPathsRef.current;
      for (const repoPath of currentPaths) {
        subscribeChats(repoPath, chatsByRepoRef.current[repoPath] ?? []);
      }
    }

    // Fetch initial chat list for repos we don't have data for yet. We subscribe
    // immediately using the fetched list (not via chatsByRepoRef, which won't
    // reflect the setChatsByRepo call until after the next React render).
    for (const repoPath of paths) {
      void api.listChats(repoPath).then((list) => {
        setChatsByRepo((prev) => ({ ...prev, [repoPath]: list }));
        subscribeChats(repoPath, list);
      });
    }

    // Periodically re-fetch to pick up chats created since the last fetch.
    // We deliberately only ADD new chats — existing chats' live statuses come
    // from WS events and must not be overwritten with potentially stale REST data.
    const interval = setInterval(async () => {
      const currentPaths = openRepoPathsRef.current;
      for (const repoPath of currentPaths) {
        try {
          const list = await api.listChats(repoPath);
          // Dedup against the *current* state inside the updater, not the ref:
          // the ref lags an uncommitted setChatsByRepo, so basing the merge on
          // it can re-append ids already present in `prev` and duplicate rows.
          setChatsByRepo((prev) => {
            const existing = prev[repoPath] ?? [];
            const knownIds = new Set(existing.map((c) => c.id));
            const freshChats = list.filter((c) => !knownIds.has(c.id));
            if (freshChats.length === 0) return prev;
            return { ...prev, [repoPath]: [...existing, ...freshChats] };
          });
          // subscribeChats skips ids already subscribed, so passing the full
          // list is safe and catches any that slipped through earlier ticks.
          subscribeChats(repoPath, list);
        } catch {
          // Network error — skip this tick.
        }
      }
      // Also catch any chats that slipped through (e.g. ref updated between ticks).
      subscribeNewChats();
    }, 30_000);

    // On reconnect, re-fetch all repos so badges stay accurate after restarts.
    const unsubReconnect = agentSocket.onReconnect(() => {
      for (const repoPath of openRepoPathsRef.current) {
        void api.listChats(repoPath).then((list) => {
          setChatsByRepo((prev) => ({ ...prev, [repoPath]: list }));
          subscribeChats(repoPath, list);
        });
      }
    });

    return () => {
      clearInterval(interval);
      unsubReconnect();
      for (const fn of cleanups) fn();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey]);

  // Clean up stale repo entries when repos are closed.
  useEffect(() => {
    setChatsByRepo((prev) => {
      const next: Record<string, ChatSummary[]> = {};
      for (const path of openRepoPaths) {
        if (prev[path]) next[path] = prev[path];
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey]);

  return chatsByRepo;
}

function applyEventToMap(
  setChatsByRepo: React.Dispatch<
    React.SetStateAction<Record<string, ChatSummary[]>>
  >,
  repoPath: string,
  event: AgentEvent,
): void {
  switch (event.type) {
    case "chat_status":
      setChatsByRepo((prev) => {
        const chats = prev[repoPath];
        if (!chats) return prev;
        return {
          ...prev,
          [repoPath]: chats.map((c) =>
            c.id === event.chatId
              ? {
                  ...c,
                  status: event.status,
                  sessionId: event.sessionId ?? c.sessionId,
                }
              : c,
          ),
        };
      });
      break;
    case "chat_title":
      setChatsByRepo((prev) => {
        const chats = prev[repoPath];
        if (!chats) return prev;
        return {
          ...prev,
          [repoPath]: chats.map((c) =>
            c.id === event.chatId ? { ...c, title: event.title } : c,
          ),
        };
      });
      break;
    case "user_message_echo":
      setChatsByRepo((prev) => {
        const chats = prev[repoPath];
        if (!chats) return prev;
        return {
          ...prev,
          [repoPath]: chats.map((c) =>
            c.id === event.chatId
              ? {
                  ...c,
                  preview: (event.text + " " + c.preview).slice(0, 600),
                  updatedAt: new Date().toISOString(),
                }
              : c,
          ),
        };
      });
      break;
  }
}
