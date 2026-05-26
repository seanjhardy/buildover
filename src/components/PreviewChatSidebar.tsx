import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Plus, X } from "lucide-react";
import { MessageList, type JumpBarHandle } from "./MessageList.js";
import { Composer } from "./Composer.js";
import { AttentionPrompt, PermissionPrompt } from "./PermissionPrompt.js";
import { ChatSidebarItem } from "./ChatSidebarItem.js";
import { GROUP_ORDER, GROUP_LABEL, ChatItemsByRecency } from "./ChatSidebar.js";
import type { ChatSummary, PermissionMode, Attachment, Model } from "../types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAgent = any;

interface PreviewChatSidebarProps {
  chats: ChatSummary[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onCreateChat: () => void;
  onToggleFinished: (chatId: string, finished: boolean) => void;
  onDeleteChat: (chatId: string) => void;
  chatDrafts: Record<string, string>;
  repoPath: string;
  onClosePreview: () => void;

  agent: AnyAgent;

  onDraftChange: (draft: string) => void;
  model: Model;
  permissionMode: PermissionMode;
  onPermissionModeChange: (m: PermissionMode) => void;
  onToggleMcp: () => void;
}

interface PopupPos {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export function PreviewChatSidebar({
  chats,
  activeChatId,
  onSelectChat,
  onCreateChat,
  onToggleFinished,
  onDeleteChat,
  chatDrafts,
  repoPath,
  onClosePreview,
  agent,
  onDraftChange,
  model,
  permissionMode,
  onPermissionModeChange,
  onToggleMcp,
}: PreviewChatSidebarProps) {
  const [showChatList, setShowChatList] = useState(false);
  const [popupPos, setPopupPos] = useState<PopupPos | null>(null);
  const msgScrollRef = useRef<HTMLDivElement>(null);
  const jumpBarRef = useRef<JumpBarHandle | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listBtnRef = useRef<HTMLButtonElement>(null);

  const activeChat = activeChatId
    ? (chats.find((c) => c.id === activeChatId) ?? null)
    : null;

  // Open popup: calculate fixed position from the header's bounding rect
  const openPopup = () => {
    const rect = headerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPopupPos({
      top: rect.bottom + 2,
      left: rect.left,
      width: rect.width,
      maxHeight: window.innerHeight - rect.bottom - 12,
    });
    setShowChatList(true);
  };

  const closePopup = () => setShowChatList(false);

  const togglePopup = () => {
    if (showChatList) closePopup();
    else openPopup();
  };

  // Close on outside click or Escape
  useEffect(() => {
    if (!showChatList) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !popupRef.current?.contains(target) &&
        !listBtnRef.current?.contains(target)
      ) {
        closePopup();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePopup();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showChatList]);

  const handleSelectChat = (id: string) => {
    onSelectChat(id);
    closePopup();
  };

  const handleCreateChat = () => {
    onCreateChat();
    closePopup();
  };

  // Build the grouped chat list (same order as the normal sidebar)
  const groupedChats = (() => {
    const groups = new Map<string, ChatSummary[]>();
    for (const status of GROUP_ORDER) groups.set(status, []);
    for (const c of chats) {
      if (c.status === "finished") continue; // skip archive in popup
      const arr = groups.get(c.status) ?? [];
      arr.push(c);
      groups.set(c.status, arr);
    }
    const sortByRecency = (a: ChatSummary, b: ChatSummary) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    for (const arr of groups.values()) arr.sort(sortByRecency);
    return groups;
  })();

  const totalVisible = [...groupedChats.values()].reduce(
    (n, arr) => n + arr.length,
    0,
  );

  const popup = showChatList && popupPos
    ? createPortal(
        <div
          ref={popupRef}
          className="preview-chat-popup"
          style={{
            top: popupPos.top,
            left: popupPos.left,
            width: popupPos.width,
            maxHeight: popupPos.maxHeight,
          }}
        >
          <button
            type="button"
            className="preview-chat-popup-new"
            onClick={handleCreateChat}
          >
            <Plus size={12} />
            New chat
          </button>
          <div className="preview-chat-popup-scroll">
            {totalVisible === 0 ? (
              <div className="preview-chat-popup-empty">No chats yet</div>
            ) : (
              GROUP_ORDER.map((status) => {
                const items = groupedChats.get(status) ?? [];
                if (items.length === 0) return null;
                return (
                  <div key={status} className="chat-group">
                    <div className="chat-group-label">{GROUP_LABEL[status]}</div>
                    <ChatItemsByRecency
                      items={items}
                      activeChatId={activeChatId}
                      onSelect={handleSelectChat}
                      onToggleFinished={onToggleFinished}
                      onDelete={onDeleteChat}
                      chatDrafts={chatDrafts}
                    />
                  </div>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <aside className="chat-sidebar preview-chat-sidebar">
      {/* Header ─ chat list toggle | active chat title | close preview */}
      <div className="preview-chat-header" ref={headerRef}>
        <button
          ref={listBtnRef}
          type="button"
          className={`preview-chat-list-btn${showChatList ? " preview-chat-list-btn--active" : ""}`}
          onClick={togglePopup}
          title={showChatList ? "Close chat list" : "Chat history"}
        >
          <MessageSquare size={14} />
        </button>
        <span className="preview-chat-title" title={activeChat?.title ?? ""}>
          {activeChat?.title ?? "No chat selected"}
        </span>
        <button
          type="button"
          className="preview-chat-close-btn"
          onClick={onClosePreview}
          title="Close preview"
        >
          <X size={13} />
        </button>
      </div>

      {popup}

      {/* Message thread */}
      <div className="preview-chat-messages">
        <MessageList
          turns={agent.turns}
          isStreaming={agent.isStreaming}
          cwd={agent.cwd ?? repoPath}
          scrollRef={msgScrollRef}
          jumpBarRef={jumpBarRef}
          branchInfo={agent.branchInfo}
          onForkMessage={(userMessageId: string, newText: string) =>
            agent.forkMessage(userMessageId, newText, { model, permissionMode })
          }
          onSwitchBranch={agent.switchBranch}
          onRevert={agent.revertToCheckpoint}
          chatId={activeChatId ?? undefined}
        />
        {agent.pendingAttention && (
          <AttentionPrompt
            pending={agent.pendingAttention}
            onRespond={agent.respondAttention}
          />
        )}
        {agent.pendingPermission && !agent.pendingAttention && (
          <PermissionPrompt
            pending={agent.pendingPermission}
            onRespond={agent.respondPermission}
          />
        )}
      </div>

      {/* Composer */}
      <div className="preview-chat-composer">
        <Composer
          key={activeChatId ?? "none"}
          chatId={activeChatId ?? ""}
          onSend={(text: string, attachments: Attachment[]) =>
            agent.send(text, { model, permissionMode, attachments })
          }
          onInterrupt={agent.interrupt}
          onDraftChange={onDraftChange}
          disabled={agent.isStreaming || agent.connection !== "connected"}
          isStreaming={agent.isStreaming}
          model={model}
          permissionMode={permissionMode}
          onPermissionModeChange={(m: PermissionMode) => {
            onPermissionModeChange(m);
            agent.setPermissionMode(m);
          }}
          onToggleMcp={onToggleMcp}
          contextUsage={agent.contextUsage}
          repoPath={repoPath}
          sdkSlashCommands={agent.slashCommands}
          hideModePill
        />
      </div>
    </aside>
  );
}
