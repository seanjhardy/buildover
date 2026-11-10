import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arrange,
  connectedGroup,
  fillets,
  nearestFreeOffset,
  neighbourIn,
  placeNew,
  sidesOf,
  occupancy,
  windowsTouching,
} from "./gridCanvas.js";

test("an L of three windows has one inner fillet, in the empty corner", () => {
  const positions = { a: { c: 0, r: 0 }, b: { c: 1, r: 0 }, c: { c: 0, r: 1 } };
  const f = fillets(positions);
  assert.equal(f.length, 1);
  assert.deepEqual({ x: f[0].x, y: f[0].y, dx: f[0].dx, dy: f[0].dy }, { x: 1, y: 1, dx: 1, dy: 1 });
  assert.deepEqual({ h: f[0].chatId, v: f[0].vChatId, d: f[0].dChatId }, { h: "c", v: "b", d: "a" });
});

test("a straight row and a full square have no fillets", () => {
  assert.equal(fillets({ a: { c: 0, r: 0 }, b: { c: 1, r: 0 } }).length, 0);
  assert.equal(
    fillets({ a: { c: 0, r: 0 }, b: { c: 1, r: 0 }, c: { c: 0, r: 1 }, d: { c: 1, r: 1 } }).length,
    0,
  );
});

test("joined windows form one group; a gap splits them", () => {
  const positions = { a: { c: 0, r: 0 }, b: { c: 1, r: 0 }, c: { c: 3, r: 0 } };
  assert.deepEqual(connectedGroup("a", positions).sort(), ["a", "b"]);
  assert.deepEqual(connectedGroup("c", positions), ["c"]);
  assert.deepEqual(sidesOf(positions.a, occupancy(positions)), { n: false, e: true, s: false, w: false });
});

test("new chats grow their repo's block compactly and new repos start apart", () => {
  const repo: Record<string, string> = {};
  const positions: Record<string, { c: number; r: number }> = {};
  const add = (id: string, r: string) => {
    repo[id] = r;
    positions[id] = placeNew(positions, (x) => repo[x], r);
  };
  add("a1", "A");
  add("a2", "A");
  add("a3", "A");
  add("a4", "A");
  assert.deepEqual(Object.values(positions).map((p) => `${p.c},${p.r}`).sort(), ["0,0", "0,1", "1,0", "1,1"]);
  add("b1", "B");
  assert.deepEqual(positions.b1, { c: 3, r: 0 });
  assert.deepEqual(connectedGroup("b1", positions), ["b1"]);
});

test("a new chat scoped to one block of a repo goes beside that block", () => {
  // Repo x in two blocks (a b, and d on its own), repo y's window between them.
  const repo: Record<string, string> = { a: "x", b: "x", y1: "y", d: "x" };
  const positions = { a: { c: 0, r: 0 }, b: { c: 1, r: 0 }, y1: { c: 3, r: 0 }, d: { c: 5, r: 0 } };
  const repoOf = (id: string) => repo[id];
  // Unscoped, a new x chat grows the bigger block.
  assert.deepEqual(placeNew(positions, repoOf, "x"), { c: 0, r: 1 });
  assert.deepEqual(placeNew(positions, repoOf, "x", ["d"]), { c: 6, r: 0 });
});

test("a drop onto another window lands on the nearest free cell", () => {
  const positions = { a: { c: 0, r: 0 }, b: { c: 1, r: 0 } };
  const off = nearestFreeOffset(["a"], positions, 1, 0);
  assert.notDeepEqual(off, { c: 1, r: 0 });
  assert.equal(Math.max(Math.abs(off.c - 1), Math.abs(off.r)), 1);
});

test("a selection moves as one: over its own cells, never onto another window", () => {
  const positions = { a: { c: 0, r: 0 }, b: { c: 1, r: 0 }, c: { c: 3, r: 0 } };
  assert.deepEqual(nearestFreeOffset(["a", "b"], positions, 1, 0), { c: 1, r: 0 });
  const off = nearestFreeOffset(["a", "b"], positions, 2, 0);
  assert.notDeepEqual(off, { c: 2, r: 0 });
  for (const p of [positions.a, positions.b]) {
    assert.notDeepEqual({ c: p.c + off.c, r: p.r + off.r }, positions.c);
  }
});

test("a selection box takes every window it touches, even by a corner", () => {
  const positions = { a: { c: 0, r: 0 }, b: { c: 1, r: 0 }, c: { c: 0, r: 1 }, d: { c: 3, r: 3 } };
  const hit = (left: number, top: number, right: number, bottom: number) =>
    windowsTouching(positions, 100, 200, { left, top, right, bottom }).sort();
  assert.deepEqual(hit(90, 190, 110, 210), ["a", "b", "c"]);
  assert.deepEqual(hit(10, 10, 20, 20), ["a"]);
  // Edges that only meet don't count; empty board takes nothing.
  assert.deepEqual(hit(100, 0, 150, 50), ["b"]);
  assert.deepEqual(hit(150, 250, 250, 350), []);
});

test("auto-arrange packs each repo into a block, blocks apart, order kept", () => {
  const repo: Record<string, string> = { a1: "A", a2: "A", a3: "A", b1: "B", b2: "B" };
  const positions = {
    b1: { c: 9, r: 4 },
    a2: { c: 7, r: 3 },
    a1: { c: -2, r: 0 },
    b2: { c: 12, r: -5 },
    a3: { c: 1, r: 8 },
  };
  const out = arrange(positions, (id) => repo[id]);
  // A starts further left, so it goes first; three windows → two columns.
  assert.deepEqual(out.a1, { c: 0, r: 0 });
  assert.deepEqual(out.a2, { c: 1, r: 0 });
  assert.deepEqual(out.a3, { c: 0, r: 1 });
  // One empty column, then B in reading order (b2 is higher up).
  assert.deepEqual(out.b2, { c: 3, r: 0 });
  assert.deepEqual(out.b1, { c: 4, r: 0 });
});

test("arrow keys step to the nearest window that way, keeping to the row", () => {
  // a b . d
  // e . . .
  const positions = {
    a: { c: 0, r: 0 },
    b: { c: 1, r: 0 },
    d: { c: 3, r: 0 },
    e: { c: 0, r: 1 },
  };
  assert.equal(neighbourIn("a", positions, "right"), "b");
  assert.equal(neighbourIn("b", positions, "right"), "d");
  assert.equal(neighbourIn("d", positions, "right"), null);
  assert.equal(neighbourIn("a", positions, "down"), "e");
  assert.equal(neighbourIn("e", positions, "up"), "a");
  // Nothing shares e's row, so right goes to the nearest window up and right.
  assert.equal(neighbourIn("e", positions, "right"), "b");
  assert.equal(neighbourIn("b", positions, "left"), "a");
});
