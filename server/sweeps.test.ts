import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextSweep } from "./sweeps.js";

const at = (s: string) => new Date(s);
const hm = (d: Date) => `${d.getDay()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const times = ["14:00", "09:30"];

describe("nextSweep", () => {
  it("picks the next sweep the same day", () => {
    assert.equal(hm(nextSweep(at("2026-11-05T08:00:00"), times)), "4 9:30");
    assert.equal(hm(nextSweep(at("2026-11-05T09:30:00"), times)), "4 14:00");
  });
  it("rolls over to the next weekday", () => {
    assert.equal(hm(nextSweep(at("2026-11-05T15:00:00"), times)), "5 9:30");
    assert.equal(hm(nextSweep(at("2026-11-06T15:00:00"), times)), "1 9:30");
    assert.equal(hm(nextSweep(at("2026-11-07T10:00:00"), times)), "1 9:30");
  });
});
