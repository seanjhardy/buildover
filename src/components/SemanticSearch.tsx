import { useCallback, useEffect, useRef, useState } from "react";
import { searchApi } from "../lib/api.js";
import type { SearchIndexStatus, SearchResult } from "../types.js";

interface Props {
  repoPath: string;
  onSelectChat: (chatId: string) => void;
  onClose: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Clamp score (0–1) to an orange-tinted opacity for the accent bar. */
function scoreColor(score: number): string {
  // Map [0.25, 1.0] → opacity [0.35, 1.0]
  const opacity = 0.35 + (score - 0.25) / 0.75 * 0.65;
  return `rgba(217, 119, 87, ${Math.min(1, Math.max(0.35, opacity))})`;
}

/** Truncate to ~200 chars at a word boundary. */
function excerpt(text: string, max = 200): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return text.slice(0, cut > 0 ? cut : max) + "…";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SemanticSearch({ repoPath, onSelectChat, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<SearchIndexStatus | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Warm up model + get initial index status
  useEffect(() => {
    searchApi.status(repoPath)
      .then((s) => setStatus(s))
      .catch(() => {});
  }, [repoPath]);

  // Close on Escape, navigate with arrows
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      }
      if (e.key === "Enter" && results[selectedIdx]) {
        handleSelect(results[selectedIdx]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [results, selectedIdx, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    const item = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const { results: r, status: s } = await searchApi.search(repoPath, q);
        setResults(r);
        setStatus(s);
        setSelectedIdx(0);
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, repoPath]);

  const handleSelect = useCallback((result: SearchResult) => {
    onSelectChat(result.chatId);
    onClose();
  }, [onSelectChat, onClose]);

  // ── Status bar text ──────────────────────────────────────────────────────────
  const statusBar = () => {
    if (status?.modelError) return `Model error: ${status.modelError}`;
    if (status?.isModelLoading) return "Loading embedding model…";
    if (status?.isIndexing) return `Indexing chats… ${status.indexed} / ${status.total}`;
    if (status && status.total > 0) return `${status.total} chat${status.total !== 1 ? "s" : ""} indexed`;
    return null;
  };

  const showEmpty = query.trim() && !isSearching && results.length === 0;
  const showHint = !query.trim();

  return (
    <div className="ss-backdrop" onClick={onClose}>
      <div className="ss-modal" onClick={(e) => e.stopPropagation()}>

        {/* Search input */}
        <div className="ss-input-row">
          <svg className="ss-input-icon" viewBox="0 0 20 20" fill="none">
            <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="ss-input"
            type="text"
            placeholder="Search all messages…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {isSearching && <span className="ss-spinner" />}
          <kbd className="ss-esc-hint" onClick={onClose}>esc</kbd>
        </div>

        {/* Status bar */}
        {statusBar() && (
          <div className="ss-status-bar">
            {(status?.isIndexing || status?.isModelLoading) && (
              <span className="ss-status-dot ss-status-dot--pulse" />
            )}
            {statusBar()}
          </div>
        )}

        {/* Divider */}
        <div className="ss-divider" />

        {/* Results */}
        <div className="ss-results" ref={listRef}>
          {showHint && (
            <div className="ss-hint">
              <svg viewBox="0 0 24 24" fill="none" className="ss-hint-icon">
                <path d="M9.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M14 3h7v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M21 3l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <div>
                <div className="ss-hint-title">Semantic message search</div>
                <div className="ss-hint-sub">Finds messages by meaning, not just keywords.<br />Try <em>"fix the auth bug"</em> or <em>"deploy to production"</em>.</div>
              </div>
            </div>
          )}

          {showEmpty && (
            <div className="ss-empty">
              No matching messages found
              {status?.isIndexing && <span className="ss-empty-sub"> — still indexing {status.total - status.indexed} chat{status.total - status.indexed !== 1 ? "s" : ""}</span>}
            </div>
          )}

          {results.map((r, i) => (
            <button
              key={`${r.chatId}:${r.eventIndex}`}
              type="button"
              className={`ss-result${i === selectedIdx ? " ss-result--selected" : ""}`}
              onClick={() => handleSelect(r)}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              {/* Score accent bar */}
              <div className="ss-result-bar" style={{ background: scoreColor(r.score) }} />

              <div className="ss-result-body">
                {/* Message text */}
                <div className="ss-result-text">{excerpt(r.messageText)}</div>

                {/* Footer: chat info + time */}
                <div className="ss-result-footer">
                  <svg className="ss-result-chat-icon" viewBox="0 0 16 16" fill="none">
                    <path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-3 2v-2H3a1 1 0 0 1-1-1V3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                  </svg>
                  <span className="ss-result-chat-title">{r.chatTitle}</span>
                  <span className="ss-result-sep">·</span>
                  <span className="ss-result-time">{timeAgo(r.chatUpdatedAt)}</span>
                  <span className="ss-result-score">{Math.round(r.score * 100)}% match</span>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Footer hint */}
        {results.length > 0 && (
          <div className="ss-footer">
            <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
            <span><kbd>↵</kbd> open chat</span>
            <span><kbd>esc</kbd> close</span>
          </div>
        )}
      </div>
    </div>
  );
}
