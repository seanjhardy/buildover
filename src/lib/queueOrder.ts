/**
 * queueOrder.ts — the order of the grid's "needs you" list.
 *
 * Automatic order: questions first (an agent is blocked on them), then errors,
 * then finished chats, oldest first within each. A priority tier the user set
 * overrides that: it picks the chat's section, a place it was dragged to
 * comes next, and the automatic order only breaks the remaining ties.
 */

import type { ChatPriority, ChatStatus, ChatTier } from "../types.js";

const STATUS_RANK: Partial<Record<ChatStatus, number>> = {
  awaiting_input: 0,
  error: 1,
  agent_done: 2,
};

/** The list's sections, top to bottom. "back" holds waiting chats whose wait
 *  came good or whose date came round; untiered chats sit in "medium". */
export type QueueSection = "urgent" | "back" | "high" | "medium" | "low" | "waiting";

export const SECTIONS: readonly QueueSection[] = ["urgent", "back", "high", "medium", "low", "waiting"];

export const SECTION_LABEL: Record<QueueSection, string> = {
  urgent: "Urgent",
  back: "Back from waiting",
  high: "High",
  medium: "Medium",
  low: "Low",
  waiting: "Waiting",
};

export const TIER_LABEL: Record<ChatTier, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  waiting: "Waiting",
};

/** Number keys that set a tier on the selected chat; 0 clears it. */
export const TIER_KEYS: Record<string, ChatTier | null> = {
  "1": "urgent",
  "2": "high",
  "3": "medium",
  "4": "low",
  "5": "waiting",
  "0": null,
};

/** A waiting chat whose wait came good or whose date has come. */
export function isResurfaced(p: ChatPriority | undefined, now: number): boolean {
  if (p?.tier !== "waiting") return false;
  if (p.back) return true;
  if (!p.resurfaceAt) return false;
  const at = Date.parse(p.resurfaceAt);
  return Number.isFinite(at) && at <= now;
}

export function sectionOf(p: ChatPriority | undefined, now: number): QueueSection {
  if (!p) return "medium";
  if (isResurfaced(p, now)) return "back";
  return p.tier;
}

export function isSnoozed(until: string | undefined, now: number): boolean {
  return !!until && Date.parse(until) > now;
}

export interface Rankable {
  status: ChatStatus;
  /** When it started waiting (ms). */
  since: number;
  priority?: ChatPriority;
}

export function compareQueue(a: Rankable, b: Rankable, now: number): number {
  const ra = a.priority?.rank;
  const rb = b.priority?.rank;
  return (
    SECTIONS.indexOf(sectionOf(a.priority, now)) - SECTIONS.indexOf(sectionOf(b.priority, now)) ||
    // Dragged-into-place chats first, in the order they were put.
    (ra ?? Infinity) - (rb ?? Infinity) ||
    (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) ||
    a.since - b.since
  );
}

/** 9am local, `days` from `now`. */
function morning(now: number, days: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d;
}

function nextMonday(now: number): number {
  return ((8 - new Date(now).getDay()) % 7) || 7;
}

/** Quick dates a waiting chat comes back up on. */
export function resurfaceChoices(now: number): { label: string; at: Date }[] {
  return [
    { label: "Tomorrow", at: morning(now, 1) },
    { label: "Monday", at: morning(now, nextMonday(now)) },
    { label: "In a week", at: morning(now, 7) },
  ];
}

/** Quick snoozes: an hour, a day, tomorrow morning, next Monday morning. */
export function snoozeChoices(now: number): { label: string; at: Date }[] {
  return [
    { label: "1 hour", at: new Date(now + 3_600_000) },
    { label: "1 day", at: new Date(now + 86_400_000) },
    { label: "Tomorrow morning", at: morning(now, 1) },
    { label: "Monday morning", at: morning(now, nextMonday(now)) },
  ];
}

/** "Mon 9:00", or "12 Nov" when it's more than a week off. */
export function shortWhen(iso: string, now: number): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  if (d.getTime() - now > 6 * 86_400_000) {
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} ${time}`;
}

/** Where a dragged chat lands: the section's chats in their new order, each
 *  with the tier and rank to save. Dropping in "back" isn't allowed. */
export function dropOrder(
  section: QueueSection,
  sectionIds: readonly string[],
  dragged: string,
  index: number,
): { chatId: string; tier: ChatTier; rank: number }[] {
  const at = sectionIds.indexOf(dragged);
  const ids = sectionIds.filter((id) => id !== dragged);
  // Taking it out of the list shifts the places below it up by one.
  ids.splice(at >= 0 && at < index ? index - 1 : index, 0, dragged);
  const tier: ChatTier = section === "back" ? "waiting" : section;
  return ids.map((chatId, rank) => ({ chatId, tier, rank }));
}
