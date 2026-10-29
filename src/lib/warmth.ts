/** Two clocks, kept apart on purpose (see the keep-warm comment in sessions.ts):
 *
 *   - the CACHE lives an hour from the last API call, and every keep-alive ping
 *     resets it. That clock is the server's business.
 *   - the BUDGET is how long the user has agreed to keep paying for those
 *     pings: an absolute deadline on the chat record, topped up an hour at a
 *     time, and never extended by activity.
 *
 *  The warmth pill shows the budget whenever there is one ("I'll keep this
 *  alive for 3h more") and the cache's own countdown otherwise; the other
 *  number is always in the tooltip, never a second pill. */

/** Longest prompt-cache TTL the API offers. */
export const CACHE_TTL_MS = 60 * 60_000;
/** Below this the cache is about to expire — shown differently, since the chat
 *  is about to get expensive to resume. */
export const CACHE_EXPIRING_MS = 10 * 60_000;
/** Below this the budget is nearly spent and warming is about to stop. */
export const BUDGET_ENDING_MS = 20 * 60_000;

/** Milliseconds of prompt-cache life left (<= 0 === cold). */
export function cacheMsLeft(lastApiAtMs?: number): number {
  return lastApiAtMs ? lastApiAtMs + CACHE_TTL_MS - Date.now() : 0;
}

/** Milliseconds of warmth budget left (<= 0 === warming off / spent). */
export function budgetMsLeft(keepWarmUntil?: string | number | null): number {
  if (keepWarmUntil == null) return 0;
  const ms = typeof keepWarmUntil === "number" ? keepWarmUntil : Date.parse(keepWarmUntil);
  return Number.isFinite(ms) ? ms - Date.now() : 0;
}

/** A span as the pill shows it: `45m`, `3h`, `3h50m`, `12h`. Narrow on purpose
 *  — this has to stay legible in a squashed grid column. */
export function formatWarmSpan(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 10 || m === 0) return `${h}h`;
  return `${h}h${m}m`;
}
