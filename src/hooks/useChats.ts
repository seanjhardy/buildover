import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
    id?: string,
  ) => Promise<ChatRecord>;
  setUserFinished: (chatId: string, finished: boolean) => Promise<void>;
  rename: (chatId: string, title: string) => Promise<void>;
  setStarred: (chatId: string, starred: boolean) => Promise<void>;
  setChatModel: (chatId: string, model: string) => Promise<void>;
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
      // Replace the list immediately on every repo switch so the sidebar never
      // shows the *previous* repo's chats. If we have prefetched data for the
      // new repo, seed with it (no loading flash); otherwise clear to empty and
      // let the background reload() populate it.
      setChats(prefetchedList && prefetchedList.length > 0 ? prefetchedList : []);
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
      // Guard against out-of-order responses: the active repo may have changed
      // while this request was in flight (or an earlier repo's request may
      // resolve after a later one). Applying a stale list here would leave the
      // sidebar showing the wrong repo's chats until the next reload trigger.
      if (repoPathRef.current !== repoPath) return;
      setChats(list);
    } catch (err) {
      if (repoPathRef.current !== repoPath) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Only clear the loading flag if this is still the active repo's request.
      if (repoPathRef.current === repoPath) setLoading(false);
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
    async (model: Model, permissionMode: PermissionMode, id?: string) => {
      if (!repoPath) throw new Error("No active repo");
      // Add an optimistic placeholder immediately so the sidebar updates
      // before the server round-trip completes.
      if (id) {
        const now = new Date().toISOString();
        const optimistic: ChatSummary = {
          id,
          title: "New chat",
          status: "idle",
          userMarkedFinished: false,
          model: model as import("../types.js").Model,
          createdAt: now,
          updatedAt: now,
          preview: "",
        };
        setChats((prev) => [optimistic, ...prev]);
      }
      try {
        const record = await api.createChat(repoPath, model, permissionMode, id);
        // Replace the optimistic entry with the confirmed record.
        setChats((prev) =>
          prev.map((c) => (c.id === record.id ? recordToSummary(record) : c)),
        );
        return record;
      } catch (err) {
        // Roll back the optimistic entry on failure.
        if (id) setChats((prev) => prev.filter((c) => c.id !== id));
        throw err;
      }
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

  const setStarred = useCallback(
    async (chatId: string, starred: boolean) => {
      if (!repoPath) return;
      // Optimistic update so the chat jumps to/from the pinned section instantly.
      setChats((prev) =>
        prev.map((c) => (c.id === chatId ? { ...c, starred } : c)),
      );
      try {
        const updated = await api.patchChat(repoPath, chatId, { starred });
        setChats((prev) =>
          prev.map((c) => (c.id === chatId ? recordToSummary(updated) : c)),
        );
      } catch {
        // Roll back on failure.
        setChats((prev) =>
          prev.map((c) => (c.id === chatId ? { ...c, starred: !starred } : c)),
        );
      }
    },
    [repoPath],
  );

  const setChatModel = useCallback(
    async (chatId: string, model: string) => {
      if (!repoPath) return;
      // Optimistic update so switching away and back shows the new model immediately.
      setChats((prev) =>
        prev.map((c) => (c.id === chatId ? { ...c, model: model as Model } : c)),
      );
      await api.patchChat(repoPath, chatId, { model }).catch(() => {
        void reload();
      });
    },
    [repoPath, reload],
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

  // The sidebar renders this list keyed by chat id, so any duplicate id shows
  // up as a repeated row. Dupes can slip in when an optimistic/prefetched seed
  // races the reload (or when a prefetched list itself contains dupes), so
  // collapse to one entry per id here as a hard invariant. Live updates map
  // identically across every copy, so keeping the first occurrence is safe.
  const dedupedChats = useMemo(() => {
    const seen = new Set<string>();
    const out: ChatSummary[] = [];
    for (const c of chats) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out.length === chats.length ? chats : out;
  }, [chats]);

  return {
    chats: dedupedChats,
    loading,
    error,
    reload,
    createChat,
    setUserFinished,
    rename,
    setStarred,
    setChatModel,
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
    starred: record.starred,
    kind: record.kind,
    parentChatId: record.parentChatId,
    task: record.task,
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
    case "chat_created":
      // A coordinator (or subagent) spawned a new chat — surface it in the
      // sidebar immediately. The subscription interval in useChats picks it
      // up for live status updates shortly after.
      setChats((prev) =>
        prev.some((c) => c.id === event.summary.id)
          ? prev
          : [event.summary, ...prev],
      );
      break;
  }
}
