/**
 * Reads the Cursor IDE session token used for usage / models / cursor-agent.
 *
 * Resolution order:
 *  1. CURSOR_AUTH_TOKEN or CURSOR_API_KEY env vars
 *  2. Cursor IDE SQLite state DB (`cursorAuth/accessToken`)
 *  3. macOS Keychain service `cursor-access-token` (cursor-agent CLI)
 *
 * The IDE session JWT authenticates dashboard usage APIs and the local
 * `cursor-agent` CLI. A User API key (`key_…` / `crsr_…`) also works for the
 * CLI when set via CURSOR_API_KEY.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";

const execFileAsync = promisify(execFile);

export interface CursorCreds {
  /** Session JWT or user API key — pass to cursor-agent as CURSOR_AUTH_TOKEN / CURSOR_API_KEY. */
  token: string;
  /** JWT `sub` claim when the token is a session JWT; used for cookie-style dashboard auth. */
  sub?: string;
  email?: string;
  membershipType?: string;
  source: "env" | "state.vscdb" | "keychain";
}

let cached: CursorCreds | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const pad = "=".repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(parts[1] + pad, "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stateDbPath(): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData/Roaming");
    return join(appData, "Cursor/User/globalStorage/state.vscdb");
  }
  return join(home, ".config/Cursor/User/globalStorage/state.vscdb");
}

function readFromStateDb(): CursorCreds | null {
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get("cursorAuth/accessToken") as { value: string } | undefined;
      if (!row?.value) return null;
      const token = row.value.trim();
      if (!token) return null;

      const emailRow = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get("cursorAuth/cachedEmail") as { value: string } | undefined;
      const membershipRow = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get("cursorAuth/stripeMembershipType") as { value: string } | undefined;

      const payload = decodeJwtPayload(token);
      const rawSub = typeof payload?.sub === "string" ? payload.sub : undefined;
      // Cookie auth wants `user_01…`, not `google-oauth2|user_01…`.
      const sub = rawSub?.includes("|") ? rawSub.split("|").pop() : rawSub;

      return {
        token,
        sub,
        email: emailRow?.value,
        membershipType: membershipRow?.value,
        source: "state.vscdb",
      };
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[cursorAuth] failed to read state.vscdb:", err);
    return null;
  }
}

async function readFromKeychain(): Promise<CursorCreds | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      "cursor-access-token",
      "-w",
    ]);
    const token = stdout.trim();
    if (!token) return null;
    const payload = decodeJwtPayload(token);
    const rawSub = typeof payload?.sub === "string" ? payload.sub : undefined;
    const sub = rawSub?.includes("|") ? rawSub.split("|").pop() : rawSub;
    return { token, sub, source: "keychain" };
  } catch {
    return null;
  }
}

export async function readCursorCreds(): Promise<CursorCreds> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;

  const fromDb = readFromStateDb();

  const envToken =
    process.env.CURSOR_AUTH_TOKEN?.trim() ||
    process.env.CURSOR_API_KEY?.trim();
  if (envToken) {
    const payload = decodeJwtPayload(envToken);
    const rawSub = typeof payload?.sub === "string" ? payload.sub : undefined;
    const sub =
      (rawSub?.includes("|") ? rawSub.split("|").pop() : rawSub) || fromDb?.sub;
    cached = {
      token: envToken,
      sub,
      email: fromDb?.email,
      membershipType: fromDb?.membershipType,
      source: "env",
    };
    cachedAt = Date.now();
    return cached;
  }

  if (fromDb) {
    cached = fromDb;
    cachedAt = Date.now();
    return cached;
  }

  const fromKeychain = await readFromKeychain();
  if (fromKeychain) {
    cached = fromKeychain;
    cachedAt = Date.now();
    return cached;
  }

  throw new Error(
    "No Cursor credentials found. Sign in to the Cursor app, or set CURSOR_AUTH_TOKEN / CURSOR_API_KEY.",
  );
}

export function clearCursorCredsCache(): void {
  cached = null;
  cachedAt = 0;
}

/** Resolve the local `cursor-agent` binary shipped with the Cursor IDE. */
export function resolveCursorAgentBinary(): string | null {
  const home = homedir();
  const candidates: string[] = [];

  if (process.env.CURSOR_AGENT_PATH) {
    candidates.push(process.env.CURSOR_AGENT_PATH);
  }

  if (process.platform === "darwin") {
    const base = join(
      home,
      "Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-agent-worker/agent-cli",
    );
    candidates.push(join(base, ".local/bin/cursor-agent"));
    const versionsDir = join(base, ".local/share/cursor-agent/versions");
    if (existsSync(versionsDir)) {
      try {
        const versions = readdirSync(versionsDir)
          .filter((n) => !n.startsWith("."))
          .sort()
          .reverse();
        for (const v of versions) {
          candidates.push(join(versionsDir, v, "cursor-agent"));
        }
      } catch {
        /* ignore */
      }
    }
  }

  candidates.push(
    join(home, ".local/bin/cursor-agent"),
    join(home, ".cursor/bin/cursor-agent"),
    "cursor-agent",
  );

  for (const c of candidates) {
    if (c === "cursor-agent") return c; // PATH lookup — let spawn decide
    if (existsSync(c)) return c;
  }
  return null;
}
