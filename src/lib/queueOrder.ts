/**
 * queueOrder.ts — the order of the grid's "needs you" list.
 *
 * Automatic order: questions first (an agent is blocked on them), then errors,
 * then finished chats, oldest first within each. A priority tier the user set
 * overrides that: it picks the chat's band, and the automatic order only
 * breaks ties inside a band.
 */

import type { ChatPriority, ChatStatus, ChatTier } from "../types.js";

const STATUS_RANK: Partial<Record<ChatStatus, number>> = {
  awaiting_input: 0,
  error: 1,
  agent_done: 2,
};

/** Bands, top to bottom. Untiered chats sit with medium; a waiting chat whose
 *  resurface date has passed comes back up with high. */
const BAND: Record<ChatTier, number> = { urgent: 0, high: 1, medium: 2, low: 3, waiting: 4 };
const UNTIERED_BAND = BAND.medium;
const RESURFACED_BAND = BAND.high;

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

/** A waiting chat whose resurface date has come. */
export function isResurfaced(p: ChatPriority | undefined, now: number): boolean {
  if (p?.tier !== "waiting" || !p.resurfaceAt) return false;
  const at = Date.parse(p.resurfaceAt);
  return Number.isFinite(at) && at <= now;
}

export function queueBand(p: ChatPriority | undefined, now: number): number {
  if (!p) return UNTIERED_BAND;
  if (isResurfaced(p, now)) return RESURFACED_BAND;
  return BAND[p.tier];
}

export interface Rankable {
  status: ChatStatus;
  /** When it started waiting (ms). */
  since: number;
  priority?: ChatPriority;
}

export function compareQueue(a: Rankable, b: Rankable, now: number): number {
  return (
    queueBand(a.priority, now) - queueBand(b.priority, now) ||
    (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) ||
    a.since - b.since
  );
}

/** Quick resurface times: tomorrow, next Monday and a week out, at 9am local. */
export function resurfaceChoices(now: number): { label: string; at: Date }[] {
  const at = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d;
  };
  const toMonday = ((8 - new Date(now).getDay()) % 7) || 7;
  return [
    { label: "Tomorrow", at: at(1) },
    { label: "Monday", at: at(toMonday) },
    { label: "In a week", at: at(7) },
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
