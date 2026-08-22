/**
 * Reads and writes the user-managed MCP server list from
 * ~/.buildover/mcp-servers.json.  Stored globally (not per-repo) so installed
 * servers are available in every repo, independent of the server process's
 * launch directory.  Read on every agent turn so changes take effect
 * immediately without a server restart.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { InstalledMcpServer } from "../src/types.js";

const BUILDOVER_HOME = join(homedir(), ".buildover");
const CONFIG_PATH = join(BUILDOVER_HOME, "mcp-servers.json");
// Old per-repo location (server launch dir). Migrated into the global file on
// first read so servers installed before the move aren't lost.
const LEGACY_PATH = join(process.cwd(), "mcp-servers.json");

export function readInstalledServers(): InstalledMcpServer[] {
  try {
    if (!existsSync(CONFIG_PATH)) {
      if (existsSync(LEGACY_PATH)) {
        const legacy = JSON.parse(
          readFileSync(LEGACY_PATH, "utf8")
        ) as InstalledMcpServer[];
        writeInstalledServers(legacy);
        return legacy;
      }
      return [];
    }
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as InstalledMcpServer[];
  } catch {
    return [];
  }
}

export function writeInstalledServers(servers: InstalledMcpServer[]): void {
  mkdirSync(BUILDOVER_HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(servers, null, 2), "utf8");
}

/**
 * Converts our stored config shape into the object the Claude Agent SDK
 * expects in the `mcpServers` option of `query()`.
 */
export function toSdkMcpConfig(servers: InstalledMcpServer[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const s of servers) {
    if (s.type === "stdio") {
      if (!s.command) continue;
      result[s.id] = {
        type: "stdio",
        command: s.command,
        args: s.args ?? [],
        ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
      };
    } else if (s.type === "sse" || s.type === "http") {
      if (!s.url) continue;
      result[s.id] = {
        type: s.type,
        url: s.url,
        ...(s.headers && Object.keys(s.headers).length > 0
          ? { headers: s.headers }
          : {}),
      };
    }
  }
  return result;
}
