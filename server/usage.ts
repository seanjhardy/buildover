import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  /**
   * Set when the endpoint refused a fresh reading (it allows only a few
   * requests a minute per login token, then locks it out for minutes). The
   * report is the last good reading; `retryAt` is when a live one is allowed.
   */
  stale?: boolean;
  retryAt?: string;
}

export interface UsageLimitBlock {
  message: string;
  resetsAt: string | null;
}

export class ClaudeUsageError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** From the 429 Retry-After header. */
    public readonly retryAfterMs?: number,
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

export async function fetchUsage(configDir?: string): Promise<UsageReport> {
  const creds = await readCreds(false, configDir);
  const res = await fetchWithClaudeAuth(
    USAGE_URL,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    configDir,
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new ClaudeUsageError(
        res.status,
        "Claude login has expired. Sign in again to reconnect Buildover.",
      );
    }
    if (res.status === 429) {
      const retryAfterS = Number(res.headers.get("retry-after"));
      throw new ClaudeUsageError(
        res.status,
        "Claude's usage endpoint is cooling down.",
        Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS * 1000 : 60_000,
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

// The usage endpoint allows roughly five requests a minute per login token,
// then answers 429 for ~5 minutes; everything on this machine sharing the token
// (Buildover, Operator, the Claude Code statusline, the CLI itself) draws on
// the same budget. So readings are kept in a snapshot file shared with
// Operator: a reading younger than MIN_FETCH_INTERVAL_MS is served as-is, a
// 429's Retry-After is honoured by both apps, and while it lasts the last good
// reading is served marked `stale` instead of an error.
const SNAPSHOT_FILE = join(homedir(), ".claude", "usage-snapshots.json");
const MIN_FETCH_INTERVAL_MS = 20_000;

interface UsageSnapshot {
  report?: UsageReport;
  attemptAt?: number;
  retryAt?: number;
  /** The last attempt's failure, replayed until the next attempt is due. */
  error?: { status: number; message: string };
}

async function readSnapshots(): Promise<Record<string, UsageSnapshot>> {
  try {
    const parsed = JSON.parse(await readFile(SNAPSHOT_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSnapshot(key: string, snapshot: UsageSnapshot): Promise<void> {
  try {
    const all = await readSnapshots();
    all[key] = snapshot;
    await mkdir(join(homedir(), ".claude"), { recursive: true });
    const tmp = `${SNAPSHOT_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2));
    await rename(tmp, SNAPSHOT_FILE);
  } catch (err) {
    console.warn("[usage] Failed to write usage snapshot:", err);
  }
}

/** Drops a remembered failure, e.g. right after signing in again. */
export async function forgetUsageError(configDir?: string): Promise<void> {
  const key = configDir ?? "";
  const snapshot = (await readSnapshots())[key];
  if (snapshot?.error) await writeSnapshot(key, { report: snapshot.report });
}

function staleOrThrow(snapshot: UsageSnapshot, retryAt: number): UsageReport {
  if (snapshot.report) {
    return { ...snapshot.report, stale: true, retryAt: new Date(retryAt).toISOString() };
  }
  throw new ClaudeUsageError(
    429,
    "Claude's usage endpoint is cooling down; a reading will load automatically.",
    retryAt - Date.now(),
  );
}

const inflightByDir = new Map<string, Promise<UsageReport>>();

/**
 * The usage reading to show or act on: live unless one was taken in the last
 * few seconds (by this app or Operator) or the endpoint is cooling down, in
 * which case the last good reading comes back marked `stale`. Concurrent
 * callers share one request.
 */
export function getUsage(configDir?: string): Promise<UsageReport> {
  const key = configDir ?? "";
  const pending = inflightByDir.get(key);
  if (pending) return pending;
  const request = (async () => {
    const snapshot = (await readSnapshots())[key] ?? {};
    const now = Date.now();
    if (snapshot.retryAt && snapshot.retryAt > now) return staleOrThrow(snapshot, snapshot.retryAt);
    if (snapshot.attemptAt && now - snapshot.attemptAt < MIN_FETCH_INTERVAL_MS) {
      if (snapshot.error) throw new ClaudeUsageError(snapshot.error.status, snapshot.error.message);
      if (snapshot.report) return snapshot.report;
    }
    await writeSnapshot(key, { report: snapshot.report, attemptAt: now });
    try {
      const report = await fetchUsage(configDir);
      await writeSnapshot(key, { report, attemptAt: now });
      return report;
    } catch (err) {
      if (err instanceof ClaudeUsageError && err.status === 429) {
        const retryAt = Date.now() + (err.retryAfterMs ?? 60_000);
        await writeSnapshot(key, { report: snapshot.report, attemptAt: now, retryAt });
        return staleOrThrow(snapshot, retryAt);
      }
      const status = err instanceof ClaudeUsageError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      await writeSnapshot(key, { report: snapshot.report, attemptAt: now, error: { status, message } });
      throw err instanceof ClaudeUsageError ? err : new ClaudeUsageError(status, message);
    }
  })().finally(() => inflightByDir.delete(key));
  inflightByDir.set(key, request);
  return request;
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

// One cache per Claude account (configDir; "" = the primary account).
const usageCaches = new Map<string, ReturnType<typeof createUsageCache>>();

function usageCacheFor(configDir?: string) {
  const key = configDir ?? "";
  let cache = usageCaches.get(key);
  if (!cache) {
    cache = createUsageCache(() => getUsage(configDir));
    usageCaches.set(key, cache);
  }
  return cache;
}

/** Forces the next usage check to hit the endpoint (every account if none given). */
export function invalidateUsageCache(configDir?: string): void {
  if (configDir === undefined) {
    for (const cache of usageCaches.values()) cache.invalidate();
    return;
  }
  usageCaches.get(configDir)?.invalidate();
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
export async function getUsageLimitBlock(
  model?: string,
  configDir?: string,
): Promise<UsageLimitBlock | null> {
  const usage = await usageCacheFor(configDir).get();
  return usage ? usageLimitBlockFor(usage, model) : null;
}

/**
 * Backward-compatible helper for callers that only need a display message.
 */
export async function checkUsageLimit(): Promise<string | null> {
  return (await getUsageLimitBlock())?.message ?? null;
}
