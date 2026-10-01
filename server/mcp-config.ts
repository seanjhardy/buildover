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
import type { InstalledMcpServer, McpServerInfo } from "../src/types.js";

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

/**
 * The `system_init` event carries the list of configured MCP servers so the
 * Tools & MCP panel can render them. The Claude SDK reports real connection
 * status; for the cursor / codex backends we only know a server is configured,
 * so report it as connected for visibility.
 */
export function installedMcpServerInfos(
  servers: InstalledMcpServer[],
): McpServerInfo[] {
  return servers.map((s) => ({ name: s.id, status: "connected" }));
}

/**
 * Single cursor mcp.json entry. Cursor uses the same shape as most MCP clients:
 * stdio servers carry command/args/env, remote servers carry url/headers.
 */
function toCursorMcpEntry(s: InstalledMcpServer): Record<string, unknown> | null {
  if (s.type === "stdio") {
    if (!s.command) return null;
    return {
      command: s.command,
      args: s.args ?? [],
      ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
    };
  }
  if (s.type === "sse" || s.type === "http") {
    if (!s.url) return null;
    return {
      url: s.url,
      ...(s.headers && Object.keys(s.headers).length > 0
        ? { headers: s.headers }
        : {}),
    };
  }
  return null;
}

/**
 * cursor-agent has no flag to pass MCP servers inline — it only reads
 * ~/.cursor/mcp.json (global) and <workspace>/.cursor/mcp.json (project). To
 * make Buildover's installed servers available to cursor turns we upsert them
 * into the global file, non-destructively: existing entries (including servers
 * the user added directly in the Cursor IDE) are preserved, and only ids we
 * manage are added or refreshed. Uninstalling a server in Buildover leaves its
 * cursor entry in place — a deliberate trade-off to avoid clobbering the user's
 * own entries, since the two sources are indistinguishable once merged.
 */
export function syncCursorGlobalMcpServers(servers: InstalledMcpServer[]): void {
  if (servers.length === 0) return;
  const cursorHome = join(homedir(), ".cursor");
  const path = join(cursorHome, "mcp.json");

  let existing: { mcpServers?: Record<string, unknown> } & Record<string, unknown> =
    {};
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8").trim();
      if (raw) existing = JSON.parse(raw);
    }
  } catch {
    // A malformed file shouldn't block the turn; start from an empty object.
    existing = {};
  }

  const mcpServers: Record<string, unknown> = { ...(existing.mcpServers ?? {}) };
  for (const s of servers) {
    const entry = toCursorMcpEntry(s);
    if (entry) mcpServers[s.id] = entry;
  }
  existing.mcpServers = mcpServers;

  mkdirSync(cursorHome, { recursive: true });
  writeFileSync(path, JSON.stringify(existing, null, 2), "utf8");
}

/** Serialise a JS value as a TOML scalar/array for a codex `-c` override. */
function toToml(value: string | string[]): string {
  const str = (v: string) =>
    `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return Array.isArray(value) ? `[${value.map(str).join(",")}]` : str(value);
}

/** Codex dotted-path keys must be bare TOML keys ([A-Za-z0-9_-]). */
function codexKey(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Codex has no `mcpServers` option in its app-server protocol, but it loads
 * `mcp_servers.*` from config, and every invocation accepts `-c key=value`
 * overrides whose value is parsed as TOML. Build one override per field so the
 * installed servers are registered for the spawned app-server without writing
 * to the user's ~/.codex/config.toml.
 *
 * Note: remote (http/sse) servers that require OAuth won't authenticate in the
 * non-interactive app-server; the user must `codex mcp login <id>` once first.
 */
export function toCodexConfigArgs(servers: InstalledMcpServer[]): string[] {
  const args: string[] = [];
  const push = (expr: string) => args.push("-c", expr);
  for (const s of servers) {
    const key = codexKey(s.id);
    if (s.type === "stdio") {
      if (!s.command) continue;
      push(`mcp_servers.${key}.command=${toToml(s.command)}`);
      if (s.args?.length) push(`mcp_servers.${key}.args=${toToml(s.args)}`);
      for (const [envKey, envVal] of Object.entries(s.env ?? {})) {
        push(`mcp_servers.${key}.env.${codexKey(envKey)}=${toToml(envVal)}`);
      }
    } else if (s.type === "sse" || s.type === "http") {
      if (!s.url) continue;
      push(`mcp_servers.${key}.url=${toToml(s.url)}`);
    }
  }
  return args;
}
