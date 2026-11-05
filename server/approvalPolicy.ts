import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { complete } from "./anthropicDirect.js";
import { PIPELINES_DIR } from "./pageTools.js";

// Approval gate for agents working out of sight. Almost everything runs on its
// own; only significant sign-off or important writing waits for the user:
// sending an email, posting to Slack as them, marking a PR ready or merging it,
// landing work on main, and changing a database (one approval per job covers
// every later write in the same chat). It runs as a PreToolUse hook, so it
// holds even when the chat bypasses permissions.
//
// Extra rules can live privately in <pipelines dir>/approvals.json:
//   [{ "tool": "<regex on tool name>", "input": "<regex on JSON input>", "why": "...", "group": "..." }]

export interface Rule {
  tool: RegExp;
  input?: RegExp;
  why: string;
  /** Calls in the same group share one approval per chat. */
  group?: string;
}

export type Verdict = { ask: false } | { ask: true; why: string; group?: string };

const PROTECTED = "(main|master|production)";

export const BUILTIN_RULES: Rule[] = [
  { tool: /^mcp__.*Gmail.*__.*send/i, why: "Sends an email as you" },
  { tool: /^mcp__.*Slack.*__slack_(send_message|schedule_message)$/i, why: "Posts to Slack as you" },
  { tool: /^Bash$/, input: /\bgh\s+pr\s+merge\b/, why: "Merges a pull request" },
  { tool: /^Bash$/, input: /\bgh\s+pr\s+ready\b(?![^;&|\n]*--undo)/, why: "Marks a pull request ready for review" },
  { tool: /^Bash$/, input: /\bgh\s+pr\s+create\b(?![^;&|\n]*--draft)/, why: "Opens a pull request that isn't a draft" },
  { tool: /^Bash$/, input: new RegExp(`\\bgit\\s+push\\b[^;&|\\n]*[\\s:/]${PROTECTED}\\b`), why: "Pushes to main" },
  { tool: /^Bash$/, input: /\bsupabase\s+(db\s+push|migration\s+(up|repair))\b/, why: "Changes a hosted database", group: "database" },
  {
    tool: /^Bash$/,
    input: /\b(psql|sqlite3|mysql)\b[^\n]*\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i,
    why: "Writes to a database",
    group: "database",
  },
  { tool: /^mcp__.*(supabase|postgres|database|sql).*__.*(execute|apply|write|migrat)/i, why: "Writes to a database", group: "database" },
];

