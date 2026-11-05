import { tmpdir } from "node:os";
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { readInstalledServers, toSdkMcpConfig } from "./mcp-config.js";

// A source read through MCP connectors (Gmail, Slack): a small agent with only
// those servers' tools looks for what's new and replies with rows. It can only
// read: a tool whose name says it sends or changes anything is refused.

const MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 5 * 60_000;
const MAX_TURNS = 30;

const WRITE_VERBS = new Set([
  "send", "post", "create", "delete", "remove", "update", "edit", "modify", "reply", "forward", "draft",
  "archive", "trash", "label", "mark", "react", "invite", "upload", "add", "set", "move", "schedule",
  "join", "leave", "kick", "pin", "star", "unstar", "write", "patch", "put", "insert", "open", "close",
]);

/** Whether an MCP tool's own name (without the mcp__server__ prefix) reads as a write. */
export function isWriteTool(tool: string): boolean {
  return tool
    .split(/[_\-\s.]+|(?<=[a-z])(?=[A-Z])/)
    .some((w) => WRITE_VERBS.has(w.toLowerCase()));
}

const ROWS_FORMAT = [
  "Reply with only a JSON array, no prose around it. One object per item:",
  '{"id": a stable id (the same thread or email always gets the same id), "title": a short plain title,',
  '"url": a link if there is one, "version": something that changes when there\'s news (e.g. the latest message\'s timestamp),',
  '"joins": the GitHub pull request URL when the item asks for a review of that PR,',
  '"data": what the agent who works the item needs, quoting messages verbatim with who sent them and when}.',
  "Reply [] when nothing is new.",
].join("\n");

/** Pull the JSON array out of the agent's reply. */
export function parseRows(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error(`Connector agent didn't reply with rows: ${text.slice(0, 200)}`);
  const rows = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(rows)) throw new Error("Connector agent's reply isn't a list");
  return rows;
}

const FILE_TOOLS = ["Read", "Grep", "Glob"];

/** A connector the source reads through isn't signed in. */
export class NeedsSignIn extends Error {
  constructor(readonly servers: string[]) {
    super(`${servers.join(" and ")} isn't signed in`);
  }
}

export async function agentFetch(
  servers: string[],
  prompt: string,
  model: string | undefined,
  /** Also let it read files here (read only). */
  cwd?: string,
): Promise<{ rows: unknown[]; costUsd: number }> {
  const installed = readInstalledServers().filter((s) => servers.includes(s.id));
  const missing = servers.filter((id) => !installed.some((s) => s.id === id));
  if (missing.length) throw new Error(`MCP server not installed: ${missing.join(", ")}`);

  const canUseTool: CanUseTool = async (name, input) => {
    if (cwd && FILE_TOOLS.includes(name)) return { behavior: "allow", updatedInput: input };
    const [, server, ...rest] = name.split("__");
    const tool = rest.join("__");
    if (!name.startsWith("mcp__") || !servers.includes(server)) {
      return { behavior: "deny", message: "Only the source's connector tools are available." };
    }
    if (isWriteTool(tool)) return { behavior: "deny", message: "Read only: nothing may be sent or changed." };
    return { behavior: "allow", updatedInput: input };
  };

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  try {
    const q = query({
      prompt: `${prompt}\n\n${ROWS_FORMAT}`,
      options: {
        model: model ?? MODEL,
        tools: cwd ? FILE_TOOLS : [],
        mcpServers: toSdkMcpConfig(installed) as never,
        canUseTool,
        maxTurns: MAX_TURNS,
        persistSession: false,
        settingSources: [],
        cwd: cwd ?? tmpdir(),
        abortController,
      },
    });
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        // Without its connector the agent would just find nothing; say why instead.
        const mine = msg.mcp_servers.filter((m) => servers.includes(m.name));
        const signedOut = mine.filter((m) => m.status === "needs-auth").map((m) => m.name);
        const failed = mine.filter((m) => m.status === "failed").map((m) => m.name);
        if (signedOut.length || failed.length) abortController.abort();
        if (signedOut.length) throw new NeedsSignIn(signedOut);
        if (failed.length) throw new Error(`${failed.join(" and ")} failed to connect`);
        continue;
      }
      if (msg.type !== "result") continue;
      const costUsd = msg.total_cost_usd ?? 0;
      if (msg.subtype !== "success" || msg.is_error) throw new Error(`Connector agent failed: ${msg.subtype}`);
      return { rows: parseRows(msg.result), costUsd };
    }
    throw new Error("Connector agent returned no result");
  } finally {
    clearTimeout(timer);
  }
}
