import type { ClaudeAccountSummary } from "../hooks/useUsage.js";

const WEEK_MS = 7 * 86_400_000;

export interface AccountPace {
  id: string;
  label: string;
  used: number;
  left: number;
  resetsAt: string | null;
  /** Where even use across the week would put this account by now (0-100). */
  expected: number;
  /** used - expected: positive is ahead of pace (heading to run out), negative is behind (heading to waste). */
  delta: number;
  /** At today's rate, when this account's week runs dry before its reset; null if it won't. */
  runsOutAt: string | null;
}

export interface PaceSummary {
  /** Average weekly use across every signed-in account. */
  used: number;
  /** The account whose week resets soonest: whatever is left there is lost at reset. */
  next: AccountPace | null;
  /** Where even use would put the pooled allowance by now. */
  expected: number;
  /** used - expected across the pool, in % of the combined weekly allowance. */
  delta: number;
  verdict: "under" | "on" | "over";
  /** Earliest time any account runs dry at its current rate. */
  runsOutAt: string | null;
  accounts: AccountPace[];
}

/**
 * Pools the weekly limits of several subscriptions that reset on different days.
 * Spend the soonest-resetting account first; anything behind even pace is waste.
 */
export function paceSummary(accounts: ClaudeAccountSummary[], now = Date.now()): PaceSummary {
  const paced = accounts
    .filter((a) => a.loggedIn && a.sevenDay)
    .map((a): AccountPace => {
      let pace: AccountPace;
      const week = a.sevenDay!;
      const reset = week.resetsAt ? new Date(week.resetsAt).getTime() : null;
      const resetPassed = reset != null && reset <= now;
      const used = resetPassed ? 0 : Math.max(0, Math.min(100, week.utilization));
      const elapsed = reset == null || resetPassed ? 0 : 1 - Math.min(1, (reset - now) / WEEK_MS);
      pace = {
        id: a.id,
        label: a.email ?? a.label,
        used,
        left: 100 - used,
        resetsAt: resetPassed ? null : week.resetsAt,
        expected: Math.round(elapsed * 100),
        delta: Math.round(used - elapsed * 100),
        runsOutAt: null,
      };
      // Only project once enough of the week has passed for the rate to mean something.
      if (reset != null && !resetPassed && elapsed > 0.05 && used > 0) {
        const start = reset - WEEK_MS;
        const dryAt = start + (100 / used) * elapsed * WEEK_MS;
        if (dryAt < reset && dryAt > now) pace.runsOutAt = new Date(dryAt).toISOString();
        else if (used >= 100) pace.runsOutAt = null;
      }
      return pace;
    })
    .sort((x, y) => (x.resetsAt ?? "￿").localeCompare(y.resetsAt ?? "￿"));
  const used = paced.length ? paced.reduce((s, a) => s + a.used, 0) / paced.length : 0;
  const expected = paced.length ? paced.reduce((s, a) => s + a.expected, 0) / paced.length : 0;
  const delta = Math.round(used - expected);
  const verdict = delta <= -5 ? "under" : delta >= 5 ? "over" : "on";
  const next = paced.find((a) => a.resetsAt && a.left > 0) ?? null;
  const runsOutAt =
    paced.map((a) => a.runsOutAt).filter((t): t is string => !!t).sort()[0] ?? null;
  return { used, next, expected, delta, verdict, runsOutAt, accounts: paced };
}
