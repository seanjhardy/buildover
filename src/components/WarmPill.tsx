import { useEffect, useState } from "react";
import { Flame, Snowflake } from "lucide-react";

// The prompt cache lives an hour from the last API call; a keep-warm ping
// re-reads it just before that and resets the clock (see sessions.ts).
const CACHE_TTL_MS = 60 * 60_000;
// Below this the cache is about to expire — worth showing differently so the
// user can see a chat is about to get expensive to resume.
const EXPIRING_MS = 10 * 60_000;
const TICK_MS = 30_000;

interface Props {
  /** When this chat last hit the API. Undefined === never (always cold). */
  lastApiAtMs?: number;
  /** Keep-warm pings are on for this chat. */
  keepWarm: boolean;
  /** Window the pings run for, in hours (for the tooltip). */
  keepWarmHours: number;
  /** Omitted for chats whose warmth isn't the user's to toggle (the Master). */
  onToggle?: () => void;
  /** Warmth is managed for this chat — shown, not toggleable. */
  locked?: boolean;
}

/**
 * Prompt-cache warmth of a chat: warm (cheap to resume), expiring, or cold
 * (the next message re-sends the whole context at cache-write price). Clicking
 * toggles keep-warm pings, which hold the cache open.
 */
export function WarmPill({ lastApiAtMs, keepWarm, keepWarmHours, onToggle, locked }: Props) {
  // Re-render on a slow tick so the countdown stays honest while idle.
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const leftMs = lastApiAtMs ? lastApiAtMs + CACHE_TTL_MS - Date.now() : 0;
  const warm = leftMs > 0;
  const expiring = warm && leftMs < EXPIRING_MS;
  const minsLeft = Math.max(0, Math.round(leftMs / 60_000));

  const state = !warm ? "cold" : expiring ? "expiring" : "warm";
  const label = warm ? `${minsLeft}m` : "cold";
  const title = [
    warm
      ? `Prompt cache warm — ${minsLeft} min left. Resuming is a cheap cache read.`
      : "Prompt cache cold — the next message re-sends the whole context at cache-write price.",
    keepWarm
      ? `Keep-warm on: pinged every 55 min for up to ${keepWarmHours}h after the last message.`
      : "Keep-warm off.",
    locked ? "Managed automatically." : onToggle ? "Click to toggle keep-warm." : "",
  ]
    .filter(Boolean)
    .join("\n");

  const className = `warm-pill warm-pill--${state}${keepWarm ? " warm-pill--pinned" : ""}`;

  const content = (
    <>
      {warm ? <Flame size={11} /> : <Snowflake size={11} />}
      <span className="warm-pill-label">{label}</span>
      {keepWarm && <span className="warm-pill-dot" aria-hidden />}
    </>
  );

  if (!onToggle || locked) {
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
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {content}
    </button>
  );
}
