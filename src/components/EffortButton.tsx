import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Gauge } from "lucide-react";
import { EFFORT_LEVELS, type EffortLevel } from "../types.js";

const LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

interface Props {
  /** Levels the current model supports, lowest to highest. */
  levels: EffortLevel[];
  /** Saved preference; undefined → `fallback` (the model's default). */
  value: EffortLevel | undefined;
  fallback: EffortLevel;
  onChange: (level: EffortLevel) => void;
}

// Snaps a preferred level onto the model's supported ladder — the highest
// supported level at or below it, mirroring the server-side clamp.
function clampToLevels(level: EffortLevel, levels: EffortLevel[]): number {
  const ceiling = EFFORT_LEVELS.indexOf(level);
  for (let i = levels.length - 1; i >= 0; i--) {
    if (EFFORT_LEVELS.indexOf(levels[i]) <= ceiling) return i;
  }
  return 0;
}

// Composer pill showing the current effort; opens a popover with a segmented
// slider (one segment per supported level) that can be clicked or dragged.
export function EffortButton({ levels, value, fallback, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const index = clampToLevels(value ?? fallback, levels);
  const current = levels[index];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const select = (i: number) => {
    const next = levels[Math.max(0, Math.min(levels.length - 1, i))];
    if (next !== current || !value) onChange(next);
  };

  const selectAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    select(Math.floor(((clientX - rect.left) / rect.width) * levels.length));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    selectAt(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) selectAt(e.clientX);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      select(index + step);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      select(e.key === "Home" ? 0 : levels.length - 1);
    }
  };

  return (
    <div ref={wrapRef} className="popup-wrap">
      <button
        className={`effort-pill-btn${open ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Reasoning effort"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Gauge size={13} aria-hidden="true" />
        <span className="effort-pill-label">{LABELS[current]}</span>
      </button>
      {open && (
        <div className="effort-popup" role="dialog" aria-label="Reasoning effort">
          <div className="effort-popup-head">
            <span className="effort-popup-title">Effort</span>
            <span className="effort-popup-level">
              {LABELS[current]}
              {!value && <span className="effort-popup-default"> · default</span>}
            </span>
          </div>
          <div
            ref={trackRef}
            className="effort-track"
            role="slider"
            tabIndex={0}
            aria-label="Reasoning effort"
            aria-valuemin={0}
            aria-valuemax={levels.length - 1}
            aria-valuenow={index}
            aria-valuetext={LABELS[current]}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onKeyDown={onKeyDown}
          >
            <div
              className="effort-track-fill"
              style={{ width: `${((index + 1) / levels.length) * 100}%` }}
            />
            {levels.slice(1).map((level, i) => (
              <span
                key={level}
                className="effort-track-notch"
                style={{ left: `${((i + 1) / levels.length) * 100}%` }}
              />
            ))}
          </div>
          <div className="effort-popup-scale">
            <span>Faster</span>
            <span>Smarter</span>
          </div>
        </div>
      )}
    </div>
  );
}
