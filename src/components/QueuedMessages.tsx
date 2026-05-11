import type { Attachment } from "../types.js";

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: Attachment[];
}

interface Props {
  queue: QueuedMessage[];
  onRemove: (id: string) => void;
  onFastForward: (id: string) => void;
}

export function QueuedMessages({ queue, onRemove, onFastForward }: Props) {
  if (queue.length === 0) return null;
  return (
    <div className="queued-messages">
      {queue.map((msg) => (
        <div key={msg.id} className="queued-item">
          <span className="queued-badge">Queued</span>
          <span className="queued-preview">
            {msg.text ? msg.text : "(attachment)"}
          </span>
          <button
            className="queued-fast-forward"
            onClick={() => onFastForward(msg.id)}
            title="Interrupt current and send this now"
            aria-label="Send this queued message now"
          >
            ⏭
          </button>
          <button
            className="queued-remove"
            onClick={() => onRemove(msg.id)}
            title="Remove from queue"
            aria-label="Remove queued message"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
