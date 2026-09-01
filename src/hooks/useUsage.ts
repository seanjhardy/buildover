import { useCallback, useEffect, useRef, useState } from "react";

export interface UsageBucket {
  utilization: number;
  resetsAt: string | null;
  label?: string;
  windowSeconds?: number;
}

export interface Usage {
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

export interface ClaudeLoginAttempt {
  state: "idle" | "running" | "succeeded" | "failed";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  expiresAt?: string;
  login: ClaudeLoginAttempt;
  error?: string;
}

export interface CursorUsage {
  total: UsageBucket | null;
  auto: UsageBucket | null;
  api: UsageBucket | null;
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

export interface CodexUsage {
  connected: boolean;
  authMode: "chatgpt" | "api-key" | "none";
  planType?: string;
  primary: UsageBucket | null;
  secondary: UsageBucket | null;
  codeReviewPrimary: UsageBucket | null;
  codeReviewSecondary: UsageBucket | null;
  additional: Array<{
    id: string;
    label: string;
    primary: UsageBucket | null;
    secondary: UsageBucket | null;
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

const POLL_MS = 30 * 60 * 1000;

export function useUsage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [cursorUsage, setCursorUsage] = useState<CursorUsage | null>(null);
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null);
  const [claudeAuth, setClaudeAuth] = useState<ClaudeAuthStatus | null>(null);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [claudeErrorStatus, setClaudeErrorStatus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  const refreshClaudeAuth = useCallback(async (): Promise<ClaudeAuthStatus | null> => {
    try {
      const res = await fetch("/api/claude/auth/status");
      if (!res.ok) return null;
      const status = (await res.json()) as ClaudeAuthStatus;
      setClaudeAuth(status);
      if (!status.loggedIn) setUsage(null);
      return status;
    } catch {
      return null;
    }
  }, []);

  const fetchOnce = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setLoading(true);
    try {
      const [claudeRes, cursorRes, codexRes] = await Promise.all([
        fetch("/api/usage", { signal: ctrl.signal }),
        fetch("/api/cursor/usage", { signal: ctrl.signal }),
        fetch("/api/codex/usage", { signal: ctrl.signal }),
        refreshClaudeAuth(),
      ]);

      let nextError: string | null = null;

      if (claudeRes.ok) {
        setUsage((await claudeRes.json()) as Usage);
        setClaudeError(null);
        setClaudeErrorStatus(null);
      } else {
        const body = await claudeRes.json().catch(() => ({ error: claudeRes.statusText }));
        const message = body.error || `Claude usage HTTP ${claudeRes.status}`;
        setClaudeError(message);
        setClaudeErrorStatus(claudeRes.status);
        if (claudeRes.status === 401 || claudeRes.status === 403) setUsage(null);
        nextError = message;
      }

      if (cursorRes.ok) {
        setCursorUsage((await cursorRes.json()) as CursorUsage);
      } else if (cursorRes.status !== 404) {
        const raw = await cursorRes.text().catch(() => "");
        let message = cursorRes.statusText || `Cursor usage HTTP ${cursorRes.status}`;
        try {
          const parsed = JSON.parse(raw) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          if (raw.trim()) {
            message = raw.replace(/<[^>]+>/g, " ").trim().slice(0, 160);
          }
        }
        nextError = nextError ? `${nextError}; ${message}` : message;
      } else {
        setCursorUsage(null);
      }

      if (codexRes.ok) {
        setCodexUsage((await codexRes.json()) as CodexUsage);
      } else if (codexRes.status !== 404) {
        const body = await codexRes.json().catch(() => ({
          error: codexRes.statusText || `Codex usage HTTP ${codexRes.status}`,
        }));
        const message = body.error || `Codex usage HTTP ${codexRes.status}`;
        nextError = nextError ? `${nextError}; ${message}` : message;
      } else {
        setCodexUsage(null);
      }

      // Only surface a global error when every provider failed.
      if (!claudeRes.ok && !cursorRes.ok && !codexRes.ok) {
        setError(nextError ?? "usage unavailable");
      } else {
        setError(null);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally {
      if (inflight.current === ctrl) {
        inflight.current = null;
        setLoading(false);
      }
    }
  }, [refreshClaudeAuth]);

  useEffect(() => {
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_MS);
    // Pick up a login completed in another terminal, or a Keychain refresh
    // that happened while Buildover was in the background, as soon as the app
    // becomes active again instead of waiting for the 30-minute usage poll.
    const handleFocus = () => {
      void refreshClaudeAuth();
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", handleFocus);
      inflight.current?.abort();
    };
  }, [fetchOnce, refreshClaudeAuth]);

  return {
    usage,
    cursorUsage,
    codexUsage,
    claudeAuth,
    claudeError,
    claudeErrorStatus,
    error,
    loading,
    refresh: fetchOnce,
    refreshClaudeAuth,
  };
}