/** Supabase Management API calls that can write: anything sending data except read-only queries. */
function managementWrite(cmd: string): boolean {
  if (!/api\.supabase\.com/.test(cmd)) return false;
  if (!/(-X|--request)\s*["']?(POST|PATCH|PUT|DELETE)|\s(-d|--data[\w-]*|-F|--form)\b/i.test(cmd)) return false;
  if (/api\.supabase\.com\/v1\/(?![^\s"']*\/database\/query)[^\s"']*/.test(cmd)) return true;
  return !/["']?read_only["']?\s*[:=]\s*(true|True|1)\b/.test(cmd);
}

export function loadPrivateRules(file = join(PIPELINES_DIR, "approvals.json")): Rule[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Array<{ tool?: string; input?: string; why?: string; group?: string }>;
    return raw
      .filter((r) => r.tool && r.why)
      .map((r) => ({
        tool: new RegExp(r.tool!, "i"),
        ...(r.input ? { input: new RegExp(r.input, "i") } : {}),
        why: r.why!,
        ...(r.group ? { group: r.group } : {}),
      }));
  } catch {
    return [];
  }
}

/**
 * Whether a call needs the user's OK. `branch` is the current git branch of
 * the working directory, so a bare `git push` while on main counts as landing.
 */
export function classify(name: string, input: unknown, rules: Rule[], branch?: string | null): Verdict {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? {});
  const cmd = name === "Bash" && input && typeof input === "object" ? String((input as Record<string, unknown>).command ?? "") : "";
  for (const r of rules) {
    if (!r.tool.test(name)) continue;
    if (r.input && !r.input.test(cmd || text)) continue;
    return { ask: true, why: r.why, ...(r.group ? { group: r.group } : {}) };
  }
  if (cmd) {
    if (managementWrite(cmd)) return { ask: true, why: "Changes a hosted database", group: "database" };
    if (branch && new RegExp(`^${PROTECTED}$`).test(branch) && /\bgit\s+push\b(?![^;&|\n]*\s(-d|--delete)\b)/.test(cmd)) {
      // A bare push (or one naming only a remote) lands the current branch.
      const bare = /\bgit\s+push(\s+(-u|--set-upstream|--force-with-lease|-f|--force))*(\s+origin)?\s*($|[;&|\n])/.test(cmd);
      if (bare) return { ask: true, why: "Pushes to main" };
    }
  }
  return { ask: false };
}

export interface ApprovalRequest {
  tool: string;
  input: unknown;
  why: string;
  /** One or two plain sentences: what is about to happen, where, and whether it can be undone. */
  plain: string;
}

export type ApprovalAnswer = { allow: true } | { allow: false; reason?: string; interrupt?: boolean };

/** Say in plain words what a call is about to do. Falls back to the rule's reason. */
export async function describeCall(tool: string, input: unknown, why: string): Promise<string> {
  const own = input && typeof input === "object" ? (input as Record<string, unknown>).description : undefined;
  try {
    const { text } = await complete({
      model: "claude-haiku-4-5",
      maxTokens: 200,
      userPrompt: `A coding agent wants to run this tool call, and it needs the user's OK first because it ${why.toLowerCase()}.
Tool: ${tool}
Input: ${JSON.stringify(input).slice(0, 4000)}
${typeof own === "string" ? `The agent's own description: ${own}\n` : ""}
Write one or two short plain sentences a busy founder understands at a glance: what is about to happen, where (by name), and whether it can be undone. No ids, hashes or code. Output only the sentences.`,
    });
    return text.trim() || why;
  } catch {
    return typeof own === "string" && own.trim() ? own.trim() : why;
  }
}

const run = promisify(execFile);
async function currentBranch(cwd: string): Promise<string | null> {
  try {
    return (await run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 3000 })).stdout.trim();
  } catch {
    return null;
  }
}

export interface ApprovalHookOptions {
  ask: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
  /** Groups the user has already approved in this chat; kept by the caller so it outlives the query. */
  approvedGroups?: Set<string>;
  rules?: Rule[];
}

/** PreToolUse hook matchers for the SDK's `hooks` option. */
export function approvalHooks(opts: ApprovalHookOptions): { PreToolUse: HookCallbackMatcher[] } {
  const approved = opts.approvedGroups ?? new Set<string>();
  const decide = (allow: boolean, reason?: string): HookJSONOutput => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: allow ? "allow" : "deny",
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  });
  return {
    PreToolUse: [
      {
        // The user can take hours to answer; the SDK's default hook timeout is far shorter.
        timeout: 7 * 24 * 3600,
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            const rules = opts.rules ?? [...BUILTIN_RULES, ...loadPrivateRules()];
            const branch = input.tool_name === "Bash" ? await currentBranch(input.cwd) : null;
            const v = classify(input.tool_name, input.tool_input, rules, branch);
            if (!v.ask) return {};
            if (v.group && approved.has(v.group)) return decide(true);
            const plain = await describeCall(input.tool_name, input.tool_input, v.why);
            const answer = await opts.ask({ tool: input.tool_name, input: input.tool_input, why: v.why, plain });
            if (answer.allow) {
              if (v.group) approved.add(v.group);
              return decide(true);
            }
            const reason = answer.reason?.trim()
              ? `The user said no: ${answer.reason.trim()}`
              : "The user said no. Don't try this another way; tell them what you would have done.";
            return answer.interrupt ? { ...decide(false, reason), continue: false, stopReason: reason } : decide(false, reason);
          },
        ],
      },
    ],
  };
}
