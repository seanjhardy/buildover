import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  HANDOFF_SECTIONS,
  HANDOFF_WARM_PROMPT,
  chatCacheIsWarm,
  handoffPrefill,
  renderTranscript,
  saveHandoffNote,
} from "./handoff.js";
import type { ChatRecord } from "../src/types.js";

const MIN = 60_000;

function record(overrides: Partial<ChatRecord> = {}): ChatRecord {
  const ts = "2026-10-12T10:00:00Z";
  return {
    id: "ch_test",
    title: "Fix login",
    titleAuto: false,
    status: "idle",
    userMarkedFinished: false,
    model: "claude-opus-5-5",
    permissionMode: "default",
    createdAt: ts,
    updatedAt: ts,
    events: [
      { type: "user_message", id: "u1", text: "Fix the login bug", ts },
      {
        type: "assistant",
        uuid: "a1",
        sessionId: "s",
        ts,
        content: [
          { type: "thinking", thinking: "SECRET THOUGHTS" },
          { type: "text", text: "Looking at auth." },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.ts", offset: 1 } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test\n--silent" } },
        ],
      },
      {
        type: "user_tool_results",
        uuid: "r1",
        sessionId: "s",
        ts,
        content: [{ type: "tool_result", tool_use_id: "t1", content: "HUGE FILE CONTENTS" }],
      },
    ],
    ...overrides,
  };
}

describe("renderTranscript", () => {
  it("keeps user/assistant text and tool names with short args, drops results and thinking", () => {
    const text = renderTranscript(record());
    assert.match(text, /User: Fix the login bug/);
    assert.match(text, /Assistant: Looking at auth\./);
    assert.match(text, /\[tool\] Read\(src\/auth\.ts\)/);
    assert.match(text, /\[tool\] Bash\(npm test --silent\)/);
    assert.doesNotMatch(text, /HUGE FILE CONTENTS/);
    assert.doesNotMatch(text, /SECRET THOUGHTS/);
  });

  it("elides the middle of an oversized transcript but keeps the start and the end", () => {
    const events: ChatRecord["events"] = [];
    for (let i = 0; i < 400; i++) {
      events.push({ type: "user_message", id: `u${i}`, text: `message-${i} ${"x".repeat(500)}`, ts: "t" });
    }
    const text = renderTranscript(record({ events }), 50_000);
    assert.ok(text.length < 80_000);
    assert.match(text, /message-0 /);
    assert.match(text, /message-399 /);
    assert.match(text, /middle history omitted/);
  });
});

describe("chatCacheIsWarm", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  it("is warm under 55 min since the last API call, cold after", () => {
    const at = (minsAgo: number) => new Date(now - minsAgo * MIN).toISOString();
    assert.equal(chatCacheIsWarm(record({ cost: { totalUsd: 1, lastTurnUsd: 1, turns: 1, lastApiAt: at(54) } }), now), true);
    assert.equal(chatCacheIsWarm(record({ cost: { totalUsd: 1, lastTurnUsd: 1, turns: 1, lastApiAt: at(56) } }), now), false);
  });
  it("falls back to the last event timestamp for chats without cost data", () => {
    const warm = record({ events: [{ type: "user_message", id: "u", text: "hi", ts: new Date(now - 10 * MIN).toISOString() }] });
    assert.equal(chatCacheIsWarm(warm, now), true);
  });
});

describe("handoff note", () => {
  it("asks for every required section", () => {
    for (const section of HANDOFF_SECTIONS) assert.ok(HANDOFF_WARM_PROMPT.includes(`## ${section}`));
  });

  it("saves under .buildover/handoffs/<chatId>-<timestamp>.md and builds the prefill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "handoff-test-"));
    try {
      const path = await saveHandoffNote(record(), dir, "## Goal\nShip it");
      assert.ok(path.startsWith(join(dir, ".buildover", "handoffs", "ch_test-")));
      assert.ok(path.endsWith(".md"));
      assert.match(await readFile(path, "utf8"), /## Goal\nShip it/);
      assert.equal(
        handoffPrefill(path, "NOTE"),
        `Continue from the handoff note at ${path}:\n\nNOTE`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
