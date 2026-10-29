import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatWarning, costReadoutIsAmber, formatDuration, formatUsd } from "./tokenCost.js";

const MIN = 60_000;
const NOW = Date.parse("2026-10-12T18:00:00Z");

describe("formatDuration", () => {
  it("formats compactly", () => {
    assert.equal(formatDuration(20_000), "<1m");
    assert.equal(formatDuration(37 * MIN), "37m");
    assert.equal(formatDuration(134 * MIN), "2h 14m");
    assert.equal(formatDuration((51 * 60 + 5) * MIN), "2d 3h");
  });
});

describe("formatUsd", () => {
  it("formats", () => {
    assert.equal(formatUsd(4.123), "$4.12");
    assert.equal(formatUsd(0.004), "<$0.01");
    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(123.4), "$123");
  });
});

describe("costReadoutIsAmber", () => {
  it("is amber above 150k context or when the last turn cost more than $1", () => {
    assert.equal(costReadoutIsAmber(150_000, 0.2), false);
    assert.equal(costReadoutIsAmber(150_001, 0.2), true);
    assert.equal(costReadoutIsAmber(10_000, 1.01), true);
    assert.equal(costReadoutIsAmber(10_000, undefined), false);
  });
});

describe("chatWarning", () => {
  const model = "claude-opus-5-5";

  it("mentions a cold cache after an hour idle with a big context", () => {
    const w = chatWarning({ model, contextTokens: 180_000, lastApiAtMs: NOW - 130 * MIN, now: NOW });
    assert.equal(w?.kind, "cold");
    // Information about cost, not an alarm: what it costs, and that it's once.
    assert.equal(
      w?.message,
      "Cache expired after 2h 10m idle — the next message re-sends ~180k tokens (≈$1.44) once, then it's cheap again.",
    );
    // The narrow form still carries the number Sean is being told about.
    assert.equal(w?.shortMessage, "Cache expired · next message ~180k tokens (≈$1.44)");
  });

  it("does not warn when idle under an hour or the context is cheap to rebuild", () => {
    assert.equal(chatWarning({ model, contextTokens: 150_000, lastApiAtMs: NOW - 59 * MIN, now: NOW }), null);
    assert.equal(chatWarning({ model, contextTokens: 40_000, lastApiAtMs: NOW - 300 * MIN, now: NOW }), null);
    // Going cold is normal; under the threshold it isn't worth saying.
    assert.equal(chatWarning({ model, contextTokens: 100_000, lastApiAtMs: NOW - 300 * MIN, now: NOW }), null);
  });

  it("warns about a large context", () => {
    const w = chatWarning({ model, contextTokens: 170_000, lastApiAtMs: NOW - 5 * MIN, now: NOW });
    assert.equal(w?.kind, "large");
    assert.equal(w?.message, "Large chat: each message re-reads ~170k tokens (≈$0.03+ per call).");
    assert.equal(w?.shortMessage, "Large chat · ~170k tokens (≈$0.03+/call)");
  });

  it("prefers the cold-cache warning when both apply", () => {
    const w = chatWarning({ model, contextTokens: 170_000, lastApiAtMs: NOW - 90 * MIN, now: NOW });
    assert.equal(w?.kind, "cold");
  });

  it("keeps one dismissal key while the chat stays cold", () => {
    // Keying on the timestamp made every turn re-raise a dismissed note.
    const a = chatWarning({ model, contextTokens: 150_000, lastApiAtMs: NOW - 90 * MIN, now: NOW });
    const b = chatWarning({ model, contextTokens: 150_000, lastApiAtMs: NOW - 70 * MIN, now: NOW });
    assert.equal(a?.key, b?.key);
  });

  it("skips the cold warning for non-Claude models (no prompt-cache price)", () => {
    assert.equal(
      chatWarning({ model: "gpt-5.6-luna", contextTokens: 150_000, lastApiAtMs: NOW - 200 * MIN, now: NOW }),
      null,
    );
    const large = chatWarning({ model: "gpt-5.6-luna", contextTokens: 200_000, lastApiAtMs: NOW, now: NOW });
    assert.equal(large?.message, "Large chat: each message re-reads ~200k tokens.");
  });
});
