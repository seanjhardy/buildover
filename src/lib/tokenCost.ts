// Presentation helpers for the token-cost UI: the composer's cost readout and
// the cold-cache / large-context warning banners.
import { coldRestartCostUsd, warmCallCostUsd } from "../pricing.js";

/** Context over which the readout turns amber. */
export const CONTEXT_AMBER_TOKENS = 150_000;
/** A last turn costing more than this turns the readout amber. */
export const TURN_COST_AMBER_USD = 1;
/** Idle time after which the 1h prompt cache has expired. */
export const COLD_CACHE_IDLE_MS = 60 * 60_000;
/** Below this context size a cold restart is too cheap to warn about. */
export const COLD_CACHE_MIN_TOKENS = 50_000;
/** Above this context size every call is expensive enough to warn about. */
export const LARGE_CONTEXT_TOKENS = 160_000;

/** `4m`, `2h 14m`, `3d 5h`; under a minute is `<1m`. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** `$4.12`, `<$0.01`, `$123`. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  if (usd >= 100) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

/** `180k` / `1.2M`, rounded for use in prose. */
export function formatTokensRounded(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

export function costReadoutIsAmber(contextTokens: number, lastTurnUsd: number | undefined): boolean {
  return contextTokens > CONTEXT_AMBER_TOKENS || (lastTurnUsd ?? 0) > TURN_COST_AMBER_USD;
}

export interface ChatWarning {
  kind: "cold" | "large";
  /** Dismissal is remembered per chat against this key: a new idle period (or
   *  the other kind of warning) produces a new key and shows again. */
  key: string;
  message: string;
  /** Same warning for a narrow column: keeps the token count and the cost —
   *  the whole point of the banner — and drops only the sentence around them. */
  shortMessage: string;
}

/**
 * Which warning (if any) to show above the composer. `lastApiAtMs` is when the
 * chat last talked to the API; the 1h prompt cache is cold once that is more
 * than an hour ago.
 */
export function chatWarning(input: {
  model: string | undefined;
  contextTokens: number;
  lastApiAtMs: number | undefined;
  now: number;
}): ChatWarning | null {
  const { model, contextTokens, lastApiAtMs, now } = input;
  const idleMs = lastApiAtMs === undefined ? 0 : now - lastApiAtMs;
  // A cold restart is only a Claude prompt-cache concern.
  const coldCost = coldRestartCostUsd(model, contextTokens);
  if (
    lastApiAtMs !== undefined &&
    coldCost !== null &&
    idleMs > COLD_CACHE_IDLE_MS &&
    contextTokens > COLD_CACHE_MIN_TOKENS
  ) {
    return {
      kind: "cold",
      key: `cold:${lastApiAtMs}`,
      message: `Prompt cache expired (idle ${formatDuration(idleMs)}). Your next message re-sends ~${formatTokensRounded(contextTokens)} tokens (≈${formatUsd(coldCost)}).`,
      shortMessage: `Cache expired · ~${formatTokensRounded(contextTokens)} tokens (≈${formatUsd(coldCost)})`,
    };
  }
  if (contextTokens > LARGE_CONTEXT_TOKENS) {
    const warm = warmCallCostUsd(model, contextTokens);
    return {
      kind: "large",
      key: "large",
      message: `Large chat: each message re-reads ~${formatTokensRounded(contextTokens)} tokens${warm === null ? "" : ` (≈${formatUsd(warm)}+ per call)`}.`,
      shortMessage: `Large chat · ~${formatTokensRounded(contextTokens)} tokens${warm === null ? "" : ` (≈${formatUsd(warm)}+/call)`}`,
    };
  }
  return null;
}
