import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// Service names to try when looking for Codex/OpenAI credentials in the macOS Keychain.
const KEYCHAIN_SERVICES = ["Codex Credentials", "openai-credentials", "codex"];

export interface CodexCreds {
  apiKey: string;
}

let cached: CodexCreds | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

/**
 * Reads the OpenAI API key used by the Codex CLI. Resolution order:
 *  1. OPENAI_API_KEY environment variable (managed via the Settings UI)
 *  2. macOS Keychain (several known service names the Codex CLI uses)
 *  3. ~/.codex/config.json  → apiKey / api_key / openai_api_key
 *  4. ~/.codex/auth.json    → same fields
 *  5. ~/.openai/auth.json   → same fields
 *
 * Cached for 60 seconds — same strategy as anthropicAuth.ts.
 */
export async function readCodexCreds(): Promise<CodexCreds> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;

  // 1. Env var (highest priority — set via Settings → Env Vars UI)
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey && envKey.trim()) {
    cached = { apiKey: envKey.trim() };
    cachedAt = Date.now();
    return cached;
  }

  // 2. macOS Keychain
  if (process.platform === "darwin") {
    for (const service of KEYCHAIN_SERVICES) {
      try {
        const { stdout } = await execFileAsync("security", [
          "find-generic-password",
          "-s",
          service,
          "-w",
        ]);
        const key = stdout.trim();
        if (key && key.startsWith("sk-")) {
          cached = { apiKey: key };
          cachedAt = Date.now();
          return cached;
        }
      } catch {
        // try next service
      }
    }
  }

  // 3–5. Config / auth files
  const home = homedir();
  const filesToTry = [
    join(home, ".codex", "config.json"),
    join(home, ".codex", "auth.json"),
    join(home, ".openai", "auth.json"),
    join(home, ".config", "codex", "config.json"),
  ];

  for (const filePath of filesToTry) {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const key =
        parsed?.apiKey ??
        parsed?.api_key ??
        parsed?.openai_api_key ??
        parsed?.OPENAI_API_KEY;
      if (key && typeof key === "string" && key.trim()) {
        cached = { apiKey: key.trim() };
        cachedAt = Date.now();
        return cached;
      }
    } catch {
      // try next file
    }
  }

  throw new Error(
    "No OpenAI API key found. Set OPENAI_API_KEY via Settings → Env Vars, or run `codex login`.",
  );
}

/** Invalidate the credential cache (e.g. after the env var is updated). */
export function clearCodexCredsCache(): void {
  cached = null;
  cachedAt = 0;
}
