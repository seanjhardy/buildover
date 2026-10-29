import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
//
// Keyed by configDir so multiple Claude accounts (each with its own
// CLAUDE_CONFIG_DIR) can be cached independently in the same process. `""` is
// the key for the default/primary account (no override).
interface CacheEntry {
  creds: OauthCreds;
  cachedAt: number;
}
const cacheByDir = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;
const EXPIRY_SKEW_MS = 30_000;

function dirKey(configDir?: string): string {
  return configDir ?? "";
}

export function clearCredsCache(configDir?: string): void {
  if (configDir === undefined) {
    cacheByDir.clear();
    return;
  }
  cacheByDir.delete(dirKey(configDir));
}

// The CLI computes the macOS Keychain service name for a custom
// CLAUDE_CONFIG_DIR as `Claude Code-credentials-<sha256(configDir)[:8]>`
// (verified by decompiling the bundled CLI and cross-checking against the
// Keychain entry it actually wrote). The default/unset config dir uses the
// bare "Claude Code-credentials" service name, which is what the existing
// single-account code already assumed.
function keychainServiceFor(configDir?: string): string {
  if (!configDir) return KEYCHAIN_SERVICE;
  const hash = createHash("sha256")
    .update(configDir.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${hash}`;
}

export async function readCreds(
  forceRefresh = false,
  configDir?: string,
): Promise<OauthCreds> {
  const key = dirKey(configDir);
  const cached = cacheByDir.get(key);
  const cachedIsUsable =
    cached &&
    Date.now() - cached.cachedAt < CACHE_TTL_MS &&
    (!cached.creds.expiresAt || cached.creds.expiresAt > Date.now() + EXPIRY_SKEW_MS);
  if (!forceRefresh && cachedIsUsable) return cached!.creds;

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        keychainServiceFor(configDir),
        "-w",
      ]);
      const parsed = JSON.parse(stdout.trim());
      if (parsed?.claudeAiOauth) {
        const creds = parsed.claudeAiOauth as OauthCreds;
        cacheByDir.set(key, { creds, cachedAt: Date.now() });
        return creds;
      }
    } catch {
      // fall through to file
    }
  }

  const resolvedDir =
    configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const file = join(resolvedDir, ".credentials.json");
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed?.claudeAiOauth?.accessToken) {
    throw new Error(
      "No claudeAiOauth credentials found. Run `claude` once to authenticate.",
    );
  }
  const creds = parsed.claudeAiOauth as OauthCreds;
  cacheByDir.set(key, { creds, cachedAt: Date.now() });
  return creds;
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
  configDir?: string,
): Promise<Response> {
  const request = (accessToken: string) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(input, { ...init, headers });
  };

  const initial = await readCreds(false, configDir);
  const response = await request(initial.accessToken);
  if (response.status !== 401) return response;

  let refreshed = await readCreds(true, configDir);
  if (refreshed.accessToken === initial.accessToken) {
    // Nobody has refreshed the expired token yet (Claude Code only does so when
    // it next makes a request), which used to surface as "sign in again" while
    // the CLI still reported a valid login. Let the CLI refresh it.
    await refreshTokenViaCli(configDir);
    refreshed = await readCreds(true, configDir);
    if (refreshed.accessToken === initial.accessToken) return response;
  }

  await response.body?.cancel().catch(() => {});
  return request(refreshed.accessToken);
}

const cliRefreshByDir = new Map<string, Promise<void>>();
const cliRefreshAtByDir = new Map<string, number>();
/** A refresh that failed (e.g. the refresh token was revoked) isn't retried sooner. */
const CLI_REFRESH_COOLDOWN_MS = 5 * 60_000;

/**
 * Starts the bundled Claude CLI just long enough to make one authenticated
 * request (its /usage control request, which spends no model tokens). The CLI
 * refreshes an expired OAuth token with its own locking and writes it back to
 * Keychain, so Buildover never rotates the refresh token itself.
 */
function refreshTokenViaCli(configDir?: string): Promise<void> {
  const key = dirKey(configDir);
  const pending = cliRefreshByDir.get(key);
  if (pending) return pending;
  if (Date.now() - (cliRefreshAtByDir.get(key) ?? 0) < CLI_REFRESH_COOLDOWN_MS) {
    return Promise.resolve();
  }
  cliRefreshAtByDir.set(key, Date.now());
  const run = (async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let release!: () => void;
    const idle = new Promise<void>((resolve) => (release = resolve));
    async function* noPrompt() {
      await idle;
    }
    const q = query({
      prompt: noPrompt(),
      options: {
        cwd: homedir(),
        settingSources: [],
        ...(configDir ? { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } } : {}),
      },
    });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 15_000).unref());
    try {
      await Promise.race([
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET().then(() => {}),
        timeout,
      ]);
    } catch (err) {
      console.warn("[claude-auth] CLI token refresh failed:", err);
    } finally {
      release();
      q.close();
    }
  })().finally(() => cliRefreshByDir.delete(key));
  cliRefreshByDir.set(key, run);
  return run;
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
