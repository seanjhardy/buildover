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
export function useChats(repoPath: string | null): UseChatsReturn {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track which chatIds we've already wired live listeners for. Cleaned up
  // when the repoPath changes or the component unmounts.
  const subscribedRef = useRef<Set<string>>(new Set());
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

  // Subscribe to live status updates for each chat in the list. We re-run on
  // every chats change so newly-created chats get wired up.
  useEffect(() => {
    if (!repoPath) return;
    const cleanups: (() => void)[] = [];
    const subscribed = subscribedRef.current;
    for (const chat of chats) {
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
        repoPath,
        withReplay: false,
      });
      cleanups.push(() => {
        unsubscribeListener();
        subscribed.delete(chat.id);
        agentSocket.send({ type: "unsubscribe", chatId: chat.id });
      });
    }
    return () => {
      for (const fn of cleanups) fn();
    };
  }, [chats, repoPath]);

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
                updatedAt: new Date().toISOString(),
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
