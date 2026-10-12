/**
 * Token-economy defaults for every Claude chat buildover starts. This file is
 * the single source of truth for them; sessions.ts and agent.ts import from it.
 *
 * Measured on a week of real transcripts (Oct 2026): ~90% of spend was
 * re-reading context (cache reads + writes), not output. Cost per call scales
 * with context size, so the levers all shrink context or move bulk work to
 * cheaper models:
 *
 *  - autoCompactWindow: compact at 200k instead of letting chats run to
 *    400k-700k. Simulated against that week this cut cost ~25%. The SDK does
 *    the compaction itself (`settings.autoCompactWindow`); buildover's own
 *    silent `/compact` turn is only a backstop (see compactBackstopTokens).
 *  - Haiku Explore / researcher agents and the image-downscale Read hook are
 *    NOT configured here: they live in the user's global ~/.claude settings,
 *    which every SDK query loads (buildover omits `settingSources`). Defining
 *    them in-process as well would double-process every Read.
 */

export const DEFAULT_AUTO_COMPACT_WINDOW = 200_000;

/** The backstop sits this far above the SDK's own compaction window. */
const COMPACT_BACKSTOP_FACTOR = 1.1;

/**
 * Context size at which buildover forces a silent `/compact` turn itself. The
 * SDK compacts first at `autoCompactWindow`; this only fires if that failed
 * (or the pref was changed mid-chat), so it derives from the same pref.
 */
export function compactBackstopTokens(autoCompactWindow?: number): number {
  const window =
    typeof autoCompactWindow === "number" && autoCompactWindow > 0
      ? autoCompactWindow
      : DEFAULT_AUTO_COMPACT_WINDOW;
  return Math.round(window * COMPACT_BACKSTOP_FACTOR);
}
