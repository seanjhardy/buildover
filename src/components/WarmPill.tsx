import { useCallback, useEffect, useRef, useState } from "react";
import { Flame, Snowflake } from "lucide-react";
import { KEEP_WARM_ADD_HOURS, KEEP_WARM_BUDGET_HOURS } from "../types.js";
import {
  BUDGET_ENDING_MS,
  CACHE_EXPIRING_MS,
  budgetMsLeft,
  cacheMsLeft,
  formatWarmSpan,
} from "../lib/warmth.js";

const TICK_MS = 30_000;
/** Hold this long to stop warming. Long enough not to fire on a slow tap,
 *  short enough that the fill animation doesn't feel like a punishment. */
const HOLD_MS = 550;
/** How long the "+1h" / "off" acknowledgement stays up. */
const FLASH_MS = 1_100;

export interface WarmPillProps {
  /** When this chat last hit the API. Undefined === never (always cold). */
  lastApiAtMs?: number;
  /** ISO deadline the warmth budget runs to. Absent === warming off. */
  keepWarmUntil?: string | null;
  /** Buys warmth: a fresh budget when there is none, a top-up when there is.
   *  Omitted for chats whose warmth isn't the user's to spend. */
  onAddHours?: (hours: number) => void;
  /** Stops warming now — the long-press. */
  onDisable?: () => void;
  /** Warmth is managed for this chat (the Master) — shown, not spendable. */
  locked?: boolean;
  /** For a locked chat: the window it keeps itself warm over, in hours. */
  managedHours?: number;
}

/**
 * Prompt-cache warmth of a chat, and the budget keeping it that way.
 *
 * The number is the *budget* whenever warming is on — "I'll keep this alive for
 * 3h more" — and the cache's own life otherwise. Clicking buys an hour (four to
 * start); holding stops warming there and then. See lib/warmth.ts for why the
 * two clocks are never shown side by side.
 */
export function WarmPill({
  lastApiAtMs,
  keepWarmUntil,
  onAddHours,
  onDisable,
  locked,
  managedHours,
}: WarmPillProps) {
  // Re-render on a slow tick so the countdown stays honest while idle.
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const [holding, setHolding] = useState(false);
  const [flash, setFlash] = useState<"add" | "off" | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout>>();
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
  // A completed hold must not also count as a click (pointerup fires first).
  const held = useRef(false);

  useEffect(
    () => () => {
      clearTimeout(holdTimer.current);
      clearTimeout(flashTimer.current);
    },
    [],
  );

  const acknowledge = useCallback((kind: "add" | "off") => {
    setFlash(kind);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  const cacheLeft = cacheMsLeft(lastApiAtMs);
  const warm = cacheLeft > 0;
  const budgetLeft = budgetMsLeft(keepWarmUntil);
  const budgeted = budgetLeft > 0;
  const interactive = !locked && !!onAddHours;

  const stopWarming = useCallback(() => {
    if (!onDisable || !budgeted) return;
    onDisable();
    acknowledge("off");
  }, [onDisable, budgeted, acknowledge]);

  const endHold = useCallback(() => {
    clearTimeout(holdTimer.current);
    setHolding(false);
  }, []);

  const cacheState = !warm ? "cold" : cacheLeft < CACHE_EXPIRING_MS ? "expiring" : "warm";
  const label =
    flash === "off"
      ? "off"
      : budgeted
        ? formatWarmSpan(budgetLeft)
        : warm
          ? formatWarmSpan(cacheLeft)
          : "cold";

  const title = [
    warm
      ? `Prompt cache warm — ${formatWarmSpan(cacheLeft)} left. Resuming is a cheap cache read.`
      : "Prompt cache cold — the next message re-sends the whole context at cache-write price.",
    locked
      ? `Kept warm automatically${managedHours ? ` for ${managedHours}h after each message` : ""}.`
      : budgeted
        ? `Keeping it warm for ${formatWarmSpan(budgetLeft)} more${warm ? "" : " (pings resume after its next real message)"}.`
        : "Warming off — the cache will expire on its own.",
    locked
      ? ""
      : interactive
        ? budgeted
          ? `Click for +${KEEP_WARM_ADD_HOURS}h · hold to stop warming`
          : `Click to keep it warm for ${KEEP_WARM_BUDGET_HOURS}h`
        : "",
  ]
    .filter(Boolean)
    .join("\n");

  const className = [
    "warm-pill",
    `warm-pill--${cacheState}`,
    budgeted ? "warm-pill--pinned" : "",
    budgeted && budgetLeft < BUDGET_ENDING_MS ? "warm-pill--ending" : "",
    locked ? "warm-pill--managed" : "",
    holding ? "warm-pill--holding" : "",
    flash ? `warm-pill--flash-${flash}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const content = (
    <>
      {warm || budgeted ? <Flame size={11} /> : <Snowflake size={11} />}
      <span className="warm-pill-label">{label}</span>
      {budgeted && <span className="warm-pill-dot" aria-hidden />}
    </>
  );

  if (!interactive) {
    return (
      <span className={className} title={title}>
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={
        budgeted
          ? `Warm for ${formatWarmSpan(budgetLeft)} more. Click to add an hour, hold to stop warming.`
          : `Not being kept warm. Click to keep warm for ${KEEP_WARM_BUDGET_HOURS} hours.`
      }
      // Pointer events, so one implementation covers mouse, pen and touch.
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button !== undefined && e.button !== 0) return;
        held.current = false;
        if (!budgeted) return; // nothing to turn off yet
        setHolding(true);
        holdTimer.current = setTimeout(() => {
          held.current = true;
          setHolding(false);
          stopWarming();
        }, HOLD_MS);
      }}
      onPointerUp={endHold}
      onPointerLeave={endHold}
      onPointerCancel={endHold}
      // iOS puts up its own menu on a long press otherwise; on desktop this
      // doubles as the mouse route to turning warming off.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        stopWarming();
      }}
      onKeyDown={(e) => {
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          e.stopPropagation();
          stopWarming();
        }
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (held.current) {
          held.current = false;
          return;
        }
        onAddHours?.(budgeted ? KEEP_WARM_ADD_HOURS : KEEP_WARM_BUDGET_HOURS);
        acknowledge("add");
      }}
    >
      {content}
    </button>
  );
}
