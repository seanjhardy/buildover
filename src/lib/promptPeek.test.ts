import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { indexOfPromptAbove } from "./promptPeek.js";

const ids = ["u1", "u2", "u3", "u4"];

describe("indexOfPromptAbove", () => {
  it("picks the newest message that starts above the cutoff", () => {
    const mounted = [
      { id: "u1", top: -900 },
      { id: "u2", top: -300 },
      { id: "u3", top: 250 },
      { id: "u4", top: 700 },
    ];
    assert.equal(indexOfPromptAbove(ids, mounted, 40), 1);
  });

  it("counts a message starting just under the cutoff as still in view", () => {
    const mounted = [
      { id: "u3", top: -20 },
      { id: "u4", top: 40 },
    ];
    assert.equal(indexOfPromptAbove(ids, mounted, 40), 2);
  });

  it("falls back to the message before the loaded window", () => {
    const mounted = [
      { id: "u3", top: 120 },
      { id: "u4", top: 600 },
    ];
    assert.equal(indexOfPromptAbove(ids, mounted, 40), 1);
  });

  it("finds nothing at the top of the transcript", () => {
    const mounted = [
      { id: "u1", top: 80 },
      { id: "u2", top: 500 },
    ];
    assert.equal(indexOfPromptAbove(ids, mounted, 40), -1);
  });

  it("uses the newest message when the window holds no user messages", () => {
    assert.equal(indexOfPromptAbove(ids, [], 40), 3);
    assert.equal(indexOfPromptAbove([], [], 40), -1);
  });
});
