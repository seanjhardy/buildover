import { memo } from "react";
import { ArchiveRestore, Bot, Check, Trash2 } from "lucide-react";
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
  const isCoordinator = chat.kind === "coordinator";
  const isSubagent = chat.kind === "subagent";

  return (
    <div
      className={`chat-item ${active ? "active" : ""}${isCoordinator ? " chat-item--coordinator" : ""}${isSubagent ? " chat-item--subagent" : ""}`}
      onClick={() => onSelect(chat.id)}
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
        <div className="chat-item-title">
          {isSubagent && (
            <span className="chat-item-agent-badge" title="Agent-spawned chat" aria-hidden="true">
              <Bot size={11} />
            </span>
          )}
          {chat.title}
        </div>
        {draftText ? (
          <div className="chat-item-preview chat-item-draft">
            ✏ {draftText}
          </div>
        ) : chat.preview ? (
          <div className="chat-item-preview">{chat.preview}</div>
        ) : null}
      </div>
      {!isCoordinator && (
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
      )}
      {isCoordinator && chat.status === "running" && (
        <StatusIcon status={chat.status} />
      )}
    </div>
  );
}

export const ChatSidebarItem = memo(ChatSidebarItemInner);
