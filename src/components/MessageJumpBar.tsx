import { useCallback, useEffect, useRef, useState } from "react";
import type { JumpBarHandle } from "./MessageList.js";

interface Props {
  jumpBarRef: React.RefObject<JumpBarHandle | null>;
}

// Layout constants (SVG pixels)
const DOT_R        = 4;
const DOT_ACTIVE_R = 5.5;
const DOT_GAP      = 18;
const PAD_V        = 14;
const SVG_W        = 20;
// Half-spread of the glow in SVG px (i.e. how tall the fade is either side)
const GLOW_PX      = 50;

export function MessageJumpBar({ jumpBarRef }: Props) {
  const [activeIdx, setActiveIdx]   = useState(0);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipY, setTooltipY]     = useState(0);
  // Snapshot of user messages for rendering — updated on scroll so the bar
  // always reflects the current turns without needing a prop.
  const [userMsgs, setUserMsgs] = useState<{ id: string; text: string }[]>([]);

  // Direct ref to the SVG linearGradient element — we mutate its stops
  // directly on every scroll event to avoid React re-render lag entirely.
  const gradRef = useRef<SVGLinearGradientElement>(null);

  // Stable ref to the latest update() function so we can call it outside the
  // scroll-listener effect (e.g. when userItems changes due to branch switch).
  const updateRef = useRef<(() => void) | null>(null);

  // Attach a scroll listener to the virtualizer's scroll container.
  // The listener reads all position data from the VirtualizerHandle API
  // (scrollOffset, viewportSize, getItemOffset, getItemSize) rather than
  // querying the DOM, so it works correctly regardless of which items are
  // currently rendered in the virtual window.
  useEffect(() => {
    // Poll for the container: jumpBarRef.current is populated by MessageList's
    // useEffect which runs after our own, so we retry with rAF until it's set.
    let rafId: number;

    const attach = () => {
      const handle = jumpBarRef.current;
      if (!handle) {
        rafId = requestAnimationFrame(attach);
        return;
      }
      const v = handle.virtualizerRef.current;
      if (!v) {
        rafId = requestAnimationFrame(attach);
        return;
      }
      const el = handle.containerRef.current;
      if (!el) {
        rafId = requestAnimationFrame(attach);
        return;
      }

      const update = () => {
        const jb = jumpBarRef.current;
        if (!jb) return;
        const virt = jb.virtualizerRef.current;
        if (!virt) return;
        const { userItems } = jb;
        if (userItems.length === 0) return;

        // Sync userMsgs for rendering (only triggers re-render when turns change)
        setUserMsgs((prev) => {
          const next = userItems.map(({ id, text }) => ({ id, text }));
          if (
            prev.length === next.length &&
            prev.every((m, i) => m.id === next[i].id)
          ) {
            return prev; // no change, bail to avoid re-render
          }
          return next;
        });

        // scrollOffset = pixels scrolled from the top of the virtual list
        // viewportSize = visible height of the scroll container
        const scrollOffset = virt.scrollOffset;
        const viewportSize = virt.viewportSize;
        const viewportMid  = scrollOffset + viewportSize / 2;

        // For each user message, get the offset of its top edge and compute
        // its centre (top + half its size) in scroll-space.
        const msgCentres = userItems.map(({ itemIndex }) => {
          const top  = virt.getItemOffset(itemIndex);
          const size = virt.getItemSize(itemIndex);
          return top + size / 2;
        });

        // ── Snap: find the dot whose message centre is closest to viewport mid ──
        let closest = 0;
        let minDist = Infinity;
        msgCentres.forEach((cy, i) => {
          const d = Math.abs(cy - viewportMid);
          if (d < minDist) { minDist = d; closest = i; }
        });
        setActiveIdx(closest);

        // ── Continuous: interpolate a fractional "dot index" ──────────────
        const n = msgCentres.length;
        let floatIdx: number;

        if (viewportMid <= msgCentres[0]) {
          floatIdx = 0;
        } else if (viewportMid >= msgCentres[n - 1]) {
          floatIdx = n - 1;
        } else {
          floatIdx = n - 1;
          for (let i = 0; i < n - 1; i++) {
            const a = msgCentres[i];
            const b = msgCentres[i + 1];
            if (viewportMid >= a && viewportMid <= b) {
              floatIdx = i + (viewportMid - a) / (b - a);
              break;
            }
          }
        }

        // Map float dot-index → SVG Y coordinate
        const newGlowY = PAD_V + floatIdx * DOT_GAP;

        // ── Directly mutate gradient stops — no React re-render, zero lag ──
        const grad = gradRef.current;
        if (grad) {
          const lineTop = PAD_V;
          const lineBot = PAD_V + (n - 1) * DOT_GAP;
          const lineLen = lineBot - lineTop;
          const pct = (y: number) =>
            lineLen > 0 ? `${(((y - lineTop) / lineLen) * 100).toFixed(2)}%` : "0%";

          const g0px = Math.max(lineTop, newGlowY - GLOW_PX);
          const g1px = Math.min(lineBot, newGlowY + GLOW_PX);

          const stops = grad.querySelectorAll("stop");
          // stops[0] = "0%"      always transparent (anchor)
          // stops[1] = g0px      fade-in start
          // stops[2] = newGlowY  bright centre
          // stops[3] = g1px      fade-out end
          // stops[4] = "100%"    always transparent (anchor)
          if (stops.length >= 5) {
            stops[1].setAttribute("offset", pct(g0px));
            stops[2].setAttribute("offset", pct(newGlowY));
            stops[3].setAttribute("offset", pct(g1px));
          }
        }
      };

      updateRef.current = update;

      // Register as the notifyUpdate callback so MessageList can trigger a
      // refresh when userItems changes (e.g. after a branch switch) without
      // waiting for a scroll event.
      if (jumpBarRef.current) {
        jumpBarRef.current.notifyUpdate = update;
      }

      el.addEventListener("scroll", update, { passive: true });
      update(); // run once immediately to set initial state
      cleanup = () => {
        el.removeEventListener("scroll", update);
        updateRef.current = null;
        if (jumpBarRef.current) {
          jumpBarRef.current.notifyUpdate = undefined;
        }
      };
    };

    let cleanup: (() => void) | null = null;
    rafId = requestAnimationFrame(attach);

    return () => {
      cancelAnimationFrame(rafId);
      cleanup?.();
    };
  }, [jumpBarRef]);


  const jumpTo = useCallback(
    (id: string, itemIndex: number) => {
      const v = jumpBarRef.current?.virtualizerRef.current;
      if (v) {
        v.scrollToIndex(itemIndex, { align: "center" });
      }
    },
    [jumpBarRef],
  );

  const navigate = useCallback(
    (dir: "up" | "down") => {
      const userItems = jumpBarRef.current?.userItems ?? [];
      const next =
        dir === "up"
          ? Math.max(0, activeIdx - 1)
          : Math.min(userItems.length - 1, activeIdx + 1);
      const msg = userItems[next];
      if (msg) jumpTo(msg.id, msg.itemIndex);
    },
    [jumpBarRef, activeIdx, jumpTo],
  );

  const handleDotEnter = (idx: number) => {
    setTooltipY(PAD_V + idx * DOT_GAP);
    setHoveredIdx(idx);
  };

  if (userMsgs.length === 0) return null;

  const n       = userMsgs.length;
  const svgH    = PAD_V * 2 + (n - 1) * DOT_GAP;
  const lineTop = PAD_V;
  const lineBot = PAD_V + (n - 1) * DOT_GAP;
  // Initial gradient stop values (will be immediately overridden by the
  // scroll handler's direct DOM mutation, but need sensible defaults for SSR
  // and the initial render before the first scroll event fires).
  const lineLen     = lineBot - lineTop;
  const initGlowY   = PAD_V; // first dot
  const initG0      = lineLen > 0 ? `${(((Math.max(lineTop, initGlowY - GLOW_PX) - lineTop) / lineLen) * 100).toFixed(2)}%` : "0%";
  const initCentre  = lineLen > 0 ? `${(((initGlowY - lineTop) / lineLen) * 100).toFixed(2)}%` : "0%";
  const initG1      = lineLen > 0 ? `${(((Math.min(lineBot, initGlowY + GLOW_PX) - lineTop) / lineLen) * 100).toFixed(2)}%` : "0%";

  const hoveredMsg = hoveredIdx !== null ? userMsgs[hoveredIdx] : null;

  return (
    <div className="message-jump-outer">
      <div className="message-jump-pill">
        {/* Up button */}
        <button
          type="button"
          className="jump-nav-btn"
          onClick={() => navigate("up")}
          disabled={activeIdx === 0}
          aria-label="Previous message"
        >
          ▲
        </button>

        {/* SVG track — line + gradient + dots */}
        <svg
          className="jump-track"
          width={SVG_W}
          height={svgH}
          viewBox={`0 0 ${SVG_W} ${svgH}`}
          overflow="visible"
        >
          <defs>
            {/*
              gradientUnits="userSpaceOnUse" is required — objectBoundingBox is
              degenerate on a zero-width vertical line and the browser silently
              drops the gradient. y1/y2 span the line in SVG px; stops are
              mutated directly by the scroll handler (no React re-render).
            */}
            <linearGradient
              ref={gradRef}
              id="jump-line-grad"
              x1={SVG_W / 2} y1={lineTop}
              x2={SVG_W / 2} y2={lineBot}
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0%"         stopColor="#d97757" stopOpacity="0" />
              <stop offset={initG0}     stopColor="#d97757" stopOpacity="0" />
              <stop offset={initCentre} stopColor="#d97757" stopOpacity="1" />
              <stop offset={initG1}     stopColor="#d97757" stopOpacity="0" />
              <stop offset="100%"       stopColor="#d97757" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Dim base track */}
          {n > 1 && (
            <line
              x1={SVG_W / 2} y1={lineTop}
              x2={SVG_W / 2} y2={lineBot}
              stroke="#3c3c3c"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          )}

          {/* Orange gradient overlay — centre follows scroll with zero lag */}
          {n > 1 && (
            <line
              x1={SVG_W / 2} y1={lineTop}
              x2={SVG_W / 2} y2={lineBot}
              stroke="url(#jump-line-grad)"
              strokeWidth="2"
              strokeLinecap="round"
            />
          )}

          {/* Dots */}
          {userMsgs.map((msg, idx) => {
            const cy        = PAD_V + idx * DOT_GAP;
            const isActive  = idx === activeIdx;
            const isHovered = idx === hoveredIdx;
            const itemIndex = jumpBarRef.current?.userItems[idx]?.itemIndex ?? 0;
            return (
              <circle
                key={msg.id}
                cx={SVG_W / 2}
                cy={cy}
                r={isActive ? DOT_ACTIVE_R : isHovered ? DOT_R * 1.5 : DOT_R}
                fill={isActive || isHovered ? "#d97757" : "#3c3c3c"}
                stroke={isActive ? "rgba(217,119,87,0.35)" : "none"}
                strokeWidth={isActive ? 3 : 0}
                style={{ cursor: "pointer", transition: "r 120ms ease, fill 120ms ease" }}
                onClick={() => jumpTo(msg.id, itemIndex)}
                onMouseEnter={() => handleDotEnter(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
                aria-label={`Jump to message ${idx + 1}`}
              />
            );
          })}

        </svg>

        {/* Down button */}
        <button
          type="button"
          className="jump-nav-btn"
          onClick={() => navigate("down")}
          disabled={activeIdx === n - 1}
          aria-label="Next message"
        >
          ▼
        </button>

        {/* Custom tooltip */}
        {hoveredMsg !== null && (
          <div
            className="jump-tooltip"
            style={{ top: tooltipY }}
            aria-hidden="true"
          >
            <div className="jump-tooltip-label">
              Message {(hoveredIdx ?? 0) + 1}
            </div>
            <div className="jump-tooltip-text">
              {hoveredMsg.text.length > 120
                ? hoveredMsg.text.slice(0, 120) + "…"
                : hoveredMsg.text}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
