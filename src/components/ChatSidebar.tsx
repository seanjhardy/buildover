import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { ChatSidebarItem } from "./ChatSidebarItem.js";
import { searchApi } from "../lib/api.js";
import type { ChatStatus, ChatSummary, SearchResult } from "../types.js";

interface Props {
  chats: ChatSummary[];
  activeChatId: string | null;
  onSelect: (chatId: string) => void;
  onCreate: () => void;
  onToggleFinished: (chatId: string, finished: boolean) => void;
  onDelete: (chatId: string) => void;
  repoPath: string;
  chatDrafts?: Record<string, string>;
  onOpenGraph?: () => void;
}

const GROUP_ORDER: ChatStatus[] = [
  "awaiting_input",
  "idle",
  "running",
  "agent_done",
  "error",
];

const GROUP_LABEL: Record<ChatStatus, string> = {
  awaiting_input: "Awaiting input",
  running: "Running",
  error: "Interrupted",
  agent_done: "Agent finished",
  idle: "Idle",
  finished: "Archive",
};

type RecencyBucket = "today" | "week" | "month" | "older";

const RECENCY_ORDER: RecencyBucket[] = ["today", "week", "month", "older"];

const RECENCY_LABEL: Record<RecencyBucket, string> = {
  today: "Today",
  week: "Last 7 days",
  month: "Last month",
  older: "Older",
};

function getRecencyBucket(updatedAt: string): RecencyBucket {
  const ts = new Date(updatedAt).getTime();
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 7);
  const startOfMonth = new Date(startOfToday);
  startOfMonth.setDate(startOfMonth.getDate() - 30);

  if (ts >= startOfToday.getTime()) return "today";
  if (ts >= startOfWeek.getTime()) return "week";
  if (ts >= startOfMonth.getTime()) return "month";
  return "older";
}

function groupByRecency(items: ChatSummary[]): Map<RecencyBucket, ChatSummary[]> {
  const buckets = new Map<RecencyBucket, ChatSummary[]>();
  for (const bucket of RECENCY_ORDER) buckets.set(bucket, []);
  for (const item of items) {
    const bucket = getRecencyBucket(item.updatedAt);
    buckets.get(bucket)!.push(item);
  }
  return buckets;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 30) return `${Math.floor(d / 30)}mo ago`;
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
}

