import { fetchWithClaudeAuth, readCreds } from "./anthropicAuth.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface UsageBucket {
  utilization: number; // percentage 0-100
  resetsAt: string | null; // ISO date string
}

export interface UsageReport {
  fiveHour: UsageBucket | null;
  sevenDay: UsageBucket | null;
  sevenDaySonnet: UsageBucket | null;
  sevenDayOpus: UsageBucket | null;
  extraUsage: {
    isEnabled: boolean;
    monthlyLimit: number | null;
    usedCredits: number | null;
    utilization: number | null;
    currency: string | null;
  } | null;
  subscriptionType?: string;
  rateLimitTier?: string;
  fetchedAt: string;
}

export interface UsageLimitBlock {
  message: string;
  resetsAt: string | null;
}

export class ClaudeUsageError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ClaudeUsageError";
  }
}

function parseBucket(raw: any): UsageBucket | null {
  if (!raw || typeof raw.utilization !== "number") return null;
  return {
    utilization: raw.utilization,
    resetsAt: raw.resets_at ?? null,
  };
}

export async function fetchUsage(): Promise<UsageReport> {
  const creds = await readCreds();
  const res = await fetchWithClaudeAuth(USAGE_URL, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new ClaudeUsageError(
        res.status,
        "Claude login has expired. Sign in again to reconnect Buildover.",
      );
    }
    if (res.status === 429) {
      throw new ClaudeUsageError(
        res.status,
        "Claude's usage service is temporarily rate limited. Claude is still signed in.",
      );
    }
    throw new ClaudeUsageError(
      res.status,
      `Claude usage service returned ${res.status}: ${body.slice(0, 200)}`,
    );
  }

  const raw = (await res.json()) as Record<string, any>;
  return {
    fiveHour: parseBucket(raw.five_hour),
    sevenDay: parseBucket(raw.seven_day),
    sevenDaySonnet: parseBucket(raw.seven_day_sonnet),
    sevenDayOpus: parseBucket(raw.seven_day_opus),
    extraUsage: raw.extra_usage
      ? {
          isEnabled: Boolean(raw.extra_usage.is_enabled),
          monthlyLimit: raw.extra_usage.monthly_limit ?? null,
          usedCredits: raw.extra_usage.used_credits ?? null,
          utilization: raw.extra_usage.utilization ?? null,
          currency: raw.extra_usage.currency ?? null,
        }
      : null,
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
    fetchedAt: new Date().toISOString(),
  };
}

function blockedBucket(
  label: string,
  bucket: UsageBucket | null,
): UsageLimitBlock | null {
  if (!bucket || bucket.utilization < 100) return null;
  return {
    message: `Usage limit reached (${label} at 100%). Agent execution is deferred until the limit resets.`,
    resetsAt: bucket.resetsAt,
  };
}

/** How long a usage reading is trusted before `/api/oauth/usage` is hit again. */
const USAGE_CACHE_TTL_MS = 3 * 60_000;
/** A failed fetch is remembered briefly so an outage isn't hammered per turn. */
const USAGE_ERROR_TTL_MS = 30_000;

export interface UsageCacheOptions {
  ttlMs?: number;
  errorTtlMs?: number;
  now?: () => number;
}

/**
 * Caches usage readings so the endpoint isn't hit before every turn. Concurrent
 * callers share one in-flight request. A cached reading that shows a bucket at
 * 100% whose reset time has already passed is treated as stale immediately.
 */
