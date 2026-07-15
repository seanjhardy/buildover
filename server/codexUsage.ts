import {
  codexChatGptHeaders,
  readCodexCreds,
} from "./codexAuth.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export interface CodexUsageBucket {
  utilization: number;
  resetsAt: string | null;
  windowSeconds?: number;
}

export interface CodexUsageReport {
  connected: boolean;
  authMode: "chatgpt" | "api-key" | "none";
  planType?: string;
  primary: CodexUsageBucket | null;
  secondary: CodexUsageBucket | null;
  codeReviewPrimary: CodexUsageBucket | null;
  codeReviewSecondary: CodexUsageBucket | null;
  additional: Array<{
    id: string;
    label: string;
    primary: CodexUsageBucket | null;
    secondary: CodexUsageBucket | null;
  }>;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  resetCreditsAvailable?: number;
  quotaExceeded: boolean;
  error?: string;
  note?: string;
  fetchedAt: string;
}

export interface CodexUsageLimitBlock {
  message: string;
  resetsAt: string | null;
}

interface RawWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
}

interface RawLimit {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: RawWindow | null;
  secondary_window?: RawWindow | null;
}

interface RawUsage {
  plan_type?: string;
  rate_limit?: RawLimit | null;
  code_review_rate_limit?: RawLimit | null;
  additional_rate_limits?: Array<{
    limit_name?: string;
    metered_feature?: string;
    rate_limit?: RawLimit | null;
  }> | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string | null;
  } | null;
  spend_control?: { reached?: boolean } | null;
  rate_limit_reached_type?: unknown;
  rate_limit_reset_credits?: { available_count?: number } | null;
}

function parseWindow(raw: RawWindow | null | undefined): CodexUsageBucket | null {
  if (!raw || typeof raw.used_percent !== "number") return null;
  return {
    utilization: raw.used_percent,
    resetsAt:
      typeof raw.reset_at === "number" && raw.reset_at > 0
        ? new Date(raw.reset_at * 1000).toISOString()
        : null,
    windowSeconds:
      typeof raw.limit_window_seconds === "number"
        ? raw.limit_window_seconds
        : undefined,
  };
}

function emptyReport(
  fetchedAt: string,
  overrides: Partial<CodexUsageReport>,
): CodexUsageReport {
  return {
    connected: false,
    authMode: "none",
    primary: null,
    secondary: null,
    codeReviewPrimary: null,
    codeReviewSecondary: null,
    additional: [],
    credits: null,
    quotaExceeded: false,
    fetchedAt,
    ...overrides,
  };
}

function isLimitReached(limit: RawLimit | null | undefined): boolean {
  return (
    limit?.limit_reached === true ||
    limit?.allowed === false ||
    (limit?.primary_window?.used_percent ?? 0) >= 100 ||
    (limit?.secondary_window?.used_percent ?? 0) >= 100
  );
}

export async function fetchCodexUsage(): Promise<CodexUsageReport> {
  const fetchedAt = new Date().toISOString();
  let creds;
  try {
    creds = await readCodexCreds();
  } catch (err) {
    return emptyReport(fetchedAt, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (creds.kind === "api-key") {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return emptyReport(fetchedAt, {
        authMode: "api-key",
        error: `OpenAI API ${response.status}: ${body.slice(0, 180)}`,
      });
    }
    return emptyReport(fetchedAt, {
      connected: true,
      authMode: "api-key",
      note:
        "API-key usage is billed per token; OpenAI does not expose ChatGPT-style usage windows for API keys.",
    });
  }

  const response = await fetch(CODEX_USAGE_URL, {
    headers: codexChatGptHeaders(creds),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return emptyReport(fetchedAt, {
      authMode: "chatgpt",
      planType: creds.planType,
      error:
        response.status === 401
          ? "Codex login expired. Run `codex login` again."
          : `Codex usage ${response.status}: ${body.slice(0, 180)}`,
    });
  }

  const raw = (await response.json()) as RawUsage;
  const additional = (raw.additional_rate_limits ?? []).map((entry, index) => ({
    id: entry.limit_name ?? entry.metered_feature ?? `additional-${index}`,
    label: entry.limit_name ?? entry.metered_feature ?? "Additional",
    primary: parseWindow(entry.rate_limit?.primary_window),
    secondary: parseWindow(entry.rate_limit?.secondary_window),
  }));
  const quotaExceeded =
    isLimitReached(raw.rate_limit) ||
    raw.spend_control?.reached === true ||
    raw.rate_limit_reached_type != null;

  return {
    connected: true,
    authMode: "chatgpt",
    planType: raw.plan_type ?? creds.planType,
    primary: parseWindow(raw.rate_limit?.primary_window),
    secondary: parseWindow(raw.rate_limit?.secondary_window),
    codeReviewPrimary: parseWindow(raw.code_review_rate_limit?.primary_window),
    codeReviewSecondary: parseWindow(raw.code_review_rate_limit?.secondary_window),
    additional,
    credits: raw.credits
      ? {
          hasCredits: Boolean(raw.credits.has_credits),
          unlimited: Boolean(raw.credits.unlimited),
          balance: raw.credits.balance ?? null,
        }
      : null,
    resetCreditsAvailable: raw.rate_limit_reset_credits?.available_count,
    quotaExceeded,
    fetchedAt,
  };
}

/** Backward-compatible name used by the existing HTTP route. */
export const fetchCodexStatus = fetchCodexUsage;

export async function getCodexUsageLimitBlock(): Promise<CodexUsageLimitBlock | null> {
  try {
    const usage = await fetchCodexUsage();
    if (!usage.connected || !usage.quotaExceeded) return null;
    const full = [
      usage.primary,
      usage.secondary,
    ].filter(
      (bucket): bucket is CodexUsageBucket =>
        bucket != null && bucket.utilization >= 100,
    );
    full.sort((a, b) => {
      if (!a.resetsAt) return 1;
      if (!b.resetsAt) return -1;
      return Date.parse(a.resetsAt) - Date.parse(b.resetsAt);
    });
    return {
      message:
        "Codex usage limit reached. Agent execution is deferred until the limit resets.",
      resetsAt: full[0]?.resetsAt ?? null,
    };
  } catch (err) {
    console.warn("[codexUsage] Failed to check usage limit:", err);
    return null;
  }
}

export async function isCodexAvailable(): Promise<boolean> {
  const usage = await fetchCodexUsage();
  return usage.connected && !usage.quotaExceeded;
}
