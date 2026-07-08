import { memo } from "react";

// Renders a hairline separator with a human-friendly timestamp embedded in its
// centre, e.g. "Today at 3:42 PM" or "Jul 7 at 9:05 AM".
function formatFriendly(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  const now = new Date();
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round(
    (startOfDay(now) - startOfDay(date)) / 86_400_000,
  );

  if (dayDiff === 0) return `Today at ${time}`;
  if (dayDiff === 1) return `Yesterday at ${time}`;

  const sameYear = date.getFullYear() === now.getFullYear();
  const dateStr = date.toLocaleDateString(
    undefined,
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
  return `${dateStr} at ${time}`;
}

function TimestampDividerInner({ ts }: { ts?: string }) {
  if (!ts) return null;
  const label = formatFriendly(ts);
  if (!label) return null;
  return (
    <div className="timestamp-divider" role="separator" aria-label={label}>
      <span className="timestamp-divider-label">{label}</span>
    </div>
  );
}

export const TimestampDivider = memo(TimestampDividerInner);
