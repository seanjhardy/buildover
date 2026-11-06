import { test } from "node:test";
import assert from "node:assert/strict";
import { compareQueue, dropOrder, isResurfaced, resurfaceChoices, snoozeChoices, type Rankable } from "./queueOrder.js";

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

test("a waiting chat comes back up, just under urgent, once its date passes or its wait came good", () => {
  const past = { tier: "waiting" as const, resurfaceAt: "2026-11-06T11:00:00Z" };
  const future = { tier: "waiting" as const, resurfaceAt: "2026-11-07T09:00:00Z" };
  assert.equal(isResurfaced(past, NOW), true);
  assert.equal(isResurfaced(future, NOW), false);
  assert.equal(isResurfaced({ tier: "waiting" }, NOW), false);
  assert.equal(isResurfaced({ tier: "waiting", back: { at: "", because: "PR approved" } }, NOW), true);
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

test("a dragged-into-place chat sits above unranked ones in its section", () => {
  assert.deepEqual(
    order([
      { id: "q", status: "awaiting_input", since: 1, priority: { tier: "high" } },
      { id: "pinned2", status: "agent_done", since: 9, priority: { tier: "high", rank: 1 } },
      { id: "pinned1", status: "agent_done", since: 9, priority: { tier: "high", rank: 0 } },
    ]),
    ["pinned1", "pinned2", "q"],
  );
});

test("dropOrder puts the dragged chat at the drop place and ranks the section", () => {
  // Moving a down past b within its section.
  assert.deepEqual(
    dropOrder("high", ["a", "b", "c"], "a", 2).map((x) => x.chatId),
    ["b", "a", "c"],
  );
  // Dropping in from another section, at the top.
  assert.deepEqual(dropOrder("low", ["x", "y"], "a", 0), [
    { chatId: "a", tier: "low", rank: 0 },
    { chatId: "x", tier: "low", rank: 1 },
    { chatId: "y", tier: "low", rank: 2 },
  ]);
});

test("snooze choices: an hour, a day, tomorrow 9am, Monday 9am", () => {
  const friday = new Date(2026, 10, 6, 15, 30).getTime();
  const [hour, day, tomorrow, monday] = snoozeChoices(friday).map((c) => c.at);
  assert.equal(hour.getTime() - friday, 3_600_000);
  assert.equal(day.getTime() - friday, 86_400_000);
  assert.deepEqual([tomorrow.getDate(), tomorrow.getHours()], [7, 9]);
  assert.deepEqual([monday.getDay(), monday.getHours()], [1, 9]);
});
