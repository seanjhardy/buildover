import { test } from "node:test";
import assert from "node:assert/strict";
import { matchLines, searchLines } from "./gridSearch.js";
import type { ChatRecord } from "../src/types.js";

const record = {
  title: "Fix the  login bug",
  events: [
    { type: "user_message", id: "u1", text: "The login\nbutton is broken", ts: "1" },
    {
      type: "assistant",
      uuid: "a1",
      sessionId: "s",
      ts: "2",
      content: [
        { type: "thinking", thinking: "login login" },
        { type: "text", text: "Fixed the LOGIN handler." },
        { type: "tool_use", id: "t", name: "Bash", input: { command: "login" } },
      ],
    },
  ],
} as unknown as ChatRecord;

test("searchLines keeps the title, user and assistant text, squashed", () => {
  assert.deepEqual(
    searchLines(record).map((l) => [l.role, l.text]),
    [
      ["title", "Fix the login bug"],
      ["user", "The login button is broken"],
      ["assistant", "Fixed the LOGIN handler."],
    ],
  );
});

test("matchLines counts every match, title first then newest", () => {
  const m = matchLines(searchLines(record), "  Login ");
  assert.ok(m);
  assert.equal(m.count, 3);
  assert.deepEqual(m.snippets.map((s) => s.role), ["title", "assistant", "user"]);
  for (const s of m.snippets) assert.equal(s.text.slice(s.start, s.start + s.length).toLowerCase(), "login");
  assert.equal(matchLines(searchLines(record), "logout"), null);
  assert.equal(matchLines(searchLines(record), "   "), null);
});

test("long lines are cut round the match at word edges", () => {
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  const m = matchLines([{ role: "user", text: words }], "word40");
  assert.ok(m);
  const [s] = m.snippets;
  assert.ok(s.text.startsWith("…word") && s.text.endsWith("…"));
  assert.equal(s.text.slice(s.start, s.start + s.length), "word40");
  assert.ok(s.text.length < 170);
});
