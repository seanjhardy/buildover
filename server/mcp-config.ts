/**
 * Reads and writes the user-managed MCP server list from mcp-servers.json
 * in the project root.  This file is read on every agent turn so changes
 * take effect immediately without a server restart.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { InstalledMcpServer } from "../src/types.js";

const CONFIG_PATH = join(process.cwd(), "mcp-servers.json");

export function readInstalledServers(): InstalledMcpServer[] {
  try {
    if (!existsSync(CONFIG_PATH)) return [];
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as InstalledMcpServer[];
  } catch {
    return [];
  }
}

export function writeInstalledServers(servers: InstalledMcpServer[]): void {
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
