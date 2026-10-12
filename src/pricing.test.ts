import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cacheReadPricePerMTok,
  cacheWritePricePerMTok,
  coldRestartCostUsd,
  inputPricePerMTok,
  turnCostDelta,
  warmCallCostUsd,
} from "./pricing.js";

describe("pricing", () => {
  it("matches the price table", () => {
    assert.equal(inputPricePerMTok("claude-opus-5-5"), 4);
    assert.equal(inputPricePerMTok("claude-sonnet-5-5"), 2);
    assert.equal(inputPricePerMTok("claude-sonnet-5"), 2);
    assert.equal(inputPricePerMTok("claude-haiku-5-5"), 0.1);
    assert.equal(inputPricePerMTok("claude-fable-5-1"), 10);
    assert.equal(inputPricePerMTok("claude-opus-5"), 5);
    assert.equal(inputPricePerMTok("claude-opus-4-8"), 5);
    assert.equal(inputPricePerMTok("claude-sonnet-4-6"), 3);
    assert.equal(inputPricePerMTok("claude-haiku-4-5"), 1);
  });

  it("returns null for non-Claude models", () => {
    assert.equal(inputPricePerMTok("cursor:composer-2.5"), null);
    assert.equal(inputPricePerMTok("gpt-5.6-luna"), null);
    assert.equal(coldRestartCostUsd("gpt-5.6-luna", 100_000), null);
  });

  it("derives write (2x) and read (0.05x) prices", () => {
    assert.equal(cacheWritePricePerMTok("claude-opus-5-5"), 8);
    assert.ok(Math.abs(cacheReadPricePerMTok("claude-opus-5-5")! - 0.2) < 1e-9);
  });

  it("reproduces the banner examples", () => {
    // 180k tokens cold on Opus 5.5: $1.44.
    assert.ok(Math.abs(coldRestartCostUsd("claude-opus-5-5", 180_000)! - 1.44) < 1e-9);
    // 170k tokens warm on Opus 5.5: ~$0.034 per call.
    assert.ok(Math.abs(warmCallCostUsd("claude-opus-5-5", 170_000)! - 0.034) < 1e-9);
  });
});

describe("turnCostDelta", () => {
  it("turns the SDK's cumulative total into per-turn costs", () => {
    assert.equal(turnCostDelta(undefined, 0.5), 0.5);
    assert.ok(Math.abs(turnCostDelta(0.5, 1.25) - 0.75) < 1e-9);
    // a restarted counter (value dropped) is itself the turn's cost
    assert.equal(turnCostDelta(5, 0.3), 0.3);
  });
});
