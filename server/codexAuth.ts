import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodexCreds =
  | {
      kind: "chatgpt";
      accessToken: string;
      accountId: string;
      planType?: string;
    }
  | {
      kind: "api-key";
      apiKey: string;
    };

export interface CodexCommand {
  command: string;
  args: string[];
}

export const CODEX_CLIENT_VERSION = "0.144.4";

let cached: CodexCreds | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringAt(
  value: unknown,
  ...path: string[]
): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim()
    ? current.trim()
    : undefined;
}

/**
 * Reads the credential created by `codex login`.
 *
 * ChatGPT login stores an OAuth token plus account id in ~/.codex/auth.json.
 * API-key login stores OPENAI_API_KEY in the same file. An explicit environment
 * key remains supported for headless/server installs.
 */
export async function readCodexCreds(): Promise<CodexCreds> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;

  try {
    const raw = await readFile(join(homedir(), ".codex", "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const accessToken = stringAt(parsed, "tokens", "access_token");
    if (accessToken) {
      const claims = decodeJwtPayload(accessToken);
      const authClaims = claims?.["https://api.openai.com/auth"];
      const accountId =
        stringAt(parsed, "tokens", "account_id") ??
        stringAt(authClaims, "chatgpt_account_id");
      if (accountId) {
        cached = {
          kind: "chatgpt",
          accessToken,
          accountId,
          planType: stringAt(authClaims, "chatgpt_plan_type"),
        };
        cachedAt = Date.now();
        return cached;
      }
    }

    const storedApiKey = stringAt(parsed, "OPENAI_API_KEY");
    if (storedApiKey) {
      cached = { kind: "api-key", apiKey: storedApiKey };
      cachedAt = Date.now();
      return cached;
    }
  } catch {
    // Fall through to an explicit environment key.
  }

  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) {
    cached = { kind: "api-key", apiKey: envKey };
    cachedAt = Date.now();
    return cached;
  }

  throw new Error(
    "Codex is not signed in. Run `codex login` (recommended for ChatGPT usage limits), or set OPENAI_API_KEY.",
  );
}

/**
 * Resolves the official Codex CLI bundled in node_modules. Running the JS
 * launcher through the current Node executable works in dev and packaged apps
 * on every supported platform. CODEX_PATH remains available as an override.
 */
export function resolveCodexCommand(): CodexCommand {
  const override = process.env.CODEX_PATH?.trim();
  if (override) return { command: override, args: [] };

  const localLauncher = join(
    process.cwd(),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  if (existsSync(localLauncher)) {
    return { command: process.execPath, args: [localLauncher] };
  }

  return { command: "codex", args: [] };
}

export function codexChatGptHeaders(
  creds: Extract<CodexCreds, { kind: "chatgpt" }>,
): Record<string, string> {
  return {
    Authorization: `Bearer ${creds.accessToken}`,
    "ChatGPT-Account-Id": creds.accountId,
    Accept: "application/json",
    "User-Agent": `codex-cli/${CODEX_CLIENT_VERSION}`,
    originator: "codex_cli_rs",
    version: CODEX_CLIENT_VERSION,
  };
}

/** Invalidate the credential cache (e.g. after the env var is updated). */
export function clearCodexCredsCache(): void {
  cached = null;
  cachedAt = 0;
}
