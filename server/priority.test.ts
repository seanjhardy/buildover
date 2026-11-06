import { test } from "node:test";
import assert from "node:assert/strict";
import { normalisePriority, toSummary } from "./chats.js";
import type { ChatRecord } from "../src/types.js";

test("normalisePriority keeps a known tier and drops waiting-only fields elsewhere", () => {
  assert.deepEqual(normalisePriority({ tier: "low", waitingOn: "x" }), { tier: "low" });
  assert.deepEqual(
    normalisePriority({ tier: "waiting", waitingOn: "  PR #42 review ", resurfaceAt: "2026-11-09T09:00:00Z" }),
    { tier: "waiting", waitingOn: "PR #42 review", resurfaceAt: "2026-11-09T09:00:00.000Z" },
  );
  assert.deepEqual(normalisePriority({ tier: "waiting", waitingOn: " " }), { tier: "waiting" });
  assert.throws(() => normalisePriority({ tier: "someday" }));
  assert.throws(() => normalisePriority({ tier: "waiting", resurfaceAt: "soon" }));
  assert.throws(() => normalisePriority(null));
});

test("the chat summary mirrors its priority", () => {
  const record = {
    id: "c1",
    title: "t",
    titleAuto: false,
    status: "agent_done",
    userMarkedFinished: false,
    model: "claude-opus-5-5",
    createdAt: "2026-11-06T00:00:00Z",
    updatedAt: "2026-11-06T00:00:00Z",
    events: [],
  } as unknown as ChatRecord;
  assert.equal(toSummary(record).priority, undefined);
  record.priority = { tier: "high" };
  assert.deepEqual(toSummary(record).priority, { tier: "high" });
});
