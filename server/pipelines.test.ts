import assert from "node:assert/strict";
import { test } from "node:test";
import { nextCheck, nextState, pickRelease, pickResearch, syncDue, weekStart, type PipelineItem } from "./pipelines.js";
import { isWriteTool, parseRows } from "./pipelineAgentFetch.js";
import type { SourceConfig } from "./pipelineSources.js";
import { closedKeys, fillQuery, ideasPrompt } from "./pipelineSources.js";
import { parseOrder } from "./pipelineRank.js";

const at = "2026-11-05T10:00:00.000Z";
const item = (over: Partial<PipelineItem>): PipelineItem => ({
  source: "board",
  key: "k",
  title: "T",
  repoPath: "/r",
  state: "new",
  rank: 1,
  createdAt: at,
  updatedAt: at,
  ...over,
});

test("nextState follows the chat", () => {
  const now = Date.parse(at) + 60_000;
  const working = item({ state: "working", chatId: "c", startedAt: at });
  assert.equal(nextState(working, { status: "running", onGrid: false }, now).state, "working");
  // Just started: idle until the turn persists.
  assert.equal(nextState(working, { status: "idle", onGrid: false }, now).state, "working");
  assert.equal(nextState(working, { status: "idle", onGrid: false }, now + 10 * 60_000).state, "ready");
  assert.equal(nextState(working, { status: "agent_done", onGrid: false }, now).state, "ready");
  assert.equal(nextState({ ...working, page: { waiting: true } }, { status: "queued", onGrid: false }, now).state, "waiting");
  assert.equal(nextState({ ...working, page: { done: "Fixed" } }, { status: "agent_done", onGrid: false }, now).reason, "Fixed");
  assert.equal(nextState(working, { status: null, onGrid: false }, now).state, "done");
  // Started on the canvas: taking it off closes it, whatever it was doing.
  const placed = { ...working, placed: true };
  assert.equal(nextState(placed, { status: "running", onGrid: true }, now).state, "working");
  assert.equal(nextState(placed, { status: "running", onGrid: false }, now).reason, "Closed");
  const shown = item({ state: "shown", chatId: "c" });
  assert.equal(nextState(shown, { status: "running", onGrid: true }, now).state, "shown");
  assert.equal(nextState(shown, { status: "agent_done", onGrid: false }, now).state, "done");
  assert.equal(nextState(shown, { status: "finished", onGrid: true }, now).state, "done");
});

test("pickResearch takes turns across sources and keeps a few ready per source", () => {
  const items = [
    item({ source: "a", key: "a1", rank: 2 }),
    item({ source: "a", key: "a2", rank: 1 }),
    item({ source: "b", key: "b1", rank: 1 }),
    item({ source: "c", key: "c1", rank: 1 }),
    item({ source: "c", key: "c0", state: "ready" }),
  ];
  assert.deepEqual(pickResearch(items, ["a", "b", "c"], 2, 3).map((i) => i.key), ["a2", "b1"]);
  // A source already holding `ahead` researched items waits.
  assert.deepEqual(pickResearch(items, ["c"], 2, 1).map((i) => i.key), []);
  // Agents already busy count against the limit.
  assert.deepEqual(pickResearch([...items, item({ state: "working" })], ["a", "b"], 2, 3).map((i) => i.key), ["a2"]);
});

test("pickRelease fills slots at a sweep and lets urgent items in any time", () => {
  const items = [
    item({ key: "s1", state: "shown" }),
    item({ key: "r2", state: "ready", rank: 2 }),
    item({ key: "r1", state: "ready", rank: 1 }),
    item({ key: "r3", state: "ready", rank: 3 }),
    item({ key: "u", state: "ready", rank: 9, urgent: true }),
  ];
  assert.deepEqual(pickRelease(items, false, 3).map((i) => i.key), ["u"]);
  assert.deepEqual(pickRelease(items, true, 3).map((i) => i.key), ["r1", "r2", "u"]);
});

test("query placeholders and closed keys", () => {
  assert.equal(
    fillQuery("x not in (select unnest({seen})) limit {room}", { seen: ["a", "o'k"], room: 2.7 }),
    "x not in (select unnest(array['a','o''k']::text[])) limit 2",
  );
  assert.equal(fillQuery("{ids}", {}), "array[]::text[]");
  assert.deepEqual([...closedKeys(["a", "b", "c"], [{ id: "a", closed: false }, { id: "b", closed: true }])], ["b", "c"]);
});

