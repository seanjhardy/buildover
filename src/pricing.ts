// Model price table and prompt-cache cost estimates, shared by the server and
// the client (warning banners, handoff decisions). USD per million input
// tokens at list price; these are estimates for guiding the user, not billing.

interface PriceRow {
  /** Matches when the model id contains this substring. First match wins. */
  match: string;
  inputPerMTok: number;
}

// Ordered most specific first (e.g. opus-5-5 before the generic opus rows).
const INPUT_PRICES: PriceRow[] = [
  { match: "fable", inputPerMTok: 10 },
  { match: "opus-5-5", inputPerMTok: 4 },
  { match: "sonnet-5-5", inputPerMTok: 2 },
  { match: "haiku-5-5", inputPerMTok: 0.1 },
  { match: "opus", inputPerMTok: 5 }, // older Opus
  { match: "sonnet", inputPerMTok: 3 }, // older Sonnet
  { match: "haiku", inputPerMTok: 1 }, // Haiku 4.5
];

/** 1h cache write = 2x input. */
export const CACHE_WRITE_1H_MULTIPLIER = 2;
/** Cache read = 0.05x input. */
export const CACHE_READ_MULTIPLIER = 0.05;

/** $ per million input tokens, or null for non-Claude / unknown models. */
export function inputPricePerMTok(model: string | undefined): number | null {
  if (!model || !model.startsWith("claude-")) return null;
  const lower = model.toLowerCase();
  // The ids in use are `claude-sonnet-5` / `claude-opus-5` as well as the
  // dotted-minor ones; Sonnet 5 shares Sonnet 5.5's price.
  if (/sonnet-5(?!-\d)/.test(lower)) return 2;
  for (const row of INPUT_PRICES) if (lower.includes(row.match)) return row.inputPerMTok;
  return null;
}

/** $ per million tokens written to the 1h prompt cache. */
export function cacheWritePricePerMTok(model: string | undefined): number | null {
  const input = inputPricePerMTok(model);
  return input === null ? null : input * CACHE_WRITE_1H_MULTIPLIER;
}

/** $ per million tokens read from the prompt cache. */
export function cacheReadPricePerMTok(model: string | undefined): number | null {
  const input = inputPricePerMTok(model);
  return input === null ? null : input * CACHE_READ_MULTIPLIER;
}

/** Estimated cost of re-sending `tokens` of context into a COLD cache. */
export function coldRestartCostUsd(model: string | undefined, tokens: number): number | null {
  const price = cacheWritePricePerMTok(model);
  return price === null ? null : (tokens * price) / 1_000_000;
}

/** Estimated cost of one call re-reading `tokens` of context from a WARM cache. */
export function warmCallCostUsd(model: string | undefined, tokens: number): number | null {
  const price = cacheReadPricePerMTok(model);
  return price === null ? null : (tokens * price) / 1_000_000;
}

/**
 * The SDK's `total_cost_usd` is cumulative for the CLI session. Returns this
 * turn's share given the previous cumulative value. A drop means the counter
 * restarted (new session after /clear), so the value itself is the turn's cost.
 */
export function turnCostDelta(previousCumulative: number | undefined, cumulative: number): number {
  const before = previousCumulative ?? 0;
  return cumulative >= before ? cumulative - before : cumulative;
}
