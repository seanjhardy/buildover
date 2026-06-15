import { readCodexCreds } from "./codexAuth.js";

export interface CodexStatus {
  /** Whether the API key is valid and the API responds successfully. */
  connected: boolean;
  /** Human-readable error message if !connected or quota exceeded. */
  error?: string;
  /**
   * Credit balance in USD (prepaid accounts). null if unavailable from billing API.
   */
  creditBalance?: number;
  creditCurrency?: string;
  /**
   * 0-100: how much of the credit grant has been used. Undefined if we can't
   * determine limits (API key accounts without explicit limits).
   */
  utilization?: number;
  /** Whether quota appears to be fully exhausted (utilization === 100 or HTTP 402/429). */
  quotaExceeded: boolean;
  /** ISO timestamp of when this status was fetched. */
  fetchedAt: string;
}

/**
 * Attempts to determine OpenAI/Codex usage status.
 *
 * Strategy:
 *  1. Try the credit_grants billing endpoint (prepaid accounts).
 *  2. Fall back to the subscription endpoint (soft/hard limits).
 *  3. Fall back to just listing models to confirm the key is valid.
 *
 * The billing endpoints may return 404 for API-key-only accounts without an
 * explicit credit system — that's fine, we just report "connected".
 */
export async function fetchCodexStatus(): Promise<CodexStatus> {
  const fetchedAt = new Date().toISOString();

  let creds: { apiKey: string };
  try {
    creds = await readCodexCreds();
  } catch (err) {
    return {
      connected: false,
      quotaExceeded: false,
      error: err instanceof Error ? err.message : String(err),
      fetchedAt,
    };
  }

  const authHeader = { Authorization: `Bearer ${creds.apiKey}` };

  // 1. Credit grants (prepaid accounts)
  try {
    const res = await fetch(
      "https://api.openai.com/dashboard/billing/credit_grants",
      { headers: authHeader },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        total_granted?: number;
        total_used?: number;
        total_available?: number;
        grants?: Array<{ grant_amount?: number; used_amount?: number; expires_at?: number | null }>;
        currency?: string;
      };
      const available = data.total_available ?? null;
      const granted = data.total_granted ?? null;

      const utilization =
        granted && granted > 0 && available != null
          ? Math.min(100, Math.round(((granted - available) / granted) * 100))
          : undefined;

      return {
        connected: true,
        quotaExceeded: utilization === 100,
        creditBalance: available != null ? available / 100 : undefined, // cents → dollars
        creditCurrency: data.currency ?? "USD",
        utilization,
        fetchedAt,
      };
    }
    // 402/429 → quota exceeded
    if (res.status === 402 || res.status === 429) {
      return { connected: true, quotaExceeded: true, utilization: 100, error: "Quota exceeded", fetchedAt };
    }
  } catch {
    // network error — fall through
  }

  // 2. Subscription endpoint (accounts with explicit soft/hard limits)
  try {
    const res = await fetch(
      "https://api.openai.com/dashboard/billing/subscription",
      { headers: authHeader },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        hard_limit_usd?: number;
        soft_limit_usd?: number;
        access_until?: number;
        canceled?: boolean;
      };
      if (data.canceled) {
        return { connected: false, quotaExceeded: false, error: "Subscription canceled", fetchedAt };
      }
      return {
        connected: true,
        quotaExceeded: false,
        fetchedAt,
      };
    }
  } catch {
    // fall through
  }

  // 3. Verify the key works at all by listing models
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: authHeader,
    });
    if (res.ok) {
      return { connected: true, quotaExceeded: false, fetchedAt };
    }
    if (res.status === 402 || res.status === 429) {
      return { connected: true, quotaExceeded: true, utilization: 100, error: "Quota exceeded", fetchedAt };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
    const code = body?.error?.code ?? "";
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    if (
      code === "insufficient_quota" ||
      code === "billing_hard_limit_reached" ||
      res.status === 401
    ) {
      return {
        connected: res.status !== 401,
        quotaExceeded: res.status !== 401,
        utilization: res.status !== 401 ? 100 : undefined,
        error: message,
        fetchedAt,
      };
    }
    return { connected: false, quotaExceeded: false, error: message, fetchedAt };
  } catch (err) {
    return {
      connected: false,
      quotaExceeded: false,
      error: err instanceof Error ? err.message : String(err),
      fetchedAt,
    };
  }
}

/** Returns true if Codex is reachable and quota is not exhausted. */
export async function isCodexAvailable(): Promise<boolean> {
  try {
    const status = await fetchCodexStatus();
    return status.connected && !status.quotaExceeded;
  } catch {
    return false;
  }
}
