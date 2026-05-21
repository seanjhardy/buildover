import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { agentSocket } from "../lib/agentSocket.js";
import type {
  AgentEvent,
  ChatRecord,
  ChatSummary,
  Model,
  PermissionMode,
} from "../types.js";

export interface UseChatsReturn {
  chats: ChatSummary[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  createChat: (
    model: Model,
    permissionMode: PermissionMode,
  ) => Promise<ChatRecord>;
  setUserFinished: (chatId: string, finished: boolean) => Promise<void>;
  rename: (chatId: string, title: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
}

// Lists chats in a repo and keeps their statuses live by subscribing to each
// chat's WS event stream (without replay). Status / title updates are pushed
// back into the local summary list as they arrive.
//
// `prefetchedList` — optional chat list already in memory (e.g. from
// useAllRepoChats). When provided it seeds the initial state so the sidebar
// renders immediately on repo switch, while a background fetch refreshes it.
export function useChats(
  repoPath: string | null,
  prefetchedList?: ChatSummary[] | null,
): UseChatsReturn {
  const [chats, setChats] = useState<ChatSummary[]>(() => prefetchedList ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When we switch to a new repo and already have prefetched data, apply it
  // immediately so the sidebar is populated before the HTTP request finishes.
  const prevRepoRef = useRef<string | null>(null);
  useEffect(() => {
    if (repoPath !== prevRepoRef.current) {
      prevRepoRef.current = repoPath;
      if (prefetchedList && prefetchedList.length > 0) {
        setChats(prefetchedList);
      }
    }
  // We intentionally only re-run on repoPath change, not on every prefetchedList update
  // (live WS updates own that from here on).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);
  // Track which chatIds we've already wired live listeners for. Cleaned up
  // when the repoPath changes or the component unmounts.
  const subscribedRef = useRef<Set<string>>(new Set());
  // Maps chatId → cleanup fn so we can tear down a single chat's subscription
  // immediately when it is deleted (without waiting for the effect to re-run).
  const cleanupMapRef = useRef<Map<string, () => void>>(new Map());
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;

  const reload = useCallback(async () => {
    if (!repoPath) {
      setChats([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await api.listChats(repoPath);
      setChats(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // When the socket reconnects after a server restart, re-fetch the chat list
  // so the sidebar immediately reflects any status changes (e.g. "running" →
  // "error") that were written to disk during stale recovery. Without this,
  // chats the user isn't actively viewing never receive a chat_status event
  // because they're subscribed with withReplay: false.
  useEffect(() => {
    return agentSocket.onReconnect(() => {
      void reload();
    });
  }, [reload]);

  // Subscribe to live status updates for each chat in the list.
  // We use a ref for chats so we can subscribe to newly-created chats without
  // re-running the effect on every status update (which would cause a
  // subscribe/unsubscribe feedback loop on every incoming WS event).
  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  useEffect(() => {
    if (!repoPath) return;

    // Wire up any chats that aren't subscribed yet. Called on mount and
    // whenever a new chat is added via the chats ref.
    const subscribed = subscribedRef.current;
    const cleanupMap = cleanupMapRef.current;

    function subscribeNewChats() {
      for (const chat of chatsRef.current) {
        if (subscribed.has(chat.id)) continue;
        subscribed.add(chat.id);
        const handler = (event: AgentEvent) => {
          if (repoPathRef.current !== repoPath) return;
          applyEventToList(setChats, event);
        };
        const unsubscribeListener = agentSocket.onChatEvent(chat.id, handler);
        agentSocket.send({
          type: "subscribe",
          chatId: chat.id,
          repoPath: repoPath!, // guarded by `if (!repoPath) return` above
          withReplay: false,
        });
        const cleanup = () => {
          unsubscribeListener();
          subscribed.delete(chat.id);
          cleanupMap.delete(chat.id);
          // Defer the unsubscribe WS message so the cleanup loop doesn't
          // block the React render that responds to the repo tab switch.
          setTimeout(() => agentSocket.send({ type: "unsubscribe", chatId: chat.id }), 0);
        };
        cleanupMap.set(chat.id, cleanup);
      }
    }

    subscribeNewChats();

    // Also subscribe any chats that arrive after initial load (e.g. newly
    // created chats) by checking the ref on a short interval.
    const interval = setInterval(subscribeNewChats, 2000);

    return () => {
      clearInterval(interval);
      for (const fn of cleanupMap.values()) fn();
    };
  }, [repoPath]);

  // Reset subscriptions on repo change.
  useEffect(() => {
    return () => {
      subscribedRef.current = new Set();
    };
  }, [repoPath]);

  const createChat = useCallback(
    async (model: Model, permissionMode: PermissionMode) => {
      if (!repoPath) throw new Error("No active repo");
      const record = await api.createChat(repoPath, model, permissionMode);
      setChats((prev) => [recordToSummary(record), ...prev]);
      return record;
    },
    [repoPath],
  );

  const setUserFinished = useCallback(
    async (chatId: string, finished: boolean) => {
      if (!repoPath) return;
      const updated = await api.patchChat(repoPath, chatId, {
        userMarkedFinished: finished,
      });
      setChats((prev) =>
        prev.map((c) => (c.id === chatId ? recordToSummary(updated) : c)),
      );
    },
    [repoPath],
  );

  const rename = useCallback(
    async (chatId: string, title: string) => {
      if (!repoPath) return;
      const updated = await api.patchChat(repoPath, chatId, { title });
      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId
            ? { ...c, title: updated.title, updatedAt: updated.updatedAt }
            : c,
        ),
      );
    },
    [repoPath],
  );

  const deleteChat = useCallback(
    async (chatId: string) => {
      if (!repoPath) return;
      // Clean up the WS subscription for this chat immediately so the socket
      // doesn't keep it in activeSubscriptions and re-subscribe on reconnect.
      cleanupMapRef.current.get(chatId)?.();
      await api.deleteChat(repoPath, chatId);
      setChats((prev) => prev.filter((c) => c.id !== chatId));
    },
    [repoPath],
  );

  return {
    chats,
    loading,
    error,
    reload,
    createChat,
    setUserFinished,
    rename,
    deleteChat,
  };
}

function recordToSummary(record: ChatRecord): ChatSummary {
  const previewParts: string[] = [];
  for (const ev of record.events) {
    if (ev.type === "user_message") previewParts.push(ev.text);
    else if (ev.type === "assistant") {
      for (const block of ev.content) {
        if (block.type === "text") previewParts.push(block.text);
      }
    }
    if (previewParts.join(" ").length > 600) break;
  }
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    userMarkedFinished: record.userMarkedFinished,
    sessionId: record.sessionId,
    model: record.model,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    preview: previewParts.join(" ").slice(0, 600),
  };
}

function applyEventToList(
  setChats: React.Dispatch<React.SetStateAction<ChatSummary[]>>,
  event: AgentEvent,
): void {
  switch (event.type) {
    case "chat_status":
      setChats((prev) =>
        prev.map((c) =>
          c.id === event.chatId
            ? {
                ...c,
                status: event.status,
                sessionId: event.sessionId ?? c.sessionId,
              }
            : c,
        ),
      );
      break;
    case "chat_title":
      setChats((prev) =>
        prev.map((c) =>
          c.id === event.chatId ? { ...c, title: event.title } : c,
        ),
      );
      break;
    case "user_message_echo":
      setChats((prev) =>
        prev.map((c) =>
          c.id === event.chatId
            ? {
                ...c,
                preview: (event.text + " " + c.preview).slice(0, 600),
                updatedAt: new Date().toISOString(),
              }
            : c,
        ),
      );
      break;
  }
}
