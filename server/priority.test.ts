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

import { prNews, prUrl } from "./priority.js";

test("prUrl takes a PR link or owner/repo#n", () => {
  assert.equal(prUrl("see https://github.com/o/r/pull/12/files"), "https://github.com/o/r/pull/12");
  assert.equal(prUrl("o/r#7"), "https://github.com/o/r/pull/7");
  assert.equal(prUrl("Dan's reply"), null);
});

test("prNews says what changed on a PR, and nothing when nothing did", () => {
  const url = "https://github.com/o/r/pull/42";
  const before = { state: "OPEN", reviewDecision: "REVIEW_REQUIRED", reviews: [], comments: [] };
  assert.equal(prNews(url, before, before), null);
  assert.equal(
    prNews(url, before, { ...before, reviewDecision: "APPROVED", reviews: [{ author: "dan", state: "APPROVED" }] }),
    "PR #42 was approved by dan",
  );
  assert.equal(
    prNews(url, before, { ...before, comments: [{ author: "amy" }, { author: "amy" }] }),
    "PR #42: 2 new reviews or comments from amy",
  );
  assert.equal(prNews(url, before, { ...before, state: "MERGED" }), "PR #42 was merged");
});