export function createUsageCache(
  fetcher: () => Promise<UsageReport>,
  opts: UsageCacheOptions = {},
) {
  const ttlMs = opts.ttlMs ?? USAGE_CACHE_TTL_MS;
  const errorTtlMs = opts.errorTtlMs ?? USAGE_ERROR_TTL_MS;
  const now = opts.now ?? Date.now;
  let entry: { at: number; report: UsageReport | null; error?: unknown } | null = null;
  let inflight: Promise<UsageReport | null> | null = null;
  let generation = 0;

  const fresh = (e: NonNullable<typeof entry>): boolean => {
    const age = now() - e.at;
    if (e.report === null) return age < errorTtlMs;
    if (age >= ttlMs) return false;
    const buckets = [e.report.fiveHour, e.report.sevenDay, e.report.sevenDaySonnet, e.report.sevenDayOpus];
    for (const b of buckets) {
      if (b && b.utilization >= 100 && b.resetsAt && new Date(b.resetsAt).getTime() <= now()) {
        return false;
      }
    }
    return true;
  };

  return {
    /** Returns the cached reading, refreshing it when stale. Null if the fetch failed. */
    async get(): Promise<UsageReport | null> {
      if (entry && fresh(entry)) return entry.report;
      if (inflight) return inflight;
      const myGeneration = generation;
      const request: Promise<UsageReport | null> = (async () => {
        try {
          const report = await fetcher();
          if (myGeneration === generation) entry = { at: now(), report };
          return report;
        } catch (err) {
          console.warn("[usage] Failed to check usage limit:", err);
          if (myGeneration === generation) entry = { at: now(), report: null, error: err };
          return null;
        }
      })().finally(() => {
        if (inflight === request) inflight = null;
      });
      inflight = request;
      return request;
    },
    /** Drops the cached reading (e.g. a turn just failed with a limit error). */
    invalidate(): void {
      generation++;
      entry = null;
      inflight = null;
    },
  };
}

const usageCache = createUsageCache(fetchUsage);

/** Forces the next usage check to hit the endpoint. */
export function invalidateUsageCache(): void {
  usageCache.invalidate();
}

/**
 * Picks the blocking bucket (if any) from a usage reading.
 * Model-specific buckets (sevenDaySonnet, sevenDayOpus) are only checked when
 * the active model matches — this avoids false positives where an unused bucket
 * type happens to report 100% for a plan that doesn't include that model.
 */
export function usageLimitBlockFor(
  usage: UsageReport,
  model?: string,
): UsageLimitBlock | null {
  const modelLower = (model ?? "").toLowerCase();
  const isSonnet = modelLower.includes("sonnet");
  const isOpus = modelLower.includes("opus");

  const blocks = [
    blockedBucket("5-hour bucket", usage.fiveHour),
    blockedBucket("7-day bucket", usage.sevenDay),
    // Only check model-specific sub-buckets when the active model matches,
    // so an unrelated full bucket doesn't block the wrong model family.
    isSonnet ? blockedBucket("7-day Sonnet bucket", usage.sevenDaySonnet) : null,
    isOpus ? blockedBucket("7-day Opus bucket", usage.sevenDayOpus) : null,
    usage.extraUsage &&
    usage.extraUsage.utilization !== null &&
    usage.extraUsage.utilization >= 100
      ? {
          message:
            "Usage limit reached (extra usage at 100%). Agent execution is deferred until usage is available.",
          resetsAt: null,
        }
      : null,
  ].filter((b): b is UsageLimitBlock => b !== null);

  if (blocks.length === 0) return null;
  blocks.sort((a, b) => {
    if (!a.resetsAt) return 1;
    if (!b.resetsAt) return -1;
    return new Date(a.resetsAt).getTime() - new Date(b.resetsAt).getTime();
  });
  return blocks[0];
}

/**
 * Checks if usage has reached 100% in any bucket relevant to the given model,
 * using a ~3 minute cache of the usage endpoint (see createUsageCache).
 * Returns reset metadata when execution should be deferred, null otherwise.
 * If usage can't be fetched, execution is not blocked.
 */
export async function getUsageLimitBlock(model?: string): Promise<UsageLimitBlock | null> {
  const usage = await usageCache.get();
  return usage ? usageLimitBlockFor(usage, model) : null;
}

/**
 * Backward-compatible helper for callers that only need a display message.
 */
export async function checkUsageLimit(): Promise<string | null> {
  return (await getUsageLimitBlock())?.message ?? null;
}
