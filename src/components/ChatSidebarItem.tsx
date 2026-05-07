import { useState } from "react";
import { StatusIcon } from "./StatusIcon.js";
import type { ChatSummary } from "../types.js";

interface Props {
  chat: ChatSummary;
  active: boolean;
  onSelect: () => void;
  onToggleFinished: () => void;
  onDelete: () => void;
}

export function ChatSidebarItem({
  chat,
  active,
  onSelect,
  onToggleFinished,
  onDelete,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const finishedLabel = chat.userMarkedFinished ? "Unarchive" : "Mark finished";

  return (
    <div
      className={`chat-item ${active ? "active" : ""}`}
      onClick={onSelect}
      title={chat.title}
    >
      <StatusIcon status={chat.status} />
      <div className="chat-item-body">
        <div className="chat-item-title">{chat.title}</div>
        {chat.preview && (
          <div className="chat-item-preview">{chat.preview}</div>
        )}
      </div>
      <div
        className="chat-item-menu"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="chat-item-menu-trigger"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Chat actions"
        >
          ⋯
        </button>
        {menuOpen && (
          <div
            className="chat-item-menu-popover"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onToggleFinished();
              }}
            >
              {finishedLabel}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
