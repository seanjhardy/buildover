import { useCallback, useEffect, useRef, useState } from "react";
import { selfUpdateApi, type SelfUpdateStatus } from "../lib/api.js";

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const DISMISSED_SHA_KEY = "buildover.dismissedUpdateSHA";

function getDismissedSHA(): string | null {
  try { return localStorage.getItem(DISMISSED_SHA_KEY); } catch { return null; }
}
function setDismissedSHA(sha: string): void {
  try { localStorage.setItem(DISMISSED_SHA_KEY, sha); } catch { /* ignore */ }
}

export interface SelfUpdateState {
  status: SelfUpdateStatus | null;
  /** True while a pull (or force-pull) is in flight. */
  isPulling: boolean;
  /** Result message from the last pull attempt. */
  pullResult: { success: boolean; output: string } | null;
  /** Whether the banner should currently be visible. */
  showBanner: boolean;
  pull: () => Promise<void>;
  forcePull: () => Promise<void>;
  dismiss: () => void;
  refresh: () => Promise<void>;
}

export function useSelfUpdate(): SelfUpdateState {
  const [status, setStatus] = useState<SelfUpdateStatus | null>(null);
  const [isPulling, setIsPulling] = useState(false);
  const [pullResult, setPullResult] = useState<{ success: boolean; output: string } | null>(null);
  const [dismissedSHA, setDismissedSHAState] = useState<string | null>(getDismissedSHA);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await selfUpdateApi.getStatus();
      setStatus(s);
    } catch {
      // Silently ignore — server may not be ready yet
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    intervalRef.current = setInterval(() => { void fetchStatus(); }, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStatus]);

  const pull = useCallback(async () => {
    setIsPulling(true);
    setPullResult(null);
    try {
      const result = await selfUpdateApi.pull();
      setPullResult(result);
      if (result.success) await fetchStatus();
    } catch (err) {
      setPullResult({ success: false, output: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsPulling(false);
    }
  }, [fetchStatus]);

  const forcePull = useCallback(async () => {
    setIsPulling(true);
    setPullResult(null);
    try {
      const result = await selfUpdateApi.forcePull();
      setPullResult(result);
      if (result.success) await fetchStatus();
    } catch (err) {
      setPullResult({ success: false, output: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsPulling(false);
    }
  }, [fetchStatus]);

  const dismiss = useCallback(() => {
    if (status?.remoteSHA) {
      setDismissedSHA(status.remoteSHA);
      setDismissedSHAState(status.remoteSHA);
    }
  }, [status]);

  // Show the banner when there's an update and the user hasn't dismissed this SHA
  const showBanner = Boolean(
    status?.hasUpdate && status.remoteSHA !== dismissedSHA,
  );

  return { status, isPulling, pullResult, showBanner, pull, forcePull, dismiss, refresh: fetchStatus };
}
