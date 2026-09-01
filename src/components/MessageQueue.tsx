import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Paperclip,
  Pause,
  Play,
  SendHorizontal,
  X,
} from "lucide-react";
import type { QueuedChatTurn } from "../types.js";
import type { LocalQueuedMessage } from "../hooks/useAgent.js";

interface Props {
  queue: LocalQueuedMessage[];
  usageQueuedTurns: QueuedChatTurn[];
  paused: boolean;
  onTogglePause: () => void;
  onRemove: (id: string) => void;
  onRemoveUsageTurn: (id: string) => void;
  onFastTrack: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

function preview(text: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return firstLine || "(empty message)";
}

function formatTimeUntil(iso: string | null): string {
  if (!iso) return "when capacity returns";
  const now = Date.now();
  const target = new Date(iso).getTime();
  const ms = target - now;
  if (ms <= 0) return "soon";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  if (totalMin === 0) return "in under a minute";
  return `in ${mins}m`;
}

export function MessageQueue({
  queue,
  usageQueuedTurns,
  paused,
  onTogglePause,
  onRemove,
  onRemoveUsageTurn,
  onFastTrack,
  onReorder,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  if (queue.length === 0 && usageQueuedTurns.length === 0) return null;

  const wakeups = usageQueuedTurns.filter((turn) => turn.kind === "scheduled_wakeup");
  const usageRetries = usageQueuedTurns.filter((turn) => turn.kind !== "scheduled_wakeup");
  const delayedLead = usageQueuedTurns[0] ?? null;
  const delayedCount = usageQueuedTurns.length;
  const delayedNote =
    delayedLead && delayedCount > 0
      ? `${delayedLead.reason} ${delayedCount === 1 ? "1 turn is" : `${delayedCount} turns are`} queued ${paused ? "and will stay queued until you resume the queue." : `and will continue automatically ${formatTimeUntil(delayedLead.runAfter)}, unless you pause the queue.`}`
      : null;

  const totalCount = queue.length + usageQueuedTurns.length;

  return (
    <div className={`message-queue${paused ? " paused" : ""}`}>
      <div className="message-queue-header">
        <span className="message-queue-title">Queue</span>
        <span className="message-queue-count">{totalCount}</span>
        {paused && <span className="message-queue-status">Paused</span>}
        <div className="message-queue-actions">
          <button
            type="button"
            className="message-queue-btn"
            onClick={onTogglePause}
            title={paused ? "Resume auto-send" : "Pause auto-send"}
            aria-label={paused ? "Resume auto-send" : "Pause auto-send"}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button
            type="button"
            className="message-queue-btn"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand queue" : "Collapse queue"}
            aria-label={collapsed ? "Expand queue" : "Collapse queue"}
          >
            {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {delayedNote && (
            <div className="message-queue-note">{delayedNote}</div>
          )}

          {queue.length > 0 && (
            <ul className="message-queue-list">
              {queue.map((msg, i) => {
                const attachmentCount = msg.opts.attachments?.length ?? 0;
                return (
                  <li
                    key={msg.id}
                    className={`message-queue-item${dragIndex === i ? " dragging" : ""}${
                      dropIndex === i && dragIndex !== i ? " drop-target" : ""
                    }`}
                    draggable
                    onDragStart={(e) => {
                      setDragIndex(i);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dropIndex !== i) setDropIndex(i);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragIndex !== null && dragIndex !== i) {
                        onReorder(dragIndex, i);
                      }
                      setDragIndex(null);
                      setDropIndex(null);
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setDropIndex(null);
                    }}
                  >
                    <span className="message-queue-grip" aria-hidden="true">
                      <GripVertical size={14} />
                    </span>
                    {attachmentCount > 0 && (
                      <span
                        className="message-queue-attachments"
                        title={`${attachmentCount} attachment${attachmentCount > 1 ? "s" : ""}`}
                      >
                        <Paperclip size={12} />
                        {attachmentCount}
                      </span>
                    )}
                    <span className="message-queue-text">{preview(msg.text)}</span>
                    <div className="message-queue-item-actions">
                      <button
                        type="button"
                        className="message-queue-action fast"
                        onClick={() => onFastTrack(msg.id)}
                        title="Send now (stops the current turn)"
                        aria-label="Send now"
                      >
                        <SendHorizontal size={14} />
                      </button>
                      <button
                        type="button"
                        className="message-queue-action remove"
                        onClick={() => onRemove(msg.id)}
                        title="Remove from queue"
                        aria-label="Remove from queue"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {wakeups.length > 0 && (
            <div className="message-queue-usage-section">
              <div className="message-queue-section-header">
                Scheduled wakeups
              </div>
              <ul className="message-queue-list message-queue-list--usage">
                {wakeups.map((turn) => {
                  const attachmentCount = turn.attachments?.length ?? 0;
                  return (
                    <li
                      key={turn.id}
                      className="message-queue-item"
                      title={turn.reason}
                    >
                      <span className="message-queue-badge">Wakeup</span>
                      {attachmentCount > 0 && (
                        <span
                          className="message-queue-attachments"
                          title={`${attachmentCount} attachment${attachmentCount > 1 ? "s" : ""}`}
                        >
                          <Paperclip size={12} />
                          {attachmentCount}
                        </span>
                      )}
                      <span className="message-queue-text">{preview(turn.text)}</span>
                      <div className="message-queue-item-actions">
                        <button
                          type="button"
                          className="message-queue-action remove"
                          onClick={() => onRemoveUsageTurn(turn.id)}
                          title="Remove from queue"
                          aria-label="Remove from queue"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {usageRetries.length > 0 && (
            <div className="message-queue-usage-section">
              <div className="message-queue-section-header">
                Queued because usage is limited
              </div>
              <ul className="message-queue-list message-queue-list--usage">
                {usageRetries.map((turn) => {
                  const attachmentCount = turn.attachments?.length ?? 0;
                  return (
                    <li key={turn.id} className="message-queue-item" title={turn.reason}>
                      <span className="message-queue-badge">Usage</span>
                      {attachmentCount > 0 && (
                        <span
                          className="message-queue-attachments"
                          title={`${attachmentCount} attachment${attachmentCount > 1 ? "s" : ""}`}
                        >
                          <Paperclip size={12} />
                          {attachmentCount}
                        </span>
                      )}
                      <span className="message-queue-text">{preview(turn.text)}</span>
                      <div className="message-queue-item-actions">
                        <button
                          type="button"
                          className="message-queue-action remove"
                          onClick={() => onRemoveUsageTurn(turn.id)}
                          title="Remove from queue"
                          aria-label="Remove from queue"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
