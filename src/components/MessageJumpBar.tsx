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
// The track never grows beyond this height. With many messages the dot gap
// compresses (and dots shrink) so the bar becomes a dense minimap instead of
// getting longer with every message.
const MAX_TRACK_H  = 400;

function gapFor(n: number): number {
  if (n <= 1) return DOT_GAP;
  return Math.min(DOT_GAP, (MAX_TRACK_H - 2 * PAD_V) / (n - 1));
}

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

  // Attach a scroll listener to the message container and use actual DOM
  // positions for the mounted window. Dots still represent the full transcript;
  // unloaded rows are simply omitted from position measurement.
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
      const el = handle.containerRef.current;
      if (!el) {
        rafId = requestAnimationFrame(attach);
        return;
      }

      const update = () => {
        const jb = jumpBarRef.current;
        if (!jb) return;
        const { userItems } = jb;
        if (userItems.length === 0) {
          setUserMsgs([]);
          setActiveIdx(0);
          return;
        }

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

        const viewportMid = el.scrollTop + el.clientHeight / 2;
        const containerTop = el.getBoundingClientRect().top;
        const elements = new Map(
          Array.from(el.querySelectorAll<HTMLElement>('[data-turn-kind="user"][data-turn-id]'))
            .map((node) => [node.dataset.turnId ?? "", node] as const),
        );
        const positioned = userItems.flatMap(({ id }, index) => {
          const rect = elements.get(id)?.getBoundingClientRect();
          return rect
            ? [{
                index,
                centre:
                  rect.top - containerTop + el.scrollTop + rect.height / 2,
              }]
            : [];
        });
        if (positioned.length === 0) return;

        // ── Snap: find the dot whose message centre is closest to viewport mid ──
        let closest = positioned[0].index;
        let minDist = Infinity;
        positioned.forEach(({ centre, index }) => {
          const d = Math.abs(centre - viewportMid);
          if (d < minDist) { minDist = d; closest = index; }
        });
        setActiveIdx(closest);

        // ── Continuous: interpolate a fractional "dot index" ──────────────
        const n = userItems.length;
        let floatIdx: number;
        const first = positioned[0];
        const last = positioned[positioned.length - 1];

        if (viewportMid <= first.centre) {
          floatIdx = first.index;
        } else if (viewportMid >= last.centre) {
          floatIdx = last.index;
        } else {
          floatIdx = last.index;
          for (let i = 0; i < positioned.length - 1; i++) {
            const a = positioned[i];
            const b = positioned[i + 1];
            if (viewportMid >= a.centre && viewportMid <= b.centre) {
              const span = b.centre - a.centre;
              const progress = span > 0
                ? (viewportMid - a.centre) / span
                : 0;
              floatIdx = a.index + progress * (b.index - a.index);
              break;
            }
          }
        }

        // Map float dot-index → SVG Y coordinate
        const newGlowY = PAD_V + floatIdx * gapFor(n);

        // ── Directly mutate gradient stops — no React re-render, zero lag ──
        const grad = gradRef.current;
        if (grad) {
          const lineTop = PAD_V;
          const lineBot = PAD_V + (n - 1) * gapFor(n);
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
    (id: string) => {
      const handle = jumpBarRef.current;
      if (handle?.scrollToMessage) {
        handle.scrollToMessage(id);
        return;
      }
      const el = jumpBarRef.current?.containerRef.current;
      if (!el) return;
      const target = Array.from(
        el.querySelectorAll<HTMLElement>('[data-turn-kind="user"][data-turn-id]'),
      ).find((node) => node.dataset.turnId === id);
      if (!target) return;
      jumpBarRef.current?.setPinned?.(false);
      const containerTop = el.getBoundingClientRect().top;
      const targetRect = target.getBoundingClientRect();
      const targetCenter = targetRect.top - containerTop + el.scrollTop + targetRect.height / 2;
      el.scrollTo({
        top: targetCenter - el.clientHeight / 2,
        behavior: "smooth",
      });
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
      if (msg) jumpTo(msg.id);
    },
    [jumpBarRef, activeIdx, jumpTo],
  );

  const handleDotEnter = (idx: number) => {
    setTooltipY(PAD_V + idx * gapFor(userMsgs.length));
    setHoveredIdx(idx);
  };

  if (userMsgs.length === 0) return null;

  const n       = userMsgs.length;
  const gap     = gapFor(n);
  // Dots scale down as the gap compresses so they stay distinct.
  const dotR       = Math.max(1.5, Math.min(DOT_R, gap * 0.4));
  const dotActiveR = Math.min(DOT_ACTIVE_R, dotR + 1.5);
  const svgH    = PAD_V * 2 + (n - 1) * gap;
  const lineTop = PAD_V;
  const lineBot = PAD_V + (n - 1) * gap;
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
            const cy        = PAD_V + idx * gap;
            const isActive  = idx === activeIdx;
            const isHovered = idx === hoveredIdx;
            return (
              <circle
                key={msg.id}
                cx={SVG_W / 2}
                cy={cy}
                r={isActive ? dotActiveR : isHovered ? Math.max(dotR * 1.5, 4) : dotR}
                fill={isActive || isHovered ? "#d97757" : "#3c3c3c"}
                stroke={isActive ? "rgba(217,119,87,0.35)" : "none"}
                strokeWidth={isActive ? 3 : 0}
                style={{ cursor: "pointer", transition: "r 120ms ease, fill 120ms ease" }}
                onClick={() => jumpTo(msg.id)}
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
