import { memo, useEffect, useRef, useState } from "react";
import { ArchiveRestore, Bot, Check, Pencil, Star, Trash2 } from "lucide-react";
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
  onToggleStar?: (chatId: string, starred: boolean) => void;
  onRename?: (chatId: string, title: string) => void;
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
  onToggleStar,
  onRename,
  draftText,
}: Props) {
  const finished = chat.userMarkedFinished;
  const finishedLabel = finished ? "Unarchive" : "Mark finished";
  const isCoordinator = chat.kind === "coordinator";
  const isSubagent = chat.kind === "subagent";
  const starred = !!chat.starred;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    setDraft(chat.title);
    setEditing(true);
  };

  const commit = () => {
    const next = draft.trim();
    if (next && next !== chat.title) onRename?.(chat.id, next);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(chat.title);
    setEditing(false);
  };

  return (
    <div
      className={`chat-item ${active ? "active" : ""}${isCoordinator ? " chat-item--coordinator" : ""}${isSubagent ? " chat-item--subagent" : ""}`}
      onClick={() => !editing && onSelect(chat.id)}
      title={chat.title}
    >
      {isCoordinator ? (
        <span className="chat-item-agent-icon" aria-hidden="true">
          <Bot size={15} />
        </span>
      ) : (
        <StatusIcon status={chat.status} />
      )}
      <div className="chat-item-body">
        {editing ? (
          <input
            ref={inputRef}
            className="chat-item-rename-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") cancel();
            }}
            onBlur={commit}
          />
        ) : (
          <div className="chat-item-title">
            {isSubagent && (
              <span className="chat-item-agent-badge" title="Agent-spawned chat" aria-hidden="true">
                <Bot size={11} />
              </span>
            )}
            {starred && !isCoordinator && (
              <Star
                size={11}
                className="chat-item-star-indicator"
                fill="currentColor"
                aria-hidden="true"
              />
            )}
            {chat.title}
          </div>
        )}
        {!editing && (draftText ? (
          <div className="chat-item-preview chat-item-draft">
            ✏ {draftText}
          </div>
        ) : chat.preview ? (
          <div className="chat-item-preview">{chat.preview}</div>
        ) : null)}
      </div>
      {!isCoordinator && !editing && (
        <div
          className="chat-item-actions"
          onClick={(e) => e.stopPropagation()}
        >
          {onToggleStar && (
            <button
              type="button"
              className={`chat-item-action${starred ? " starred" : ""}`}
              onClick={() => onToggleStar(chat.id, !starred)}
              aria-label={starred ? "Unstar chat" : "Star chat"}
              title={starred ? "Unstar chat" : "Star chat"}
            >
              <Star size={14} fill={starred ? "currentColor" : "none"} aria-hidden="true" />
            </button>
          )}
          {onRename && (
            <button
              type="button"
              className="chat-item-action"
              onClick={startEditing}
              aria-label="Rename chat"
              title="Rename chat"
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
          )}
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
      )}
      {isCoordinator && chat.status === "running" && (
        <StatusIcon status={chat.status} />
      )}
    </div>
  );
}

export const ChatSidebarItem = memo(ChatSidebarItemInner);
