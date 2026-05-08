import { complete } from "./anthropicDirect.js";

export interface SegmentResult {
  complete: boolean;
  // Cleaned-up version of the user's text. Only populated when complete=true.
  cleanedText?: string;
  reason?: string;
  // True when we returned `complete: false` because we ran out of rate-limit
  // budget rather than because the classifier actually said so.
  rateLimited?: boolean;
}

// Hard ceiling per minute. The natural cadence is ~1 call every 5s of mic
// silence so 12/min is the upper bound for a single talkative user; we cap
// below that to leave room for occasional retries.
const SEGMENT_LIMIT_PER_MIN = 10;
const BURST = 3;

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(
    private capacity: number,
    private perMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }
  take(): boolean {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + (elapsed / this.perMs) * this.capacity,
      );
      this.lastRefill = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// Per-IP buckets so a flaky client can't burn through everyone else's budget.
// In practice this is a one-user local app, but the cost is negligible.
const buckets = new Map<string, TokenBucket>();
function bucketFor(key: string): TokenBucket {
  let b = buckets.get(key);
  if (!b) {
    b = new TokenBucket(BURST, (60_000 * BURST) / SEGMENT_LIMIT_PER_MIN);
    buckets.set(key, b);
  }
  return b;
}

const PROMPT = `You classify whether a snippet of speech-to-text transcript is a COMPLETE actionable request, or whether the speaker has more to say.

Bias HEAVILY toward "incomplete". Only return complete=true if ALL of these hold:
- The snippet expresses a clear, actionable engineering request (e.g. fix X, add Y, refactor Z).
- It contains a verb and an object — not just a topic or a noun phrase.
- It does not end mid-thought (no trailing "and", "so", "uh", "maybe", "or", etc.).
- It is at least 5 words of substantive content (filler words like "um", "uh", "like", "you know" don't count).

Examples:
- "um okay so the button" → incomplete (trailing topic, no verb)
- "fix the login button so it doesn't double-fire on click" → complete
- "yeah let's" → incomplete (filler)
- "actually no" → incomplete (correction, no request)

Respond with ONLY a single JSON object on one line: {"complete": boolean, "cleaned": string, "reason": string}.
- "cleaned" should be a tight rewrite of the request with disfluencies removed; empty string if incomplete.
- "reason" should be a 3-8 word note.

Transcript:
"""
{TEXT}
"""`;

export async function classifySegment(
  text: string,
  rateKey: string,
): Promise<SegmentResult> {
  const trimmed = text.trim();
  if (trimmed.length < 12) {
    return { complete: false, reason: "too short" };
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 4) {
    return { complete: false, reason: "too few words" };
  }

  if (!bucketFor(rateKey).take()) {
    return { complete: false, rateLimited: true, reason: "rate limited" };
  }

  let raw: string;
  try {
    const result = await complete({
      model: "claude-haiku-4-5",
      userPrompt: PROMPT.replace("{TEXT}", trimmed.slice(0, 2000)),
      maxTokens: 256,
      timeoutMs: 8_000,
    });
    raw = result.text;
  } catch {
    return { complete: false, reason: "classifier error" };
  }

  return parseResponse(raw);
}

function parseResponse(raw: string): SegmentResult {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { complete: false, reason: "no json" };
  try {
    const obj = JSON.parse(m[0]) as {
      complete?: unknown;
      cleaned?: unknown;
      reason?: unknown;
    };
    const complete = obj.complete === true;
    const cleaned =
      typeof obj.cleaned === "string" ? obj.cleaned.trim() : undefined;
    const reason = typeof obj.reason === "string" ? obj.reason : undefined;
    if (complete && (!cleaned || cleaned.length < 4)) {
      return { complete: false, reason: "empty cleaned" };
    }
    return { complete, cleanedText: cleaned, reason };
  } catch {
    return { complete: false, reason: "json parse" };
  }
}
