import { useEffect, useRef } from "react";
import type { ChatStatus, ChatSummary } from "../types.js";

// Statuses that count toward the numeric attention badge and trigger notifications.
// "awaiting_input" = agent is blocked waiting for the user.
// "error"          = something went wrong and needs attention.
// Deliberately excludes "agent_done" / "finished" — those are informational only.
const ATTENTION_STATUSES = new Set<ChatStatus>(["awaiting_input", "error"]);

// Statuses that trigger a native macOS notification on transition into them.
const NOTIFY_STATUSES = new Set<ChatStatus>(["awaiting_input", "agent_done", "error"]);

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
 * Works only inside Electron (window.electronNotifications is undefined in plain browser).
 */
export function useNotifications(
  allRepoChats: Record<string, ChatSummary[]>,
): void {
  // chatId → last observed status — used to detect transitions
  const prevStatusRef = useRef<Map<string, ChatStatus>>(new Map());

  // "chatId:status" keys for which a notification has already been sent.
  // Cleared when the chat leaves that status, so re-entry fires a new notification.
  const notifiedRef = useRef<Set<string>>(new Set());

  // ── Status transitions → badge + notifications ──────────────────────────
  useEffect(() => {
    const api = window.electronNotifications;
    if (!api) return; // Not running in Electron

    let attentionCount = 0;
    let runningCount = 0;

    const prevStatus = prevStatusRef.current;
    const notified = notifiedRef.current;

    // Collect the set of chat IDs currently present so we can clean up stale entries.
    const currentChatIds = new Set<string>();

    for (const chats of Object.values(allRepoChats)) {
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

          // Fire a native notification on transition INTO a notify-worthy status.
          if (
            NOTIFY_STATUSES.has(chat.status) &&
            !notified.has(`${chat.id}:${chat.status}`)
          ) {
            notified.add(`${chat.id}:${chat.status}`);
            void api.notify(
              `buildover — ${statusLabel(chat.status)}`,
              chat.title || "Unnamed chat",
            );
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
    void api.updateBadge(attentionCount, runningCount);
  }, [allRepoChats]);

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
