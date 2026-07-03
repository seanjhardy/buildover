import type { QueuedChatTurn } from "../types.js";

interface QueuedTurnsBannerProps {
  queuedTurns: QueuedChatTurn[];
}

function formatTime(iso: string | null): string {
  if (!iso) return "when usage resets";
  const date = new Date(iso);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();

  if (diffMs <= 0) return "shortly";

  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `in ${days}d ${hours % 24}h`;
  if (hours > 0) return `in ${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `in ${minutes}m`;
  return "shortly";
}

export function QueuedTurnsBanner({ queuedTurns }: QueuedTurnsBannerProps) {
  if (queuedTurns.length === 0) return null;

  const firstTurn = queuedTurns[0];
  const count = queuedTurns.length;
  const timeStr = formatTime(firstTurn.runAfter);

  return (
    <div className="queued-turns-banner">
      <div className="queued-turns-icon">⏳</div>
      <div className="queued-turns-content">
        <div className="queued-turns-title">
          {count === 1 ? "1 message queued" : `${count} messages queued`}
        </div>
        <div className="queued-turns-subtitle">
          {firstTurn.reason} Will run automatically {timeStr}.
        </div>
      </div>
    </div>
  );
}
