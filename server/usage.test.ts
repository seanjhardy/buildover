import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUsageCache, usageLimitBlockFor, type UsageReport } from "./usage.js";

function report(fiveHour: number, resetsAt: string | null = null): UsageReport {
  return {
    fiveHour: { utilization: fiveHour, resetsAt },
    sevenDay: null,
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extraUsage: null,
    fetchedAt: new Date().toISOString(),
  };
}

describe("createUsageCache", () => {
  it("serves repeated checks within the TTL from one fetch", async () => {
    let calls = 0;
    let t = 1_000_000;
    const cache = createUsageCache(async () => (calls++, report(10)), { ttlMs: 180_000, now: () => t });
    await cache.get();
    t += 60_000;
    await cache.get();
    t += 100_000;
    await cache.get();
    assert.equal(calls, 1);
    t += 30_000; // 190s since the fetch
    await cache.get();
    assert.equal(calls, 2);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    let calls = 0;
    const cache = createUsageCache(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return report(10);
    });
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    assert.equal(calls, 1);
  });

  it("invalidate() forces the next check to refetch", async () => {
    let calls = 0;
    const cache = createUsageCache(async () => (calls++, report(calls > 1 ? 100 : 10)));
    assert.equal(usageLimitBlockFor((await cache.get())!), null);
    cache.invalidate();
    const block = usageLimitBlockFor((await cache.get())!);
    assert.equal(calls, 2);
    assert.match(block!.message, /5-hour/);
  });

  it("an invalidate during an in-flight fetch discards that stale result", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cache = createUsageCache(async () => {
      const n = ++calls;
      if (n === 1) await gate;
      return report(n === 1 ? 10 : 100);
    });
    const first = cache.get();
    cache.invalidate();
    const second = await cache.get();
    release();
    await first;
    assert.equal(second!.fiveHour!.utilization, 100);
    // The stale first result must not have overwritten the fresh entry.
    assert.equal((await cache.get())!.fiveHour!.utilization, 100);
    assert.equal(calls, 2);
  });

  it("treats a cached 100% bucket whose reset time has passed as stale", async () => {
    let calls = 0;
    let t = Date.parse("2026-10-12T12:00:00Z");
    const resetsAt = "2026-10-12T12:01:00Z";
    const cache = createUsageCache(async () => (calls++, report(calls === 1 ? 100 : 5, resetsAt)), {
      now: () => t,
    });
    assert.ok(usageLimitBlockFor((await cache.get())!));
    t += 30_000;
    await cache.get();
    assert.equal(calls, 1);
    t += 60_000; // reset passed, well inside the 3 min TTL
    assert.equal(usageLimitBlockFor((await cache.get())!), null);
    assert.equal(calls, 2);
  });

  it("caches a failed fetch briefly and reports no block", async () => {
    let calls = 0;
    let t = 0;
    const cache = createUsageCache(
      async () => {
        calls++;
        throw new Error("boom");
      },
      { now: () => t, errorTtlMs: 30_000 },
    );
    const quiet = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await cache.get(), null);
      t += 10_000;
      assert.equal(await cache.get(), null);
      assert.equal(calls, 1);
      t += 25_000;
      await cache.get();
      assert.equal(calls, 2);
    } finally {
      console.warn = quiet;
    }
  });
});

describe("usageLimitBlockFor", () => {
  it("only applies model buckets to the matching model", () => {
    const usage = report(10);
    usage.sevenDayOpus = { utilization: 100, resetsAt: null };
    assert.equal(usageLimitBlockFor(usage, "claude-sonnet-5-5"), null);
    assert.ok(usageLimitBlockFor(usage, "claude-opus-5-5"));
  });
});
