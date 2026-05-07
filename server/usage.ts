import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

interface OauthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

// Reads OAuth credentials from the same place the Claude Code CLI stores
// them. On macOS the canonical location is the Keychain; we fall back to
// ~/.claude/.credentials.json (used on Linux and as override).
async function readCreds(): Promise<OauthCreds> {
  // Try Keychain first on macOS.
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      const parsed = JSON.parse(stdout.trim());
      if (parsed?.claudeAiOauth) return parsed.claudeAiOauth as OauthCreds;
    } catch {
      // fall through to file
    }
  }

  // Plaintext fallback used on Linux or when CLAUDE_CONFIG_DIR is set.
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const file = join(configDir, ".credentials.json");
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed?.claudeAiOauth?.accessToken) {
    throw new Error(
      "No claudeAiOauth credentials found. Run `claude` once to authenticate.",
    );
  }
  return parsed.claudeAiOauth as OauthCreds;
}

export interface UsageBucket {
  utilization: number; // percentage 0-100
  resetsAt: string | null; // ISO date string
}

export interface UsageReport {
  fiveHour: UsageBucket | null;
  sevenDay: UsageBucket | null;
  sevenDaySonnet: UsageBucket | null;
  sevenDayOpus: UsageBucket | null;
  extraUsage: {
    isEnabled: boolean;
    monthlyLimit: number | null;
    usedCredits: number | null;
    utilization: number | null;
    currency: string | null;
  } | null;
  subscriptionType?: string;
  rateLimitTier?: string;
  fetchedAt: string;
}

function parseBucket(raw: any): UsageBucket | null {
  if (!raw || typeof raw.utilization !== "number") return null;
  return {
    utilization: raw.utilization,
    resetsAt: raw.resets_at ?? null,
  };
}

export async function fetchUsage(): Promise<UsageReport> {
  const creds = await readCreds();
  const res = await fetch(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`usage endpoint ${res.status}: ${body.slice(0, 200)}`);
  }

  const raw = (await res.json()) as Record<string, any>;
  return {
    fiveHour: parseBucket(raw.five_hour),
    sevenDay: parseBucket(raw.seven_day),
    sevenDaySonnet: parseBucket(raw.seven_day_sonnet),
    sevenDayOpus: parseBucket(raw.seven_day_opus),
    extraUsage: raw.extra_usage
      ? {
          isEnabled: Boolean(raw.extra_usage.is_enabled),
          monthlyLimit: raw.extra_usage.monthly_limit ?? null,
          usedCredits: raw.extra_usage.used_credits ?? null,
          utilization: raw.extra_usage.utilization ?? null,
          currency: raw.extra_usage.currency ?? null,
        }
      : null,
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
    fetchedAt: new Date().toISOString(),
  };
}
