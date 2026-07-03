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
import type { LocalQueuedMessage } from "../hooks/useAgent.js";

interface Props {
  queue: LocalQueuedMessage[];
  paused: boolean;
  onTogglePause: () => void;
  onRemove: (id: string) => void;
  onFastTrack: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

function preview(text: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return firstLine || "(empty message)";
}

export function MessageQueue({
  queue,
  paused,
  onTogglePause,
  onRemove,
  onFastTrack,
  onReorder,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  if (queue.length === 0) return null;

  return (
    <div className={`message-queue${paused ? " paused" : ""}`}>
      <div className="message-queue-header">
        <span className="message-queue-title">Queue</span>
        <span className="message-queue-count">{queue.length}</span>
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
    </div>
  );
}
