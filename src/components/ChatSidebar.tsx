import { useMemo, useState } from "react";
import { ChatSidebarItem } from "./ChatSidebarItem.js";
import { GitPanel } from "./GitPanel.js";
import type { ChatStatus, ChatSummary } from "../types.js";

interface Props {
  chats: ChatSummary[];
  activeChatId: string | null;
  onSelect: (chatId: string) => void;
  onCreate: () => void;
  onToggleFinished: (chatId: string, finished: boolean) => void;
  onDelete: (chatId: string) => void;
  repoPath: string;
  chatDrafts?: Record<string, string>;
}

// Sidebar grouping order. Awaiting-input is most urgent (user has to click
// something), running is next, then error (needs attention), then agent_done
// (assistant said it was done), then idle. Finished/archived collapses below.
const GROUP_ORDER: ChatStatus[] = [
  "awaiting_input",
  "running",
  "error",
  "agent_done",
  "idle",
];

const GROUP_LABEL: Record<ChatStatus, string> = {
  awaiting_input: "Awaiting input",
  running: "Running",
  error: "Interrupted",
  agent_done: "Agent finished",
  idle: "Idle",
  finished: "Archive",
};

export function ChatSidebar({
  chats,
  activeChatId,
  onSelect,
  onCreate,
  onToggleFinished,
  onDelete,
  repoPath,
  chatDrafts = {},
}: Props) {
  const [query, setQuery] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => {
      return (
        c.title.toLowerCase().includes(q) ||
        c.preview.toLowerCase().includes(q)
      );
    });
  }, [chats, query]);

  const grouped = useMemo(() => {
    const archive: ChatSummary[] = [];
    const groups = new Map<ChatStatus, ChatSummary[]>();
    for (const status of GROUP_ORDER) groups.set(status, []);
    for (const c of filtered) {
      if (c.status === "finished") {
        archive.push(c);
      } else {
        const arr = groups.get(c.status) ?? [];
        arr.push(c);
        groups.set(c.status, arr);
      }
    }
    const sortByRecency = (a: ChatSummary, b: ChatSummary) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    for (const arr of groups.values()) arr.sort(sortByRecency);
    archive.sort(sortByRecency);
    return { groups, archive };
  }, [filtered]);

  return (
    <aside className="chat-sidebar">
      <div className="chat-sidebar-toolbar">
        <input
          className="chat-search"
          type="search"
          placeholder="Search chats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="new-chat-btn"
          onClick={onCreate}
          title="New chat"
        >
          + New
        </button>
      </div>
      <div className="chat-sidebar-list">
        {GROUP_ORDER.map((status) => {
          const items = grouped.groups.get(status) ?? [];
          if (items.length === 0) return null;
          return (
            <div key={status} className="chat-group">
              <div className="chat-group-label">{GROUP_LABEL[status]}</div>
              {items.map((c) => (
                <ChatSidebarItem
                  key={c.id}
                  chat={c}
                  active={c.id === activeChatId}
                  onSelect={onSelect}
                  onToggleFinished={onToggleFinished}
                  onDelete={onDelete}
                  draftText={chatDrafts[c.id]}
                />
              ))}
            </div>
          );
        })}
        {filtered.length === 0 && chats.length > 0 && (
          <div className="chat-sidebar-empty">No chats match "{query}"</div>
        )}
        {chats.length === 0 && (
          <div className="chat-sidebar-empty">
            No chats yet. Click <strong>+ New</strong> to start.
          </div>
        )}
        {grouped.archive.length > 0 && (
          <div className="chat-archive">
            <button
              type="button"
              className="chat-archive-toggle"
              onClick={() => setArchiveOpen((v) => !v)}
            >
              <span className="chat-archive-caret">
                {archiveOpen ? "▾" : "▸"}
              </span>
              Archive ({grouped.archive.length})
            </button>
            {archiveOpen &&
              grouped.archive.map((c) => (
                <ChatSidebarItem
                  key={c.id}
                  chat={c}
                  active={c.id === activeChatId}
                  onSelect={onSelect}
                  onToggleFinished={onToggleFinished}
                  onDelete={onDelete}
                  draftText={chatDrafts[c.id]}
                />
              ))}
          </div>
        )}
      </div>
      <GitPanel repoPath={repoPath} />
    </aside>
  );
}
