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

    // Wire up WS subscriptions for newly discovered chats across all repos.
    function subscribeNewChats() {
      const currentPaths = openRepoPathsRef.current;
      for (const repoPath of currentPaths) {
        const chats = chatsByRepoRef.current[repoPath] ?? [];
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
    }

    // Fetch initial chat list for repos we don't have data for yet, then
    // immediately subscribe so we don't miss events during the async gap.
    for (const repoPath of paths) {
      void api.listChats(repoPath).then((list) => {
        setChatsByRepo((prev) => ({ ...prev, [repoPath]: list }));
        // Subscribe right after the list is known so we minimise the window
        // between the REST snapshot and live WS event delivery.
        subscribeNewChats();
      });
    }

    const interval = setInterval(subscribeNewChats, 2000);

    // On reconnect, re-fetch all repos so badges stay accurate after restarts.
    const unsubReconnect = agentSocket.onReconnect(() => {
      for (const repoPath of openRepoPathsRef.current) {
        void api.listChats(repoPath).then((list) => {
          setChatsByRepo((prev) => ({ ...prev, [repoPath]: list }));
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
