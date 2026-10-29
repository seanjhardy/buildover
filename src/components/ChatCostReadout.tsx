import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatCost } from "../types.js";
import { WarmPill, type WarmPillProps } from "./WarmPill.js";
import {
  costReadoutIsAmber,
  formatDuration,
  formatTokensRounded,
  formatUsd,
} from "../lib/tokenCost.js";

interface Props {
  cost: ChatCost | null;
  /** ISO time of the chat's first message. */
  startedAt?: string;
  /** Current context size in tokens (the context ring's "used"). */
  contextTokens: number;
  /** The chat's warmth pill; omitted for providers without a prompt cache. */
  warm?: WarmPillProps;
}

const TOOLTIP_WIDTH = 230;

/** Re-renders every 30s so the duration keeps ticking while the chat idles. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Running API-equivalent cost and age of the chat, e.g. `$4.12 · 2h 14m`, next
 * to the context ring. Turns amber when the context is large or the last turn
 * was expensive. The tooltip has the details; the warm pill sits alongside.
 */
export function ChatCostReadout({
  cost,
  startedAt,
  contextTokens,
  warm,
}: Props) {
  const now = useNow();
  const [hovered, setHovered] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hovered || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setPos({ x: rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2, y: rect.top - 8 });
  }, [hovered]);

  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  const duration = Number.isFinite(startedMs) ? formatDuration(now - startedMs) : null;
  if (!cost && !duration) return null;

  const amber = costReadoutIsAmber(contextTokens, cost?.lastTurnUsd);
  const label = [cost ? formatUsd(cost.totalUsd) : null, duration].filter(Boolean).join(" · ");

  return (
    <div
      ref={ref}
      className={`cost-readout${amber ? " cost-readout--warn" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="cost-readout-text" aria-label={`Chat cost and age: ${label}`}>
        {label}
      </span>
      {warm && <WarmPill {...warm} />}
      {hovered &&
        createPortal(
          <div
            className="context-ring-tooltip"
            role="tooltip"
            style={{
              position: "fixed",
              left: `${pos.x}px`,
              top: `${pos.y}px`,
              transform: "translateY(-100%)",
            }}
          >
            <div className="context-ring-tooltip-title">Chat cost (API-equivalent)</div>
            <table className="context-ring-tooltip-table">
              <tbody>
                <tr>
                  <td>Total</td>
                  <td>{cost ? formatUsd(cost.totalUsd) : "—"}</td>
                </tr>
                <tr>
                  <td>Turns</td>
                  <td>{cost?.turns ?? 0}</td>
                </tr>
                <tr>
                  <td>Last turn</td>
                  <td>{cost ? formatUsd(cost.lastTurnUsd) : "—"}</td>
                </tr>
                {cost?.silentUsd ? (
                  <tr>
                    <td>Background</td>
                    <td>{formatUsd(cost.silentUsd)}</td>
                  </tr>
                ) : null}
                <tr>
                  <td>Context</td>
                  <td>{formatTokensRounded(contextTokens)} tokens</td>
                </tr>
                {duration && (
                  <tr>
                    <td>Age</td>
                    <td>{duration}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {amber && (
              <div className="context-ring-tooltip-warn cost-readout-tooltip-warn">
                {contextTokens > 150_000
                  ? "Large context: every message re-reads it."
                  : "The last turn was expensive."}
              </div>
            )}
            <div className="cost-readout-tooltip-note">
              Includes compaction, keep-alive and handoff turns.
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
