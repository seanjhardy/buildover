import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface OauthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

// Reads the same OAuth credentials the Claude Code CLI uses. macOS Keychain
// preferred; falls back to ~/.claude/.credentials.json (Linux / override).
// Cached for the process lifetime — these tokens are good for hours and
// re-reading the keychain on every API call is wasteful.
let cached: OauthCreds | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

export async function readCreds(): Promise<OauthCreds> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      const parsed = JSON.parse(stdout.trim());
      if (parsed?.claudeAiOauth) {
        cached = parsed.claudeAiOauth as OauthCreds;
        cachedAt = Date.now();
        return cached;
      }
    } catch {
      // fall through to file
    }
  }

  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const file = join(configDir, ".credentials.json");
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed?.claudeAiOauth?.accessToken) {
    throw new Error(
      "No claudeAiOauth credentials found. Run `claude` once to authenticate.",
    );
  }
  cached = parsed.claudeAiOauth as OauthCreds;
  cachedAt = Date.now();
  return cached;
}
