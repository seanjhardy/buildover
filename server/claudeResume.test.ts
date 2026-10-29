import assert from "node:assert/strict";
import { test } from "node:test";
import { planClaudeResume } from "./chats.js";
import type { ChatEvent, ChatRecord } from "../src/types.js";

const ts = "2026-10-26T00:00:00.000Z";

function turn(model: string, sessionId: string, text: string, n: number): ChatEvent[] {
  return [
    { type: "user_message", id: `u-${n}`, text, ts },
    { type: "system_init", sessionId, tools: [], mcpServers: [], model, ts },
    {
      type: "assistant",
      uuid: `${sessionId}-a-${n}`,
      sessionId,
      content: [
        { type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `git push ${n}` } },
        { type: "text", text: `reply ${n}` },
      ],
      ts,
    },
    { type: "result", sessionId, subtype: "success", durationMs: 1, numTurns: 1, ts },
  ];
}

function chat(events: ChatEvent[], extra: Partial<ChatRecord> = {}): ChatRecord {
  return { id: "c", title: "t", events, ...extra } as ChatRecord;
}

test("Claude-only chat resumes its session as before", () => {
  const plan = planClaudeResume(
    chat(turn("claude-opus-5-5", "claude-1", "hi", 1), { providerSessions: { claude: "claude-1" } }),
  );
  assert.deepEqual(plan, { sessionId: "claude-1", resumeSessionAt: undefined, history: undefined });
});

test("back to Claude after Cursor anchors at Claude's last message and hands over the rest", () => {
  const plan = planClaudeResume(
    chat(
      [
        ...turn("claude-opus-5-5", "claude-1", "first", 1),
        ...turn("cursor:composer-2.5", "cursor-uuid", "second", 2),
        { type: "user_message", id: "u-3", text: "audit that", ts },
        { type: "result", sessionId: "bogus", subtype: "error_during_execution", durationMs: 0, numTurns: 0, ts },
      ],
      {
        sessionId: "cursor-uuid",
        resumeSessionAt: "cursor-uuid-a-2",
        providerSessions: { claude: "bogus", cursor: "cursor-uuid" },
      },
    ),
  );
  assert.equal(plan.sessionId, "claude-1");
  assert.equal(plan.resumeSessionAt, "claude-1-a-1");
  assert.match(plan.history!, /User: second/);
  assert.match(plan.history!, /\[Bash: git push 2\]/);
  assert.match(plan.history!, /reply 2/);
  assert.match(plan.history!, /User: audit that/);
  assert.doesNotMatch(plan.history!, /first/);
});

test("a resume marker pointing at another provider's message is dropped", () => {
  const plan = planClaudeResume(
    chat(turn("cursor:composer-2.5", "cursor-uuid", "only cursor", 1), {
      resumeSessionAt: "cursor-uuid-a-1",
      providerSessions: { cursor: "cursor-uuid" },
      sessionId: "cursor-uuid",
    }),
  );
  assert.equal(plan.sessionId, undefined);
  assert.equal(plan.resumeSessionAt, undefined);
  assert.match(plan.history!, /only cursor/);
});
