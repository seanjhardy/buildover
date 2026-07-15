import { useState } from "react";
import { useUsage, type UsageBucket } from "../hooks/useUsage.js";

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

function dollars(cents: number | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function windowLabel(seconds: number | undefined, fallback: string): string {
  if (!seconds) return fallback;
  if (seconds <= 6 * 60 * 60) return "Session";
  if (seconds <= 8 * 24 * 60 * 60) return "Weekly";
  return `${Math.round(seconds / 86_400)} day`;
}

function Bar({
  bucket,
  label,
  meta,
}: {
  bucket: UsageBucket;
  label: string;
  meta?: string;
}) {
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
        {pct.toFixed(0)}%
        {meta ? ` · ${meta}` : ` · ${formatResetDate(bucket.resetsAt)}`}
      </div>
    </div>
  );
}

function CursorMark({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="usage-provider-icon"
    >
      <path d="M4 4l16 8-16 8V4zm3.2 5.2v5.6L13.4 12 7.2 9.2z" />
    </svg>
  );
}

export function UsageBar() {
  const { usage, cursorUsage, codexUsage, error, loading, refresh } = useUsage();
  const [hover, setHover] = useState(false);

  const session = usage?.fiveHour;
  const sessionPct = session ? Math.round(session.utilization) : null;
  const cursorTotal = cursorUsage?.total;
  const cursorPct = cursorTotal ? Math.round(cursorTotal.utilization) : null;
  const codexPrimary = codexUsage?.primary;
  const codexPct = codexPrimary ? Math.round(codexPrimary.utilization) : null;

  const claudeBlocked =
    !!usage &&
    [usage.fiveHour, usage.sevenDay, usage.sevenDaySonnet, usage.sevenDayOpus].some(
      (bucket) => bucket && bucket.utilization >= 100,
    );
  const cursorBlocked =
    cursorUsage?.total != null && cursorUsage.total.utilization >= 100;
  const codexBlocked = codexUsage?.quotaExceeded === true;
  const isBlocked = claudeBlocked || cursorBlocked || codexBlocked;

  const fetchedAt =
    usage?.fetchedAt ?? cursorUsage?.fetchedAt ?? codexUsage?.fetchedAt;

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
        style={isBlocked ? { color: "var(--app-error)", fontWeight: 600 } : undefined}
      >
        {error && !usage && !cursorUsage && !codexUsage ? (
          <span style={{ color: "var(--app-error)" }}>usage error</span>
        ) : isBlocked ? (
          <>
            <span style={{ color: "var(--app-error)" }}>⚠ Limit reached</span>
            {claudeBlocked && session?.resetsAt && (
              <>
                <span className="usage-trigger-sep">·</span>
                <span>Claude {formatTimeUntil(session.resetsAt)}</span>
              </>
            )}
            {cursorBlocked && cursorTotal?.resetsAt && (
              <>
                <span className="usage-trigger-sep">·</span>
                <span>Cursor {formatTimeUntil(cursorTotal.resetsAt)}</span>
              </>
            )}
            {codexBlocked && codexPrimary?.resetsAt && (
              <>
                <span className="usage-trigger-sep">·</span>
                <span>Codex {formatTimeUntil(codexPrimary.resetsAt)}</span>
              </>
            )}
          </>
        ) : sessionPct == null && cursorPct == null && codexPct == null ? (
          <span>{loading ? "loading usage…" : "usage"}</span>
        ) : (
          <>
            {sessionPct != null && (
              <span style={{ color: colorFor(sessionPct) }}>
                Claude {sessionPct}%
              </span>
            )}
            {sessionPct != null && cursorPct != null && (
              <span className="usage-trigger-sep">·</span>
            )}
            {cursorPct != null && (
              <span
                className="usage-trigger-cursor"
                style={{ color: colorFor(cursorPct) }}
              >
                <CursorMark />
                Cursor {cursorPct}%
              </span>
            )}
            {(sessionPct != null || cursorPct != null) && codexPct != null && (
              <span className="usage-trigger-sep">·</span>
            )}
            {codexPct != null && (
              <span style={{ color: colorFor(codexPct) }}>
                Codex {codexPct}%
              </span>
            )}
            {loading && <span className="usage-trigger-sep">refreshing…</span>}
          </>
        )}
      </button>
      {hover && (
        <div className="usage-popover" role="dialog">
          {isBlocked && (
            <div className="usage-limit-warning">
              ⚠ Usage limit reached for{" "}
              {[
                claudeBlocked ? "Claude" : "",
                cursorBlocked ? "Cursor" : "",
                codexBlocked ? "Codex" : "",
              ]
                .filter(Boolean)
                .join(", ")}.{" "}
              Messages may be queued or routed to the other provider when available.
            </div>
          )}

          {usage && (
            <div className="usage-section">
              <div
                className="usage-popover-title"
                style={{ color: "var(--app-claude-orange)" }}
              >
                Claude Code
              </div>
              {usage.fiveHour && <Bar bucket={usage.fiveHour} label="Session" />}
              {usage.sevenDay && <Bar bucket={usage.sevenDay} label="Weekly" />}
              {usage.sevenDayOpus && <Bar bucket={usage.sevenDayOpus} label="Opus" />}
              {usage.sevenDaySonnet && (
                <Bar bucket={usage.sevenDaySonnet} label="Sonnet" />
              )}
            </div>
          )}

          {cursorUsage && (
            <div className="usage-section">
              <div className="usage-popover-title usage-popover-title-cursor">
                <CursorMark size={12} />
                Cursor
              </div>
              {cursorUsage.total && (
                <Bar
                  bucket={cursorUsage.total}
                  label="Total"
                  meta={
                    cursorUsage.planUsage
                      ? `${dollars(cursorUsage.planUsage.totalSpendCents)} / ${dollars(cursorUsage.planUsage.limitCents)}`
                      : undefined
                  }
                />
              )}
              {cursorUsage.auto && <Bar bucket={cursorUsage.auto} label="Auto" />}
              {cursorUsage.api && <Bar bucket={cursorUsage.api} label="API" />}
              {cursorUsage.autoMessage && (
                <div className="usage-note">{cursorUsage.autoMessage}</div>
              )}
              {cursorUsage.apiMessage && (
                <div className="usage-note">{cursorUsage.apiMessage}</div>
              )}
            </div>
          )}

          {codexUsage && (
            <div className="usage-section">
              <div
                className="usage-popover-title"
                style={{ color: "#10a37f" }}
              >
                OpenAI Codex
              </div>
              {codexUsage.primary && (
                <Bar
                  bucket={codexUsage.primary}
                  label={windowLabel(
                    codexUsage.primary.windowSeconds,
                    "Primary",
                  )}
                />
              )}
              {codexUsage.secondary && (
                <Bar
                  bucket={codexUsage.secondary}
                  label={windowLabel(
                    codexUsage.secondary.windowSeconds,
                    "Secondary",
                  )}
                />
              )}
              {codexUsage.codeReviewPrimary && (
                <Bar
                  bucket={codexUsage.codeReviewPrimary}
                  label="Code review"
                />
              )}
              {(codexUsage.additional ?? []).flatMap((limit) =>
                [limit.primary, limit.secondary]
                  .filter((bucket): bucket is UsageBucket => bucket != null)
                  .map((bucket, index) => (
                    <Bar
                      key={`${limit.id}-${index}`}
                      bucket={bucket}
                      label={limit.label}
                    />
                  )),
              )}
              {codexUsage.resetCreditsAvailable != null && (
                <div className="usage-note">
                  {codexUsage.resetCreditsAvailable} rate-limit reset credit
                  {codexUsage.resetCreditsAvailable === 1 ? "" : "s"} available
                </div>
              )}
              {codexUsage.note && (
                <div className="usage-note">{codexUsage.note}</div>
              )}
              {codexUsage.error && (
                <div className="usage-note" style={{ color: "var(--app-error)" }}>
                  {codexUsage.error}
                </div>
              )}
            </div>
          )}

          {!usage && !cursorUsage && !codexUsage && error && (
            <div style={{ color: "var(--app-error)", fontSize: 12 }}>{error}</div>
          )}

          <div className="usage-popover-foot">
            {usage?.subscriptionType && (
              <span>claude: {usage.subscriptionType}</span>
            )}
            {cursorUsage?.membershipType && (
              <span>cursor: {cursorUsage.membershipType}</span>
            )}
            {codexUsage?.planType && (
              <span>codex: {codexUsage.planType}</span>
            )}
            {fetchedAt && (
              <span>
                fetched{" "}
                {new Date(fetchedAt).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
