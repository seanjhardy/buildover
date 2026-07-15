/**
 * Fetches Cursor subscription usage from the same endpoints the Cursor app /
 * dashboard use, authenticated with the local IDE session token.
 */
import { readCursorCreds } from "./cursorAuth.js";

export interface CursorUsageBucket {
  utilization: number;
  resetsAt: string | null;
  /** Human-readable spend figures when available (cents → dollars). */
  label?: string;
}

export interface CursorUsageReport {
  /** Total included-plan usage (API + first-party pools combined). */
  total: CursorUsageBucket | null;
  /** Auto / Composer / Grok first-party pool. */
  auto: CursorUsageBucket | null;
  /** Named third-party / API model pool. */
  api: CursorUsageBucket | null;
  planUsage?: {
    totalSpendCents: number;
    includedSpendCents: number;
    bonusSpendCents: number;
    limitCents: number;
  };
  membershipType?: string;
  displayMessage?: string;
  autoMessage?: string;
  apiMessage?: string;
  billingCycleStart?: string;
  billingCycleEnd?: string;
  fetchedAt: string;
}

export interface CursorUsageLimitBlock {
  message: string;
  resetsAt: string | null;
}

interface PeriodUsageResponse {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  planUsage?: {
    totalSpend?: number;
    includedSpend?: number;
    bonusSpend?: number;
    limit?: number;
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    totalPercentUsed?: number;
  };
  enabled?: boolean;
  displayMessage?: string;
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
}

function msToIso(ms: string | number | undefined): string | null {
  if (ms == null || ms === "") return null;
  const n = typeof ms === "string" ? Number(ms) : ms;
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

function dollars(cents: number | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

async function fetchPeriodUsage(): Promise<PeriodUsageResponse> {
  const creds = await readCursorCreds();

  // Preferred: Connect-RPC style endpoint used by the Cursor IDE status bar.
  const api2 = await fetch(
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "User-Agent": "buildover",
      },
      body: "{}",
    },
  );
  if (api2.ok) {
    return (await api2.json()) as PeriodUsageResponse;
  }

  // Fallback: dashboard cookie auth (same session JWT).
  if (creds.sub) {
    const dash = await fetch(
      "https://cursor.com/api/dashboard/get-current-period-usage",
      {
        method: "POST",
        headers: {
          Cookie: `WorkosCursorSessionToken=${creds.sub}::${creds.token}`,
          Origin: "https://cursor.com",
          "Content-Type": "application/json",
          "User-Agent": "buildover",
        },
        body: "{}",
      },
    );
    if (dash.ok) {
      return (await dash.json()) as PeriodUsageResponse;
    }
    const body = await dash.text().catch(() => "");
    throw new Error(`cursor usage ${dash.status}: ${body.slice(0, 200)}`);
  }

  const body = await api2.text().catch(() => "");
  throw new Error(`cursor usage ${api2.status}: ${body.slice(0, 200)}`);
}

export async function fetchCursorUsage(): Promise<CursorUsageReport> {
  const creds = await readCursorCreds();
  const raw = await fetchPeriodUsage();
  const plan = raw.planUsage;
  const resetsAt = msToIso(raw.billingCycleEnd);

  const totalPct = plan?.totalPercentUsed ?? null;
  const autoPct = plan?.autoPercentUsed ?? null;
  const apiPct = plan?.apiPercentUsed ?? null;

  return {
    total:
      totalPct != null
        ? {
            utilization: totalPct,
            resetsAt,
            label: `${dollars(plan?.totalSpend)} / ${dollars(plan?.limit)}`,
          }
        : null,
    auto:
      autoPct != null
        ? { utilization: autoPct, resetsAt, label: raw.autoModelSelectedDisplayMessage }
        : null,
    api:
      apiPct != null
        ? { utilization: apiPct, resetsAt, label: raw.namedModelSelectedDisplayMessage }
        : null,
    planUsage: plan
      ? {
          totalSpendCents: plan.totalSpend ?? 0,
          includedSpendCents: plan.includedSpend ?? 0,
          bonusSpendCents: plan.bonusSpend ?? 0,
          limitCents: plan.limit ?? 0,
        }
      : undefined,
    membershipType: creds.membershipType,
    displayMessage: raw.displayMessage,
    autoMessage: raw.autoModelSelectedDisplayMessage,
    apiMessage: raw.namedModelSelectedDisplayMessage,
    billingCycleStart: msToIso(raw.billingCycleStart) ?? undefined,
    billingCycleEnd: resetsAt ?? undefined,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Cursor plans often allow on-demand overage; we only hard-block when the
 * dashboard marks the account as at limit AND total utilization is ≥ 100 with
 * no remaining included/bonus spend signal. Conservative: don't queue Cursor
 * turns unless totalPercentUsed ≥ 100 AND displayMessage indicates a hard stop
 * without on-demand. For now, treat ≥ 100% total as blocked (matches Claude UX);
 * users with on-demand can still run — Cursor will bill — so only block when
 * enabled===false isn't the case... Looking at the probe response:
 * displayMessage: "You've hit your usage limit" with totalPercentUsed ~20.
 * So displayMessage alone is NOT a hard block. Rely on totalPercentUsed >= 100.
 */
export async function getCursorUsageLimitBlock(): Promise<CursorUsageLimitBlock | null> {
  try {
    const usage = await fetchCursorUsage();
    if (usage.total && usage.total.utilization >= 100) {
      return {
        message:
          "Cursor usage limit reached. Agent execution is deferred until the billing cycle resets, or enable on-demand usage in the Cursor dashboard.",
        resetsAt: usage.total.resetsAt,
      };
    }
    return null;
  } catch (err) {
    console.warn("[cursorUsage] Failed to check usage limit:", err);
    return null;
  }
}

export async function isCursorAvailable(): Promise<boolean> {
  try {
    await readCursorCreds();
    return true;
  } catch {
    return false;
  }
}
