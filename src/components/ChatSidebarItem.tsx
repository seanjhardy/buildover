import { memo } from "react";
import { StatusIcon } from "./StatusIcon.js";
import type { ChatSummary } from "../types.js";

interface Props {
  chat: ChatSummary;
  active: boolean;
  // Stable shared handlers — accept chatId so the parent doesn't need to
  // create a new closure per item on every render.
  onSelect: (chatId: string) => void;
  onToggleFinished: (chatId: string, finished: boolean) => void;
  onDelete: (chatId: string) => void;
  draftText?: string;
}

// Memoized so that live WebSocket status updates (which update one chat at a
// time) don't cause every item in the sidebar list to re-render.
function ChatSidebarItemInner({
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
      onClick={() => onSelect(chat.id)}
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
          onClick={() => onToggleFinished(chat.id, chat.userMarkedFinished)}
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
          onClick={() => onDelete(chat.id)}
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

export const ChatSidebarItem = memo(ChatSidebarItemInner);
