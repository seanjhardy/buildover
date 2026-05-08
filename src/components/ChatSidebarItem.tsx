import { StatusIcon } from "./StatusIcon.js";
import type { ChatSummary } from "../types.js";

interface Props {
  chat: ChatSummary;
  active: boolean;
  onSelect: () => void;
  onToggleFinished: () => void;
  onDelete: () => void;
  draftText?: string;
}

export function ChatSidebarItem({
  chat,
  active,
  onSelect,
  onToggleFinished,
  onDelete,
  draftText,
}: Props) {
  const finished = chat.userMarkedFinished;
  const finishedLabel = finished ? "Unarchive" : "Mark finished";

  return (
    <div
      className={`chat-item ${active ? "active" : ""}`}
      onClick={onSelect}
      title={chat.title}
    >
      <StatusIcon status={chat.status} />
      <div className="chat-item-body">
        <div className="chat-item-title">{chat.title}</div>
        {draftText ? (
          <div className="chat-item-preview chat-item-draft">
            ✏ {draftText}
          </div>
        ) : chat.preview ? (
          <div className="chat-item-preview">{chat.preview}</div>
        ) : null}
      </div>
      <div
        className="chat-item-actions"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="chat-item-action"
          onClick={onToggleFinished}
          aria-label={finishedLabel}
          title={finishedLabel}
        >
          {finished ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 8l3-3M3 8l3 3M3 8h10" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3.5 4.5l3 3 6-6" />
              <path d="M13 8v4.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h5" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="chat-item-action danger"
          onClick={onDelete}
          aria-label="Delete chat"
          title="Delete chat"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M2.5 4h11" />
            <path d="M6 4V2.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V4" />
            <path d="M4 4l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4" />
            <path d="M6.5 7v4M9.5 7v4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
