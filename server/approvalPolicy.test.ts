import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_RULES, classify } from "./approvalPolicy.js";

const bash = (command: string, branch?: string) => classify("Bash", { command }, BUILTIN_RULES, branch);

describe("classify", () => {
  it("lets ordinary work run", () => {
    for (const c of ["git status", "npm test", "git push origin fix/login", "gh pr create --draft --title x", "gh pr view 12", "psql -c 'select * from users'"])
      assert.equal(bash(c, "fix/login").ask, false, c);
    assert.equal(classify("mcp__claude_ai_Slack__slack_send_message_draft", {}, BUILTIN_RULES).ask, false);
    assert.equal(classify("mcp__claude_ai_Gmail__gmail_create_draft", {}, BUILTIN_RULES).ask, false);
  });

  it("asks before speaking as the user", () => {
    assert.equal(classify("mcp__claude_ai_Slack__slack_send_message", {}, BUILTIN_RULES).ask, true);
    assert.equal(classify("mcp__claude_ai_Gmail__send_email", {}, BUILTIN_RULES).ask, true);
  });

  it("asks before PR sign-off and landing on main", () => {
    for (const c of ["gh pr merge 12 --squash", "gh pr ready 12", "gh pr create --title x", "git push origin main", "git push origin HEAD:main", "cd repo && git push origin master"])
      assert.equal(bash(c).ask, true, c);
    assert.equal(bash("gh pr ready 12 --undo").ask, false);
  });

  it("treats a bare push on main as landing", () => {
    assert.equal(bash("git push", "main").ask, true);
    assert.equal(bash("git push -u origin", "main").ask, true);
    assert.equal(bash("git push", "fix/x").ask, false);
    assert.equal(bash("git push origin fix/x", "main").ask, false);
  });

  it("groups database writes", () => {
    const v = bash("psql $DB -c 'update orders set paid = true'");
    assert.deepEqual(v, { ask: true, why: "Writes to a database", group: "database" });
    assert.equal(bash(`curl -X POST https://api.supabase.com/v1/projects/abc/database/query -d '{"query":"delete from x"}'`).ask, true);
    assert.equal(bash(`curl -X POST https://api.supabase.com/v1/projects/abc/database/query -d '{"query":"select 1","read_only":true}'`).ask, false);
  });
});
