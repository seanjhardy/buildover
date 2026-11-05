import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldPage, hasFrontPage, pageEntries, type PageEntry } from "./frontPage.js";

const call = (name: string, input: unknown): PageEntry => ({ kind: "tool", name: `mcp__buildover-page__${name}`, input });

describe("foldPage", () => {
  it("builds the card, sentences and options from the page tools", () => {
    const page = foldPage([
      call("set_card", { title: "Login redirect", summary: "Users land on a blank page", tags: ["Brand PLM", "Bug"] }),
      call("milestone", { kind: "issue", text: "After logging in I see nothing" }),
      call("milestone", { kind: "context", text: "First." }),
      call("milestone", { kind: "context", text: "Second." }),
      call("milestone", { kind: "state", text: "Waiting for you to check it" }),
      call("suggest_options", { options: [{ label: "Land the fix" }, { label: "Leave it", detail: "for now" }] }),
    ]);
    assert.equal(page.title, "Login redirect");
    assert.deepEqual(page.tags, ["Brand PLM", "Bug"]);
    assert.deepEqual(page.issues, ["After logging in I see nothing"]);
    assert.equal(page.context, "Second.");
    assert.equal(page.state, "Waiting for you to check it");
    assert.deepEqual(page.options.map((o) => o.label), ["Land the fix", "Leave it"]);
    assert.ok(hasFrontPage(page));
  });

  it("has no front page until a summary or context is written", () => {
    assert.equal(hasFrontPage(foldPage([call("milestone", { kind: "state", text: "Reading" })])), false);
  });

  it("versions panels, patches the latest content and moves re-shown panels last", () => {
    const page = foldPage([
      call("show_panel", { key: "a", format: "markdown", content: "one two" }),
      call("show_panel", { key: "preview", format: "url", content: "http://localhost:3000" }),
      call("patch_panel", { key: "a", find: "two", replace: "three" }),
      call("patch_panel", { key: "a", find: "missing", replace: "x" }),
      call("show_panel", { key: "preview" }),
    ]);
    assert.deepEqual(page.panels.map((p) => p.key), ["a", "preview"]);
    assert.equal(page.panels[0].content, "one three");
    assert.equal(page.panels[0].version, 2);
    assert.equal(page.panels[1].format, "url");
  });

  it("clears options, waits and closes when the user writes", () => {
    const parked = foldPage([
      call("suggest_options", { options: [{ label: "Yes" }] }),
      call("wait", { note: "Their reply", event: "Email from Tom" }),
    ]);
    assert.equal(parked.waiting?.event, "Email from Tom");
    const back = foldPage([
      call("suggest_options", { options: [{ label: "Yes" }] }),
      call("done", { note: "Shipped" }),
      { kind: "user" },
    ]);
    assert.deepEqual(back.options, []);
    assert.equal(back.done, undefined);
  });

  it("ignores failed calls and other tools", () => {
    const entries = pageEntries([
      {
        blocks: [
          { type: "tool_use", id: "1", name: "mcp__buildover-page__wait", input: { note: "x", until: "yesterday" } },
          { type: "tool_use", id: "2", name: "Bash", input: { command: "ls" } },
        ],
      },
      { blocks: [{ type: "tool_result", tool_use_id: "1", content: "NOT SAVED", is_error: true }] },
      { user: true },
    ]);
    assert.equal(entries.length, 2);
    assert.equal(foldPage(entries.slice(0, 1)).waiting, undefined);
  });
});
