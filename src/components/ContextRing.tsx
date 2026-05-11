import { useEffect, useRef, useState } from "react";
import type { ContextUsage } from "../types.js";

interface Props {
  contextUsage: ContextUsage | null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function ringColor(pct: number): string {
  if (pct >= 80) return "var(--app-error, #e05252)";
  if (pct >= 60) return "#e8a838";
  return "var(--app-claude-orange, #d97757)";
}

const TRACK_COLOR = "rgba(255,255,255,0.10)";
const SIZE = 26;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Tooltip width must match the CSS min-width so we can centre it correctly.
const TOOLTIP_WIDTH = 230;

export function ContextRing({ contextUsage }: Props) {
  const [hovered, setHovered] = useState(false);
  // Position of the tooltip in viewport coords (fixed positioning).
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const ringRef = useRef<HTMLDivElement>(null);

  // Recalculate tooltip position whenever hover state changes.
  useEffect(() => {
    if (!hovered || !ringRef.current) return;
    const rect = ringRef.current.getBoundingClientRect();
    // Centre the tooltip horizontally on the ring, place it above with 8px gap.
    const x = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
    const y = rect.top - 8; // tooltip bottom edge sits 8px above the ring top
    setTooltipPos({ x, y });
  }, [hovered]);

  if (!contextUsage) return null;

  const { pct, usedTokens, contextWindowSize, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = contextUsage;
  const dashOffset = CIRCUMFERENCE * (1 - Math.min(pct, 100) / 100);
  const color = ringColor(pct);

  return (
    <div
      ref={ringRef}
      className="context-ring"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={`Context window: ${pct.toFixed(1)}% used`}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={{ display: "block", transform: "rotate(-90deg)" }}
      >
        {/* Track */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke={TRACK_COLOR}
          strokeWidth={STROKE}
        />
        {/* Progress arc */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          style={{ transition: "stroke-dashoffset 0.4s ease, stroke 0.4s ease" }}
        />
      </svg>

      {/* Percentage label in the centre */}
      <span className="context-ring-label" style={{ color }}>
        {Math.round(pct)}
      </span>

      {hovered && (
        <div
          className="context-ring-tooltip"
          role="tooltip"
          style={{
            // Use fixed positioning so the tooltip escapes any overflow:hidden
            // or stacking-context parent (e.g. the sidebar or composer wrapper).
            position: "fixed",
            left: `${tooltipPos.x}px`,
            top: `${tooltipPos.y}px`,
            transform: "translateY(-100%)",
          }}
        >
          <div className="context-ring-tooltip-title">
            Context window
            <span className="context-ring-tooltip-pct" style={{ color }}>
              {pct.toFixed(1)}%
            </span>
          </div>
          <div className="context-ring-tooltip-bar">
            <div
              className="context-ring-tooltip-bar-fill"
              style={{ width: `${Math.min(pct, 100)}%`, background: color }}
            />
          </div>
          <table className="context-ring-tooltip-table">
            <tbody>
              <tr>
                <td>Used</td>
                <td>{formatTokens(usedTokens)} / {formatTokens(contextWindowSize)} tokens</td>
              </tr>
              <tr>
                <td>Input</td>
                <td>{formatTokens(inputTokens)}</td>
              </tr>
              <tr>
                <td>Output</td>
                <td>{formatTokens(outputTokens)}</td>
              </tr>
              {cacheReadTokens > 0 && (
                <tr>
                  <td>Cache read</td>
                  <td>{formatTokens(cacheReadTokens)}</td>
                </tr>
              )}
              {cacheWriteTokens > 0 && (
                <tr>
                  <td>Cache write</td>
                  <td>{formatTokens(cacheWriteTokens)}</td>
                </tr>
              )}
            </tbody>
          </table>
          {pct >= 80 && (
            <div className="context-ring-tooltip-warn">
              Auto-compaction will trigger shortly
            </div>
          )}
        </div>
      )}
    </div>
  );
}
