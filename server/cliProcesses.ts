import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

// Claude CLI processes the agent SDK spawns don't die with the server. When the
// server is restarted they are reparented to launchd and carry on with the
// turn they were running, unseen: still using quota, still editing files. These
// helpers find them by their binary, which lives in this install's
// node_modules, so CLIs belonging to anything else are never touched.

function cliPathPrefix(): string | null {
  try {
    // Not import.meta.url: the production server is bundled as CommonJS.
    const require = createRequire(join(process.cwd(), "package.json"));
    const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const at = entry.lastIndexOf("/@anthropic-ai/");
    // Covers the SDK's native binary packages (claude-agent-sdk-darwin-arm64/claude, …).
    return at === -1 ? null : entry.slice(0, at) + "/@anthropic-ai/claude-agent-sdk";
  } catch {
    return null;
  }
}

function findCliProcesses(match: (ppid: number) => boolean): number[] {
  const prefix = cliPathPrefix();
  if (!prefix) return [];
  let out: string;
  try {
    out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[3].startsWith(prefix) || !match(Number(m[2]))) continue;
    pids.push(Number(m[1]));
  }
  return pids;
}

function killAll(pids: number[]): void {
  for (const pid of pids) {
    try {
      // A CLI mid-tool ignores SIGTERM until the tool finishes.
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

// Synchronous so it can run from an `exit` handler.
export function killChildCliProcesses(): void {
  killAll(findCliProcesses((ppid) => ppid === process.pid));
}

// CLIs left behind by a previous server that died without cleaning up (crash,
// SIGKILL). Their turns were already marked as interrupted on startup.
export function reapOrphanedCliProcesses(): number {
  const pids = findCliProcesses((ppid) => ppid === 1);
  killAll(pids);
  return pids.length;
}
