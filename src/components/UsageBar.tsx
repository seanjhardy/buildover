import { useState } from "react";
import { useUsage, type UsageBucket } from "../hooks/useUsage.js";

// Inclusive thresholds: at or below 50% used we render in claude-orange,
// 50-80% amber, above 80% red. The "low" in the user request refers to
// remaining quota, i.e. high utilization.
function colorFor(util: number): string {
  if (util >= 80) return "var(--app-error)";
  if (util >= 50) return "var(--app-warning)";
  return "var(--app-claude-orange)";
}

function formatTimeUntil(iso: string | null): string {
  if (!iso) return "—";
  const now = Date.now();
  const target = new Date(iso).getTime();
  const ms = target - now;
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatResetDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Bar({ bucket, label }: { bucket: UsageBucket; label: string }) {
  const pct = Math.max(0, Math.min(100, bucket.utilization));
  return (
    <div className="usage-row">
      <div className="usage-row-label">{label}</div>
      <div className="usage-row-bar">
        <div
          className="usage-row-fill"
          style={{ width: `${pct}%`, background: colorFor(pct) }}
        />
      </div>
      <div className="usage-row-meta">
        {pct.toFixed(0)}% · {formatResetDate(bucket.resetsAt)}
      </div>
    </div>
  );
}

export function UsageBar() {
  const { usage, error, loading, refresh } = useUsage();
  const [hover, setHover] = useState(false);

  // Compact line summary uses the 5h session bucket (matches the screenshot).
  const session = usage?.fiveHour;
  const sessionPct = session ? Math.round(session.utilization) : null;
  const sessionResetsIn = formatTimeUntil(session?.resetsAt ?? null);
  const compactColor = session ? colorFor(session.utilization) : undefined;

  return (
    <div
      className="usage-bar"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        className="usage-trigger"
        onClick={refresh}
        title="Click to refresh"
      >
        {error ? (
          <span style={{ color: "var(--app-error)" }}>usage error</span>
        ) : !usage ? (
          <span>{loading ? "loading usage…" : "usage"}</span>
        ) : (
          <>
            <span style={{ color: compactColor }}>
              Session {sessionPct}%
            </span>
            <span className="usage-trigger-sep">·</span>
            <span>{sessionResetsIn}</span>
            {loading && <span className="usage-trigger-sep">refreshing…</span>}
          </>
        )}
      </button>
      {hover && usage && (
        <div className="usage-popover" role="dialog">
          <div className="usage-popover-title">Claude Code Usage</div>
          {usage.fiveHour && <Bar bucket={usage.fiveHour} label="Session" />}
          {usage.sevenDay && <Bar bucket={usage.sevenDay} label="Weekly" />}
          {usage.sevenDayOpus && (
            <Bar bucket={usage.sevenDayOpus} label="Opus" />
          )}
          {usage.sevenDaySonnet && (
            <Bar bucket={usage.sevenDaySonnet} label="Sonnet" />
          )}
          <div className="usage-popover-foot">
            {usage.subscriptionType && (
              <span>plan: {usage.subscriptionType}</span>
            )}
            {usage.rateLimitTier && (
              <span>tier: {usage.rateLimitTier}</span>
            )}
            <span>
              fetched{" "}
              {new Date(usage.fetchedAt).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          </div>
        </div>
      )}
      {hover && error && (
        <div className="usage-popover" role="dialog">
          <div className="usage-popover-title">Usage unavailable</div>
          <div style={{ color: "var(--app-error)", fontSize: 12 }}>
            {error}
          </div>
          <div className="usage-popover-foot">
            <span>Make sure `claude` is authenticated.</span>
          </div>
        </div>
      )}
    </div>
  );
}
