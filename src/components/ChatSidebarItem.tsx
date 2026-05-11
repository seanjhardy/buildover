import { memo } from "react";
import { ArchiveRestore, Check, Trash2 } from "lucide-react";
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
          onClick={() => onToggleFinished(chat.id, !chat.userMarkedFinished)}
          aria-label={finishedLabel}
          title={finishedLabel}
        >
          {finished ? (
            <ArchiveRestore size={14} aria-hidden="true" />
          ) : (
            <Check size={14} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="chat-item-action danger"
          onClick={() => onDelete(chat.id)}
          aria-label="Delete chat"
          title="Delete chat"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export const ChatSidebarItem = memo(ChatSidebarItemInner);
