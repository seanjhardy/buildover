import { useCallback, useEffect, useRef, useState } from "react";

export interface UsageBucket {
  utilization: number;
  resetsAt: string | null;
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

const POLL_MS = 5 * 60 * 1000;

export function useUsage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setLoading(true);
    try {
      const res = await fetch("/api/usage", { signal: ctrl.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as Usage;
      setUsage(data);
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
    } finally {
      if (inflight.current === ctrl) {
        inflight.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_MS);
    return () => {
      clearInterval(id);
      inflight.current?.abort();
    };
  }, [fetchOnce]);

  return { usage, error, loading, refresh: fetchOnce };
}
