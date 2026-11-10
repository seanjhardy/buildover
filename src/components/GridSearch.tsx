import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { api } from "../lib/api.js";
import type { GridChatEntry, GridSearchHit } from "../lib/api.js";
import { repoColorVars, type RepoColor } from "./RepoChip.js";

const DEBOUNCE_MS = 160;

/** What the grid shows for a search: which windows matched, and the one
 *  being looked at. `hits` is null until the first answer arrives. */
export interface GridSearchView {
  query: string;
  hits: GridSearchHit[] | null;
  active: string | null;
}

interface Props {
  entries: GridChatEntry[];
  entryById: Map<string, GridChatEntry>;
  colorOf: (repoPath: string) => RepoColor;
  /** Bumped by each Cmd+F, to put the cursor back in the box. */
  focusToken: number;
  onChange: (view: GridSearchView) => void;
  /** Fly to a matching window. */
  onGo: (chatId: string) => void;
  onClose: () => void;
}

/** Cmd+F on the grid: a box that finds a phrase in every window's chat, with
 *  the matching chats listed under it. Enter (or the arrows) steps through
 *  them, flying to each; Escape closes it. */
export function GridSearch({ entries, entryById, colorOf, focusToken, onChange, onGo, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<GridSearchHit[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);
  const [failed, setFailed] = useState(false);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  // Ask again as the query changes and as the chats move on (the grid polls
  // its entries, so a new message shows up here within a few seconds).
  useEffect(() => {
    const q = query.trim();
    const seq = ++seqRef.current;
    if (!q) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .searchGrid(q)
        .then((found) => {
          if (seq !== seqRef.current) return;
          setFailed(false);
          setHits(found);
        })
        .catch(() => {
          // The server can't search (say it predates search): titles still can.
          if (seq !== seqRef.current) return;
          setFailed(true);
          setHits(titleHits(entriesRef.current, q));
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, entries]);

  // Only windows that are on the canvas count.
  const shown = (hits ?? []).filter((h) => entryById.has(h.chatId));
  const activeIdx = shown.findIndex((h) => h.chatId === active);

  useEffect(() => {
    onChange({ query: query.trim(), hits: hits && shown, active: activeIdx >= 0 ? active : null });
    // `shown` is derived from hits and entryById.
  }, [query, hits, entryById, active, onChange]);

  useEffect(() => {
    listRef.current?.querySelector(".gs-row--active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = (chatId: string) => {
    setActive(chatId);
    onGo(chatId);
  };
  const step = (by: 1 | -1) => {
    if (shown.length === 0) return;
    const i = activeIdx < 0 ? (by > 0 ? 0 : shown.length - 1) : (activeIdx + by + shown.length) % shown.length;
    go(shown[i].chatId);
  };

  const total = shown.reduce((n, h) => n + h.count, 0);
  const q = query.trim();
  const status = !q
    ? ""
    : hits === null
      ? "Searching…"
      : failed
        ? `${shown.length} title match${shown.length === 1 ? "" : "es"} · restart server to search messages`
        : shown.length === 0
          ? "No matches"
          : `${activeIdx >= 0 ? `${activeIdx + 1} of ` : ""}${shown.length} chat${shown.length === 1 ? "" : "s"} · ${total} match${total === 1 ? "" : "es"}`;

  return (
    <div className="gs" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="gs-bar">
        <Search size={14} className="gs-icon" />
        <input
          ref={inputRef}
          className="gs-input"
          placeholder="Search the grid's chats"
          value={query}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              step(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1);
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }
          }}
        />
        {status && <span className="gs-status">{status}</span>}
        <button
          type="button"
          className="gs-btn"
          title="Previous chat (Shift+Enter)"
          disabled={shown.length === 0}
          onClick={() => step(-1)}
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          className="gs-btn"
          title="Next chat (Enter)"
          disabled={shown.length === 0}
          onClick={() => step(1)}
        >
          <ChevronDown size={14} />
        </button>
        <button type="button" className="gs-btn" title="Close (Esc)" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {shown.length > 0 && (
        <div className="gs-list" ref={listRef}>
          {shown.map((h) => {
            const entry = entryById.get(h.chatId)!;
            const snip = h.snippets.find((s) => s.role !== "title");
            return (
              <button
                key={h.chatId}
                type="button"
                className={`gs-row${h.chatId === active ? " gs-row--active" : ""}`}
                style={repoColorVars(colorOf(entry.repoPath)) as React.CSSProperties}
                onClick={() => go(h.chatId)}
              >
                <span className="gs-row-head">
                  <span className="repo-dot" aria-hidden />
                  <span className="gs-row-repo">{entry.repoName}</span>
                  <span className="gs-row-title">{entry.chat.title || "New chat"}</span>
                  <span className="gs-row-count">{h.count}</span>
                </span>
                {snip && (
                  <span className="gs-row-snip">
                    <span className="gs-row-who">{snip.role === "user" ? "You" : "Agent"}</span>
                    {snip.text.slice(0, snip.start)}
                    <mark>{snip.text.slice(snip.start, snip.start + snip.length)}</mark>
                    {snip.text.slice(snip.start + snip.length)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Grid chats whose title holds `query`, when the server can't search. */
function titleHits(entries: GridChatEntry[], query: string): GridSearchHit[] {
  const q = query.replace(/\s+/g, " ").toLowerCase();
  const hits: GridSearchHit[] = [];
  for (const e of entries) {
    const title = (e.chat.title ?? "").replace(/\s+/g, " ");
    const at = title.toLowerCase().indexOf(q);
    if (at !== -1) hits.push({ chatId: e.chatId, count: 1, snippets: [{ role: "title", text: title, start: at, length: q.length }] });
  }
  return hits;
}

/** Over each window while searching: a ring and match count on the ones that
 *  matched, a dimming veil on the rest. */
export function GridSearchMarks({
  view,
  positions,
}: {
  view: GridSearchView | null;
  positions: Record<string, { c: number; r: number }>;
}) {
  if (!view?.query || !view.hits) return null;
  const counts = new Map(view.hits.map((h) => [h.chatId, h.count]));
  return (
    <>
      {Object.entries(positions).map(([id, p]) => {
        const count = counts.get(id);
        const style = { "--c": p.c, "--r": p.r } as React.CSSProperties;
        if (count == null) return <div key={id} className="gs-veil" style={style} aria-hidden />;
        return (
          <div
            key={id}
            className={`gs-hit${id === view.active ? " gs-hit--active" : ""}`}
            style={style}
            aria-hidden
          >
            <span className="gs-hit-count">{count}</span>
          </div>
        );
      })}
    </>
  );
}

const HL = "grid-search";
const HL_ACTIVE = "grid-search-active";

/** Paints the query's matches inside the matching windows (title and
 *  transcript) with the CSS Custom Highlight API, keeping up as messages
 *  stream in. Returns a function that scrolls a window's newest match into
 *  the middle of its transcript. */
export function useSearchHighlights(
  canvasRef: React.RefObject<HTMLElement | null>,
  view: GridSearchView | null,
): (chatId: string) => void {
  const rangesRef = useRef(new Map<string, Range[]>());
  const query = view?.query.toLowerCase() ?? "";
  const ids = view?.hits?.map((h) => h.chatId).join("\n") ?? "";
  const active = view?.active ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    rangesRef.current = new Map();
    if (!canvas || !registry || !query || !ids) return;
    const hitIds = ids.split("\n");

    const paint = () => {
      const all: Range[] = [];
      const current: Range[] = [];
      const byChat = new Map<string, Range[]>();
      for (const id of hitIds) {
        const card = canvas.querySelector(`[data-grid-card="${CSS.escape(id)}"]`);
        if (!card) continue;
        const ranges: Range[] = [];
        for (const root of card.querySelectorAll(".gc-head-name, .gc-card-body")) {
          const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let node = walk.nextNode(); node; node = walk.nextNode()) {
            const text = node.nodeValue?.toLowerCase() ?? "";
            for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) {
              const range = new Range();
              range.setStart(node, at);
              range.setEnd(node, at + query.length);
              ranges.push(range);
            }
          }
        }
        byChat.set(id, ranges);
        (id === active ? current : all).push(...ranges);
      }
      rangesRef.current = byChat;
      registry.set(HL, new Highlight(...all));
      registry.set(HL_ACTIVE, new Highlight(...current));
    };

    // Repaint as the transcripts change, at most a few times a second.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      timer ??= setTimeout(() => {
        timer = null;
        paint();
      }, 250);
    });
    observer.observe(canvas, { subtree: true, childList: true, characterData: true });
    paint();
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
      registry.delete(HL);
      registry.delete(HL_ACTIVE);
    };
  }, [canvasRef, query, ids, active]);

  return (chatId: string) => {
    const ranges = rangesRef.current.get(chatId) ?? [];
    const range = [...ranges].reverse().find((r) => r.startContainer.parentElement?.closest(".message-list"));
    const el = range?.startContainer.parentElement;
    const scroller = el?.closest<HTMLElement>(".message-list");
    if (!el || !scroller || scroller.clientHeight === 0) return;
    // The canvas is scaled, so screen distances are divided back to the
    // transcript's own pixels.
    const box = scroller.getBoundingClientRect();
    const scale = box.height / scroller.clientHeight || 1;
    const at = el.getBoundingClientRect();
    const delta = (at.top + at.height / 2 - (box.top + box.height / 2)) / scale;
    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: "smooth" });
  };
}