function scoreColor(score: number): string {
  const t = Math.min(1, Math.max(0, (score - 0.25) / 0.75));
  // interpolate orange (low) → green (high)
  const r = Math.round(217 + (72 - 217) * t);
  const g = Math.round(119 + (199 - 119) * t);
  const b = Math.round(87 + (120 - 87) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

interface SearchResultGroup {
  chatId: string;
  chatTitle: string;
  chatUpdatedAt: string;
  results: SearchResult[];
}

/** Merge hits from the same chat into one card; group order follows first appearance. */
function groupSearchResultsByChat(results: SearchResult[]): SearchResultGroup[] {
  const order: string[] = [];
  const byChat = new Map<string, SearchResultGroup>();
  for (const r of results) {
    let group = byChat.get(r.chatId);
    if (!group) {
      group = {
        chatId: r.chatId,
        chatTitle: r.chatTitle,
        chatUpdatedAt: r.chatUpdatedAt,
        results: [],
      };
      byChat.set(r.chatId, group);
      order.push(r.chatId);
    }
    group.results.push(r);
  }
  return order.map((id) => byChat.get(id)!);
}

function ChatItemsByRecency({
  items,
  activeChatId,
  onSelect,
  onToggleFinished,
  onDelete,
  chatDrafts,
}: {
  items: ChatSummary[];
  activeChatId: string | null;
  onSelect: (chatId: string) => void;
  onToggleFinished: (chatId: string, finished: boolean) => void;
  onDelete: (chatId: string) => void;
  chatDrafts: Record<string, string>;
}) {
  const byRecency = useMemo(() => groupByRecency(items), [items]);
  return (
    <>
      {RECENCY_ORDER.map((bucket) => {
        const bucketItems = byRecency.get(bucket) ?? [];
        if (bucketItems.length === 0) return null;
        return (
          <div key={bucket} className="chat-recency-section">
            <div className="chat-recency-label">{RECENCY_LABEL[bucket]}</div>
            {bucketItems.map((c) => (
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
    </>
  );
}

export function ChatSidebar({
  chats,
  activeChatId,
  onSelect,
  onCreate,
  onToggleFinished,
  onDelete,
  repoPath,
  chatDrafts = {},
  onOpenGraph,
}: Props) {
  const [query, setQuery] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSearchMode = query.trim().length > 0;

  const groupedSearchResults = useMemo(
    () => groupSearchResultsByChat(searchResults),
    [searchResults],
  );

  // Debounced semantic search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const { results } = await searchApi.search(repoPath, q);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, repoPath]);

  // Normal grouped list (used when not in search mode)
  const grouped = useMemo(() => {
    const archive: ChatSummary[] = [];
    const groups = new Map<ChatStatus, ChatSummary[]>();
    for (const status of GROUP_ORDER) groups.set(status, []);
    for (const c of chats) {
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
  }, [chats]);

  return (
    <aside className="chat-sidebar">
      <div className="chat-sidebar-toolbar">
        <div className="chat-search-wrap">
          <svg className="chat-search-icon" width="13" height="13" viewBox="0 0 20 20" fill="none">
            <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.7" />
            <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <input
            className="chat-search"
            type="text"
            placeholder="Search messages…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {isSearching
            ? <span className="chat-search-spinner" />
            : isSearchMode && (
              <button
                type="button"
                className="chat-search-clear"
                onClick={() => setQuery("")}
                title="Clear search"
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            )
          }
        </div>
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
        {isSearchMode ? (
          /* ── Semantic search results ── */
          <>
            {!isSearching && searchResults.length === 0 && (
              <div className="chat-sidebar-empty">No results for "{query}"</div>
            )}

            {groupedSearchResults.map((group) => {
              const topScore = Math.max(...group.results.map((r) => r.score));
              return (
                <button
                  key={group.chatId}
                  type="button"
                  className={`sidebar-search-result${group.chatId === activeChatId ? " sidebar-search-result--active" : ""}`}
                  onClick={() => onSelect(group.chatId)}
                >
                  <div
                    className="sidebar-search-result-bar"
                    style={{ background: scoreColor(topScore) }}
                  />
                  <div className="sidebar-search-result-body">
                    {group.results.map((r, i) => (
                      <div key={`${r.chatId}:${r.eventIndex}`}>
                        {i > 0 && <div className="sidebar-search-result-divider" aria-hidden />}
                        <div className="sidebar-search-result-text">{r.messageText}</div>
                      </div>
                    ))}
                    <div className="sidebar-search-result-meta">
                      <span className="sidebar-search-result-title">{group.chatTitle}</span>
                      <span className="sidebar-search-result-sep">·</span>
                      <span className="sidebar-search-result-time">{timeAgo(group.chatUpdatedAt)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </>
        ) : (
          /* ── Normal grouped chat list ── */
          <>
            {GROUP_ORDER.map((status) => {
              const items = grouped.groups.get(status) ?? [];
              if (items.length === 0) return null;
              return (
                <div key={status} className="chat-group">
                  <div className="chat-group-label">{GROUP_LABEL[status]}</div>
                  <ChatItemsByRecency
                    items={items}
                    activeChatId={activeChatId}
                    onSelect={onSelect}
                    onToggleFinished={onToggleFinished}
                    onDelete={onDelete}
                    chatDrafts={chatDrafts}
                  />
                </div>
              );
            })}
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
                {archiveOpen && (
                  <ChatItemsByRecency
                    items={grouped.archive}
                    activeChatId={activeChatId}
                    onSelect={onSelect}
                    onToggleFinished={onToggleFinished}
                    onDelete={onDelete}
                    chatDrafts={chatDrafts}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>

    </aside>
  );
}
