import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TurnSlots } from "./turnSlots.js";

const tick = () => new Promise((r) => setImmediate(r));

describe("TurnSlots", () => {
  it("grants up to max slots immediately and queues the rest FIFO", async () => {
    const slots = new TurnSlots(2);
    assert.equal(await slots.acquire(), true);
    assert.equal(await slots.acquire(), true);

    const order: string[] = [];
    const a = slots.acquire().then(() => order.push("a"));
    const b = slots.acquire().then(() => order.push("b"));
    const c = slots.acquire().then(() => order.push("c"));
    await tick();
    assert.deepEqual(order, []);
    assert.deepEqual(slots.stats, { running: 2, max: 2, queued: 3 });

    slots.release();
    await a;
    assert.deepEqual(order, ["a"]);
    slots.release();
    await b;
    slots.release();
    await c;
    assert.deepEqual(order, ["a", "b", "c"]);
    assert.equal(slots.stats.running, 2);
  });

  it("reports queue positions as the queue drains", async () => {
    const slots = new TurnSlots(1);
    await slots.acquire();
    const seenA: number[] = [];
    const seenB: number[] = [];
    const a = slots.acquire({ onPosition: (p) => seenA.push(p) });
    const b = slots.acquire({ onPosition: (p) => seenB.push(p) });
    slots.release();
    await a;
    assert.deepEqual(seenA, [1]);
    assert.deepEqual(seenB, [2, 1]);
    slots.release();
    await b;
  });

  it("removes an aborted waiter and resolves false without leaking a slot", async () => {
    const slots = new TurnSlots(1);
    await slots.acquire();
    const ac = new AbortController();
    const aborted = slots.acquire({ signal: ac.signal });
    const next = slots.acquire();
    ac.abort();
    assert.equal(await aborted, false);
    assert.equal(slots.stats.queued, 1);
    slots.release();
    assert.equal(await next, true);
    assert.equal(slots.stats.running, 1);
  });

  it("lets a resuming turn jump the queue", async () => {
    const slots = new TurnSlots(1);
    await slots.acquire();
    const order: string[] = [];
    const fresh = slots.acquire().then(() => order.push("fresh"));
    const resuming = slots.acquire({ front: true }).then(() => order.push("resuming"));
    slots.release();
    await resuming;
    slots.release();
    await fresh;
    assert.deepEqual(order, ["resuming", "fresh"]);
  });

  it("tryAcquire never overtakes a queued waiter", async () => {
    const slots = new TurnSlots(1);
    await slots.acquire();
    const waiting = slots.acquire();
    slots.release(); // hands the slot to the waiter
    assert.equal(slots.tryAcquire(), false);
    await waiting;
  });

  it("releasing a slot while suspended for user input unblocks queued work (no starvation)", async () => {
    // Models AgentSession.suspendSlot/resumeSlot: 2 turns hold both slots and
    // park on permission prompts; a third turn must still run.
    const slots = new TurnSlots(2);
    await slots.acquire();
    await slots.acquire();
    const third = slots.acquire();
    slots.release(); // turn 1 parks on a prompt
    assert.equal(await third, true);
    // turn 1's user answers: it resumes at the front and waits for capacity.
    const resumed = slots.acquire({ front: true });
    slots.release(); // turn 3 finishes
    assert.equal(await resumed, true);
  });

  it("raising max wakes waiters; max <= 0 means unlimited", async () => {
    const slots = new TurnSlots(1);
    await slots.acquire();
    const waiting = slots.acquire();
    slots.setMax(2);
    assert.equal(await waiting, true);
    slots.setMax(0);
    for (let i = 0; i < 20; i++) assert.equal(slots.tryAcquire(), true);
  });
});
