import { useEffect, useRef } from "react";
import type { ChatStatus, ChatSummary } from "../types.js";

// Statuses that count toward the numeric attention badge and trigger notifications.
// "awaiting_input" = agent is blocked waiting for the user.
// "error"          = something went wrong and needs attention.
// Deliberately excludes "agent_done" / "finished" — those are informational only.
const ATTENTION_STATUSES = new Set<ChatStatus>(["awaiting_input", "error"]);

// Statuses that trigger a native macOS notification on transition into them.
const NOTIFY_STATUSES = new Set<ChatStatus>(["awaiting_input", "agent_done", "error"]);

function repoName(repoPath: string): string {
  return repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath;
}

function statusLabel(status: ChatStatus): string {
  switch (status) {
    case "awaiting_input": return "Needs your input";
    case "agent_done":     return "Agent finished";
    case "error":          return "Error occurred";
    default:               return status;
  }
}

/**
 * Watches all open repo chats for status transitions and:
 *  1. Updates the macOS dock badge:
 *       - Number = chats needing attention (awaiting_input, error)
 *       - Dot (•) = at least one chat is actively running but needs no action
 *       - Empty = nothing noteworthy happening
 *  2. Fires native macOS notifications when agents transition into notify states.
 *
 * A notification is skipped only when the window is focused AND that exact chat
 * is on screen — so finishing work in another repo tab still notifies. Clicking
 * a notification calls onOpenChat with the chat's repo and id.
 *
 * Native notifications + badge need Electron; in a plain browser we fall back
 * to the Web Notification API when permission has already been granted.
 */
export function useNotifications(
  allRepoChats: Record<string, ChatSummary[]>,
  activeRepoPath: string | null,
  activeChatId: string | null,
  onOpenChat: (target: NotificationTarget) => void,
): void {
  // Refs so navigation doesn't re-run the status effect (which would be harmless
  // but wasteful) and the click listener always sees the latest callback.
  const viewRef = useRef({ activeRepoPath, activeChatId });
  viewRef.current = { activeRepoPath, activeChatId };
  const onOpenChatRef = useRef(onOpenChat);
  onOpenChatRef.current = onOpenChat;

  // chatId → last observed status — used to detect transitions
  const prevStatusRef = useRef<Map<string, ChatStatus>>(new Map());

  // "chatId:status" keys for which a notification has already been sent.
  // Cleared when the chat leaves that status, so re-entry fires a new notification.
  const notifiedRef = useRef<Set<string>>(new Set());

  // ── Status transitions → badge + notifications ──────────────────────────
  useEffect(() => {
    const api = window.electronNotifications;
    const webNotify =
      !api && typeof Notification !== "undefined" && Notification.permission === "granted";
    if (!api && !webNotify) return;

    let attentionCount = 0;
    let runningCount = 0;

    const prevStatus = prevStatusRef.current;
    const notified = notifiedRef.current;

    // Collect the set of chat IDs currently present so we can clean up stale entries.
    const currentChatIds = new Set<string>();

    for (const [repoPath, chats] of Object.entries(allRepoChats)) {
      for (const chat of chats) {
        currentChatIds.add(chat.id);

        // Accumulate badge counts
        if (ATTENTION_STATUSES.has(chat.status)) attentionCount++;
        if (chat.status === "running") runningCount++;

        const prev = prevStatus.get(chat.id);
        // Only treat it as a transition if we've seen this chat before AND the status changed.
        // On the very first render, prev is undefined → no notification fires (avoids startup noise).
        const hasTransitioned = prev !== undefined && prev !== chat.status;

        if (hasTransitioned) {
          // When leaving a notify-worthy status, remove the dedup key so that
          // if the agent re-enters this status later it will notify again.
          if (prev && NOTIFY_STATUSES.has(prev)) {
            notified.delete(`${chat.id}:${prev}`);
          }
        }

        // Fire a native notification on transition INTO a notify-worthy status.
        // Checked independently of hasTransitioned so that the notifiedRef dedup
        // key acts as the single source of truth — guarding against any code path
        // (race conditions, React StrictMode double-invocations, server replays,
        // etc.) that could deliver the same notify-worthy status more than once.
        if (
          NOTIFY_STATUSES.has(chat.status) &&
          prev !== undefined &&                          // don't notify on first load
          !notified.has(`${chat.id}:${chat.status}`)
        ) {
          notified.add(`${chat.id}:${chat.status}`);
          const view = viewRef.current;
          const onScreen =
            document.hasFocus() &&
            view.activeRepoPath === repoPath &&
            view.activeChatId === chat.id;
          if (!onScreen) {
            const target = { repoPath, chatId: chat.id };
            const title = `${repoName(repoPath)} — ${statusLabel(chat.status)}`;
            const body = chat.title || chat.task || "Unnamed chat";
            if (api) {
              void api.notify(title, body, target);
            } else {
              const n = new Notification(title, { body, tag: `${chat.id}:${chat.status}`, silent: true });
              n.onclick = () => {
                window.focus();
                onOpenChatRef.current(target);
                n.close();
              };
            }
          }
        }

        // Record current status as the new "previous" for the next render.
        prevStatus.set(chat.id, chat.status);
      }
    }

    // Clean up stale entries for chats that no longer exist (closed/deleted).
    for (const id of prevStatus.keys()) {
      if (!currentChatIds.has(id)) {
        prevStatus.delete(id);
        // Also remove any dedup keys for this chat.
        for (const key of notified) {
          if (key.startsWith(`${id}:`)) notified.delete(key);
        }
      }
    }

    // Update dock badge: number for attention, dot for running, empty when idle.
    if (api) void api.updateBadge(attentionCount, runningCount);
  }, [allRepoChats]);

  // ── Notification click → open that chat ─────────────────────────────────
  useEffect(() => {
    const api = window.electronNotifications;
    if (!api?.onClick) return;
    return api.onClick((target) => onOpenChatRef.current(target));
  }, []);

  // ── Window focus / visibility → clear attention badge ───────────────────
  // When the user brings the window into focus, clear the attention number only
  // (pass 0 for attention, keep running dot by re-evaluating on next allRepoChats tick).
  useEffect(() => {
    const api = window.electronNotifications;
    if (!api) return;

    const clearAttentionBadge = () => void api.updateBadge(0, 0);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") clearAttentionBadge();
    };

    window.addEventListener("focus", clearAttentionBadge);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("focus", clearAttentionBadge);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
