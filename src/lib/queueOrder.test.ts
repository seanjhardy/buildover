import { test } from "node:test";
import assert from "node:assert/strict";
import { compareQueue, isResurfaced, resurfaceChoices, type Rankable } from "./queueOrder.js";

const NOW = Date.parse("2026-11-06T12:00:00Z");

function order(items: (Rankable & { id: string })[]): string[] {
  return [...items].sort((a, b) => compareQueue(a, b, NOW)).map((i) => i.id);
}

test("untiered chats keep the automatic order: questions, errors, finished, oldest first", () => {
  assert.deepEqual(
    order([
      { id: "done", status: "agent_done", since: 1 },
      { id: "q-new", status: "awaiting_input", since: 5 },
      { id: "err", status: "error", since: 1 },
      { id: "q-old", status: "awaiting_input", since: 2 },
    ]),
    ["q-old", "q-new", "err", "done"],
  );
});

test("a tier beats the automatic order; medium sits with untiered", () => {
  assert.deepEqual(
    order([
      { id: "low-q", status: "awaiting_input", since: 1, priority: { tier: "low" } },
      { id: "plain-done", status: "agent_done", since: 1 },
      { id: "med-err", status: "error", since: 1, priority: { tier: "medium" } },
      { id: "urgent-done", status: "agent_done", since: 9, priority: { tier: "urgent" } },
      { id: "high-done", status: "agent_done", since: 1, priority: { tier: "high" } },
      { id: "wait-q", status: "awaiting_input", since: 1, priority: { tier: "waiting" } },
    ]),
    ["urgent-done", "high-done", "med-err", "plain-done", "low-q", "wait-q"],
  );
});

test("a waiting chat comes back up with high once its date passes", () => {
  const past = { tier: "waiting" as const, resurfaceAt: "2026-11-06T11:00:00Z" };
  const future = { tier: "waiting" as const, resurfaceAt: "2026-11-07T09:00:00Z" };
  assert.equal(isResurfaced(past, NOW), true);
  assert.equal(isResurfaced(future, NOW), false);
  assert.equal(isResurfaced({ tier: "waiting" }, NOW), false);
  assert.deepEqual(
    order([
      { id: "plain", status: "awaiting_input", since: 1 },
      { id: "later", status: "agent_done", since: 1, priority: future },
      { id: "back", status: "agent_done", since: 1, priority: past },
      { id: "urgent", status: "agent_done", since: 1, priority: { tier: "urgent" } },
    ]),
    ["urgent", "back", "plain", "later"],
  );
});

test("resurface choices land at 9am on the next day, next Monday and a week out", () => {
  const friday = new Date(2026, 10, 6, 15, 30).getTime();
  const [tomorrow, monday, week] = resurfaceChoices(friday).map((c) => c.at);
  assert.deepEqual([tomorrow.getDate(), tomorrow.getHours()], [7, 9]);
  assert.deepEqual([monday.getDay(), monday.getDate()], [1, 9]);
  assert.equal(week.getDate(), 13);
  // On a Monday, "Monday" means the next one.
  const mon = new Date(2026, 10, 9, 8).getTime();
  assert.equal(resurfaceChoices(mon)[1].at.getDate(), 16);
});
