import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityLabel, condenseTranscript, type RenderedTurn } from "./condenseTranscript.js";

const user = (id: string, text = "hi"): RenderedTurn => ({ kind: "user", id, text });
const assistant = (id: string, ...content: any[]): RenderedTurn =>
  ({ kind: "assistant", id, content });
const text = (t: string) => ({ type: "text" as const, text: t });
const think = (t: string) => ({ type: "thinking" as const, thinking: t });
const tool = (id: string, name = "Bash") =>
  ({ type: "tool_use" as const, id, name, input: {} });

const shape = (rows: ReturnType<typeof condenseTranscript>) =>
  rows.map((r) =>
    r.kind === "activity" ? `activity:${r.toolCount}` : `turn:${r.turn.kind}:${r.key}`,
  );

describe("condenseTranscript", () => {
  it("keeps the user message and the closing assistant message, collapsing the work between", () => {
    const rows = condenseTranscript([
      user("u1"),
      assistant("a1", think("hmm"), text("let me look"), tool("t1"), tool("t2")),
      assistant("a2", tool("t3")),
      assistant("a3", text("All done — here is the summary.")),
    ]);
    assert.deepEqual(shape(rows), ["turn:user:u1", "activity:3", "turn:assistant:a3-v0"]);
    const activity = rows[1];
    assert.equal(activity.kind === "activity" && activity.toolCount, 3);
  });

  it("merges only consecutive activity, never across a kept message", () => {
    const rows = condenseTranscript([
      user("u1"),
      assistant("a1", text("step one"), tool("t1")),
      assistant("a2", text("final word")),
      user("u2"),
      assistant("a3", tool("t2"), tool("t3")),
      assistant("a4", text("second answer")),
    ]);
    assert.deepEqual(shape(rows), [
      "turn:user:u1",
      "activity:1",
      "turn:assistant:a2-v0",
      "turn:user:u2",
      "activity:2",
      "turn:assistant:a4-v0",
    ]);
  });

  it("keeps the prose immediately before a question", () => {
    const rows = condenseTranscript([
      user("u1"),
      assistant("a1", text("I checked three options.")),
      assistant("a2", tool("q1", "AskUserQuestion")),
      assistant("a3", tool("t1")),
      assistant("a4", text("done")),
    ]);
    // a1 survives even though a4 is the closing message of the turn.
    assert.deepEqual(shape(rows), [
      "turn:user:u1",
      "turn:assistant:a1-v0",
      "activity:2",
      "turn:assistant:a4-v0",
    ]);
  });

  it("keeps prose when the question tool is in the same turn, including via MCP names", () => {
    const rows = condenseTranscript([
      user("u1"),
      assistant(
        "a1",
        text("Which direction?"),
        tool("q1", "mcp__buildover-custom-tools__RequestUserAttention"),
      ),
      assistant("a2", tool("t1")),
    ]);
    assert.deepEqual(shape(rows), ["turn:user:u1", "turn:assistant:a1-v0", "activity:2"]);
  });

  it("keeps thinking that precedes kept prose in chronological order", () => {
    const rows = condenseTranscript([user("u1"), assistant("a1", think("deliberating"), text("answer"))]);
    assert.deepEqual(shape(rows), ["turn:user:u1", "activity:0", "turn:assistant:a1-v0"]);
  });

  it("treats presentational output as content, not activity", () => {
    const rows = condenseTranscript([
      user("u1"),
      assistant("a1", tool("t1"), tool("r1", "mcp__x__RenderTable"), text("there it is")),
    ]);
    assert.deepEqual(shape(rows), [
      "turn:user:u1",
      "activity:1",
      "turn:assistant:a1-v0",
    ]);
    const visible = rows[2];
    assert.equal(visible.kind === "turn" && visible.content?.length, 2);
  });

  it("loses nothing: every block lands on a visible row or inside an activity row", () => {
    const turns = [
      user("u1"),
      assistant("a1", think("t"), text("mid"), tool("t1")),
      assistant("a2", tool("t2"), text("end")),
    ];
    const total = turns.reduce(
      (n, t) => n + (t.kind === "assistant" ? t.content.length : 1),
      0,
    );
    const seen = condenseTranscript(turns).reduce(
      (n, r) =>
        n +
        (r.kind === "activity"
          ? r.parts.reduce((m, p) => m + p.content.length, 0)
          : r.content
            ? r.content.length
            : 1),
      0,
    );
    assert.equal(seen, total);
  });

  it("keeps result lines as their own high-level row", () => {
    const rows = condenseTranscript([
      user("u1"),
      assistant("a1", text("done")),
      { kind: "result", id: "r1", subtype: "success", durationMs: 1, numTurns: 2 },
    ]);
    assert.deepEqual(shape(rows), ["turn:user:u1", "turn:assistant:a1-v0", "turn:result:r1"]);
  });

  it("handles an empty transcript", () => {
    assert.deepEqual(condenseTranscript([]), []);
  });
});

describe("activityLabel", () => {
  it("counts tools and singularises", () => {
    assert.equal(activityLabel(1), "used 1 tool");
    assert.equal(activityLabel(7), "used 7 tools");
    assert.equal(activityLabel(0), "thinking");
  });
});
