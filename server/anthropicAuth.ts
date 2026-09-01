import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
// Cache briefly to avoid repeatedly prompting macOS Keychain. Never serve a
// token at (or very near) its expiry, and expose an explicit invalidation hook
// for a completed login or an HTTP 401 retry.
let cached: OauthCreds | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;
const EXPIRY_SKEW_MS = 30_000;

export function clearCredsCache(): void {
  cached = null;
  cachedAt = 0;
}

export async function readCreds(forceRefresh = false): Promise<OauthCreds> {
  const cachedIsUsable =
    cached &&
    Date.now() - cachedAt < CACHE_TTL_MS &&
    (!cached.expiresAt || cached.expiresAt > Date.now() + EXPIRY_SKEW_MS);
  if (!forceRefresh && cachedIsUsable) return cached!;

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

/**
 * Fetch with the current Claude OAuth token. If a different token has appeared
 * in Keychain after an HTTP 401 (normally because Claude Code refreshed it in
 * another process), retry once immediately instead of looking logged out for
 * up to the credential-cache TTL.
 */
export async function fetchWithClaudeAuth(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const request = (accessToken: string) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(input, { ...init, headers });
  };

  const initial = await readCreds();
  const response = await request(initial.accessToken);
  if (response.status !== 401) return response;

  const refreshed = await readCreds(true);
  if (refreshed.accessToken === initial.accessToken) return response;

  await response.body?.cancel().catch(() => {});
  return request(refreshed.accessToken);
}

/** Resolve the native Claude CLI shipped with the Agent SDK. */
export function resolveClaudeCli(): string {
  const platform = process.platform;
  const arch = process.arch;
  const suffix = platform === "win32" ? ".exe" : "";
  const packageNames = [
    `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
    ...(platform === "linux"
      ? [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}-musl`]
      : []),
  ];
  // The production server is bundled as CommonJS, where import.meta.url is
  // unavailable. Electron and the dev server both set cwd to the app root.
  const require = createRequire(join(process.cwd(), "package.json"));

  for (const packageName of packageNames) {
    try {
      const packageJson = require.resolve(`${packageName}/package.json`);
      return join(dirname(packageJson), `claude${suffix}`);
    } catch {
      // Try the next platform package, then fall back to a CLI on PATH.
    }
  }

  return process.platform === "win32" ? "claude.exe" : "claude";
}
