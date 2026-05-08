import { readCreds } from "./anthropicAuth.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

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