test("parseOrder covers every item once; weekStart is Monday", () => {
  assert.deepEqual(parseOrder("2, 0, 2, 9", 4), [2, 0, 1, 3]);
  const monday = weekStart(new Date(2026, 10, 8, 15)); // Sunday 8 Nov
  assert.equal(monday.getDay(), 1);
  assert.equal(monday.getDate(), 2);
});

test("estimateRate learns dollars per weekly point within one window", async () => {
  const { estimateRate } = await import("./spendLedger.js");
  const s = (usd: number, util: number, resetsAt = "w1") => ({ at: at, usd, util, resetsAt });
  assert.equal(estimateRate([[s(0, 10), s(5, 11)]]), null); // too little movement yet
  assert.equal(estimateRate([[s(0, 10), s(10, 12), s(20, 14)]]), 5);
  // A weekly reset in between is skipped.
  assert.equal(estimateRate([[s(0, 10), s(10, 12), s(12, 1, "w2"), s(22, 3, "w2")]]), 5);
});

test("woken items go first and aren't released until their news is worked", () => {
  const items = [
    item({ key: "n1", rank: 1 }),
    item({ key: "w1", state: "ready", chatId: "c1", wake: "news", rank: 5 }),
    item({ key: "w2", state: "done", chatId: "c2", wake: "news", rank: 2 }),
    item({ key: "busy", state: "shown", chatId: "c3", wake: "news", busy: true }),
  ];
  assert.deepEqual(pickResearch(items, ["board"], 2, 3).map((i) => i.key), ["w2", "w1"]);
  assert.deepEqual(pickResearch(items, ["board"], 3, 3).map((i) => i.key), ["w2", "w1", "n1"]);
  assert.deepEqual(pickRelease(items, true, 3).map((i) => i.key), []);
});

test("a paused source's items aren't started or woken", () => {
  const items = [item({ key: "n1" }), item({ key: "w1", state: "ready", chatId: "c1", wake: "news" })];
  assert.deepEqual(pickResearch(items, [], 2, 3).map((i) => i.key), []);
});

test("before-sweep sources check once in the hour before each sweep", () => {
  const src = { id: "mail", beforeSweeps: true } as SourceConfig;
  const sweeps = { sweeps: ["09:30", "14:00"] };
  const t = (h: number, m: number) => new Date(2026, 10, 5, h, m); // Thursday
  assert.equal(syncDue(src, undefined, sweeps, t(12, 0)), false);
  assert.equal(syncDue(src, undefined, sweeps, t(13, 10)), true);
  assert.equal(syncDue(src, t(13, 5).toISOString(), sweeps, t(13, 30)), false);
  assert.equal(syncDue(src, t(9, 0).toISOString(), sweeps, t(13, 30)), true);
  const every = { id: "b", everyMinutes: 10 } as SourceConfig;
  assert.equal(syncDue(every, t(12, 0).toISOString(), sweeps, t(12, 5)), false);
  assert.equal(syncDue(every, t(12, 0).toISOString(), sweeps, t(12, 10)), true);
  // When each is read next.
  assert.equal(nextCheck(src, undefined, sweeps, t(12, 0)).getTime(), t(13, 0).getTime());
  assert.equal(nextCheck(src, t(13, 5).toISOString(), sweeps, t(13, 30)).getTime(), new Date(2026, 10, 6, 8, 30).getTime());
  assert.equal(nextCheck(every, t(12, 0).toISOString(), sweeps, t(12, 5)).getTime(), t(12, 10).getTime());
});

test("connector agents may only read, and their rows are parsed out of prose", () => {
  for (const name of ["send_message", "chat_postMessage", "gmail_create_draft", "modifyLabels", "add_reaction"]) {
    assert.equal(isWriteTool(name), true, name);
  }
  for (const name of ["search_messages", "conversations_history", "get_thread", "list_labels", "read_email", "get_address"]) {
    assert.equal(isWriteTool(name), false, name);
  }
  assert.deepEqual(parseRows('Here you go:\n[{"id": "a", "title": "x"}]\nDone.'), [{ id: "a", title: "x" }]);
  assert.throws(() => parseRows("nothing new"));
});

test("ideas are told what was turned down and why", () => {
  const prompt = ideasPrompt(
    { kind: "ideas", prompt: "Ideas for the team.", count: 2 },
    { notes: "", open: ["Fix login"], past: [{ title: "Dark mode", outcome: "closed: customers never asked" }] },
  );
  assert.match(prompt, /Propose 2 new ideas/);
  assert.match(prompt, /- Fix login/);
  assert.match(prompt, /- Dark mode \(closed: customers never asked\)/);
});
