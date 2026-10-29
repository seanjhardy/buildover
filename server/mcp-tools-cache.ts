/**
 * mcp-tools-cache.ts — Remembers the tool list reported by the SDK's
 * `system_init` so the Tools & MCP panel can show what *will* be available
 * before a chat has actually started (at which point the live list is empty).
 *
 * This is a best-effort preview: the real tool set can vary per repo (project
 * .mcp.json, settings), so we store the most recent non-empty snapshot
 * globally to ~/.buildover/mcp-tools-cache.json and merge it with the
 * statically-configured server list when answering a preview request.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerInfo } from "../src/types.js";

const BUILDOVER_DIR = join(homedir(), ".buildover");
const CACHE_FILE = join(BUILDOVER_DIR, "mcp-tools-cache.json");

export interface ToolsCache {
  tools: string[];
  mcpServers: McpServerInfo[];
  updatedAt: string;
}

const EMPTY: ToolsCache = { tools: [], mcpServers: [], updatedAt: "" };

export function readToolsCache(): ToolsCache {
  try {
    const raw = readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as ToolsCache;
    return {
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
      updatedAt: parsed.updatedAt ?? "",
    };
  } catch {
    return EMPTY;
  }
}

let lastSerialized = "";

/** Persist the latest init snapshot. No-ops on empty tool lists (a failed or
 *  not-yet-ready session) and when nothing changed since the last write. */
export async function updateToolsCache(
  tools: string[],
  mcpServers: McpServerInfo[],
): Promise<void> {
  if (!Array.isArray(tools) || tools.length === 0) return;
  const next: ToolsCache = {
    tools,
    mcpServers: Array.isArray(mcpServers) ? mcpServers : [],
    updatedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify({ tools: next.tools, mcpServers: next.mcpServers });
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;
  try {
    await mkdir(BUILDOVER_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await rename(tmp, CACHE_FILE);
  } catch {
    // Caching is best-effort; a write failure must never break a turn.
  }
}
