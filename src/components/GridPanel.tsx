import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Check, GripVertical, MessageCircle, History, ChevronRight } from "lucide-react";
import {
  DndContext,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { api } from "../lib/api.js";
import type { GridChatEntry, RecentChatEntry } from "../lib/api.js";
import { useAgent } from "../hooks/useAgent.js";
import { MessageList } from "./MessageList.js";
import { MessageQueue } from "./MessageQueue.js";
import { AttentionPrompt, PermissionPrompt } from "./PermissionPrompt.js";
import { StatusIcon } from "./StatusIcon.js";
import { Composer } from "./Composer.js";
import { ChatBanners } from "./ChatBanners.js";
import { McpPanel } from "./McpPanel.js";
import { MasterPanel } from "./MasterPanel.js";
import { WarmPill } from "./WarmPill.js";
import { DEFAULT_MODEL, getModelProvider } from "../types.js";
import type {
  ChatStatus,
  EffortLevel,
  Model,
  ModelOption,
  PermissionMode,
  RecentRepoInfo,
  RepoInfo,
} from "../types.js";

// Two chats per column, always. Column width and the card floor live in CSS
// (--grid-cards-across / --grid-card-min on .grid-board) so they track the
// board's own width rather than anything measured here.
const ROWS = 2;
const POLL_MS = 3000;

/** App-wide Composer prefs (model list, effort, thinking, keep-warm window),
 *  owned by App and shared with every grid card's Composer. */
export interface GridChatSettings {
  availableModels: ModelOption[];
  onRefreshModels: () => void;
  thinkingSummaries: boolean;
  onThinkingSummariesChange: (enabled: boolean) => void;
  effort?: EffortLevel;
  onEffortChange: (level: EffortLevel) => void;
  /** Effective keep-warm window in hours (pref, or the default when unset). */
  keepWarmHours: number;
  /** A chat turned keep-warm on: seeds the window pref on first use. */
  onKeepWarmEnabled: () => void;
}

interface Props {
  openRepos: RepoInfo[];
  recents: RecentRepoInfo[];
  settings: GridChatSettings;
  onOpenChat: (repoPath: string, chatId: string) => void | Promise<void>;
}

/** A chat "needs attention" when it's waiting on the user or errored. */
function needsAttention(status: ChatStatus): boolean {
  return status === "awaiting_input" || status === "agent_done" || status === "error";
}

export function GridPanel({ openRepos, recents, settings, onOpenChat }: Props) {
  const [entries, setEntries] = useState<GridChatEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // "Recent chats" flyout beside the "+" menu; null until first fetched.
  const [recentOpen, setRecentOpen] = useState(false);
  const [recentChats, setRecentChats] = useState<RecentChatEntry[] | null>(null);
  // Keyboard focus ring (arrow keys move it) and which cards have their
  // composer open. Both live here so the board can drive them from keys.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openComposers, setOpenComposers] = useState<ReadonlySet<string>>(() => new Set());
  const boardRef = useRef<HTMLDivElement | null>(null);
  const setComposerOpen = useCallback((chatId: string, open: boolean) => {
    setOpenComposers((prev) => {
      if (prev.has(chatId) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(chatId);
      else next.delete(chatId);
      return next;
    });
  }, []);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const refresh = useCallback(async () => {
    // Don't let a poll reorder cards out from under an in-progress drag.
    if (draggingRef.current) return;
    try {
      const next = await api.listGrid();
      if (draggingRef.current) return;
      setEntries(next);
    } catch {
      // Transient (e.g. server restart) — keep showing the last good list.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Closing the "+" menu also closes its "Recent chats" flyout.
  useEffect(() => {
    if (!menuOpen) setRecentOpen(false);
  }, [menuOpen]);

  // Refetch recent chats each time the flyout opens (keep the last list shown
  // meanwhile so reopening doesn't flash empty).
  useEffect(() => {
    if (!recentOpen) return;
    let cancelled = false;
    api
      .listRecentChats()
      .then((chats) => {
        if (!cancelled) setRecentChats(chats);
      })
      .catch(() => {
        if (!cancelled) setRecentChats((prev) => prev ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [recentOpen]);

  // Close the "+" menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const createIn = useCallback(
    async (repoPath: string) => {
      setMenuOpen(false);
      setCreating(true);
      try {
        const res = await api.createGridChat({
          repoPath,
          model: DEFAULT_MODEL,
          permissionMode: storedPermissionMode(),
        });
        setEntries(res.entries);
      } catch {
        void refresh();
      } finally {
        setCreating(false);
      }
    },
    [refresh],
  );

  const addRecent = useCallback(
    async (recent: RecentChatEntry) => {
      setMenuOpen(false);
      try {
        setEntries(await api.addToGrid(recent.chat.id, recent.repoPath));
      } catch {
        void refresh();
      }
    },
    [refresh],
  );

  const gridChatIds = useMemo(() => new Set(entries.map((e) => e.chatId)), [entries]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Dropping one card on another *swaps* the two: every other card stays put,
  // so a drag never reshuffles the whole board.
  const onDragEnd = useCallback((event: DragEndEvent) => {
    draggingRef.current = false;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setEntries((prev) => {
      const from = prev.findIndex((e) => e.chatId === active.id);
      const to = prev.findIndex((e) => e.chatId === over.id);
      if (from < 0 || to < 0) return prev;
      const next = prev.slice();
      [next[from], next[to]] = [next[to], next[from]];
      void api.reorderGrid(next.map((e) => e.chatId)).catch(() => undefined);
      return next;
    });
  }, []);

  const markDone = useCallback(async (entry: GridChatEntry) => {
    try {
      const next = await api.removeFromGrid(entry.chatId, entry.repoPath, true);
      setEntries(next);
    } catch {
      /* ignore */
    }
  }, []);

  // Two rows tall, growing sideways: chats pair up into columns and the board
  // scrolls by the column. Filling column-major (not across the top row) is
  // what keeps the layout stable — a new chat appends to the end instead of
  // re-flowing every card into a wider row.
  const n = entries.length;
  const columns = useMemo(() => {
    const out: GridChatEntry[][] = [];
    for (let i = 0; i < entries.length; i += ROWS) out.push(entries.slice(i, i + ROWS));
    return out;
  }, [entries]);
  // The last entry renders in the rightmost cell, which sits under the
  // floating orchestrator mic FAB — its composer send button needs to dodge it.
  const cornerId = entries.length > 0 ? entries[entries.length - 1].chatId : null;

  // Arrow keys move the selection to the nearest card in that direction
  // (measured from the DOM, so the uneven last row just works), Enter opens the
  // selected card's message box and Escape closes it. Keys typed into an input
  // are left alone; the composer handles its own Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return;
      }
      const board = boardRef.current;
      if (!board) return;

      const dir = ARROW_DIRS[e.key];
      if (dir) {
        e.preventDefault();
        const cards = Array.from(board.querySelectorAll<HTMLElement>("[data-grid-card]"));
        if (cards.length === 0) return;
        const current = cards.find((c) => c.dataset.gridCard === selectedId);
        const next = current ? nearestCard(current, cards, dir) : cards[0];
        if (!next) return;
        // Drop focus from whatever was clicked last (a card control, or the
        // sidebar / Grid button used to get here) so Enter acts on the grid.
        if (target && target !== document.body) target.blur();
        setSelectedId(next.dataset.gridCard ?? null);
        next.scrollIntoView({ block: "nearest", inline: "nearest" });
        return;
      }

      if (!selectedId) return;
      if (e.key === "Enter") {
        // Only a focused control *inside a card* (title, done, prompt buttons)
        // keeps its own Enter. Anything else focused — e.g. the Grid toggle or
        // sidebar chat button clicked to get here — would otherwise be
        // "clicked" by Enter and navigate away; preventDefault stops that.
        const interactive = target?.closest("button, a, [role='button']");
        if (
          interactive &&
          board.contains(interactive) &&
          !interactive.classList.contains("grid-card-head")
        ) {
          return;
        }
        e.preventDefault();
        setComposerOpen(selectedId, true);
      } else if (e.key === "Escape" && openComposers.has(selectedId)) {
        e.preventDefault();
        setComposerOpen(selectedId, false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, openComposers, setComposerOpen]);

  // Is anything scrolled under the Master panel? Drives the edge fade, and so
  // it has to re-measure on scroll, on resize, and whenever the card count
  // changes — removing a card can clamp scrollLeft back to 0 silently.
  const [boardScrolled, setBoardScrolled] = useState(false);
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const measure = () => setBoardScrolled(el.scrollLeft > 0);
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [n]);

  const renderCard = (entry: GridChatEntry) => (
    <GridCard
      key={entry.chatId}
      entry={entry}
      settings={settings}
      onOpen={onOpenChat}
      onDone={markDone}
      isCorner={entry.chatId === cornerId}
      selected={entry.chatId === selectedId}
      onSelect={() => setSelectedId(entry.chatId)}
      composerOpen={openComposers.has(entry.chatId)}
      onComposerOpenChange={(open) => setComposerOpen(entry.chatId, open)}
    />
  );

  const repoOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { path: string; name: string }[] = [];
    for (const r of openRepos) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      opts.push({ path: r.path, name: r.name });
    }
    for (const r of recents) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      opts.push({ path: r.path, name: r.name });
    }
    return opts;
  }, [openRepos, recents]);

  return (
    <div className="grid-layout">
      <MasterPanel settings={settings} />
      <div className="grid-page">
        <header className="grid-page-header">
          <h2 className="grid-page-title">Grid</h2>
          <div className="grid-page-actions" ref={menuRef}>
            <button
              type="button"
              className="grid-new-btn"
              onClick={() => setMenuOpen((v) => !v)}
              disabled={creating}
              title="New grid chat"
            >
              <Plus size={16} />
              <span>New chat</span>
            </button>
            {menuOpen && (
              <div className="grid-new-menus">
                <div className="grid-new-menu">
                  <button
                    type="button"
                    className={`grid-new-menu-item grid-new-menu-recent${recentOpen ? " active" : ""}`}
                    onClick={() => setRecentOpen((v) => !v)}
                    aria-expanded={recentOpen}
                  >
                    <History size={13} />
                    <span>Recent chats</span>
                    <ChevronRight size={13} className="grid-new-menu-chevron" />
                  </button>
                  <div className="grid-new-menu-divider" />
                  <div className="grid-new-menu-label">Start a chat in…</div>
                  {repoOptions.length === 0 ? (
                    <div className="grid-new-menu-empty">No repos open or recent.</div>
                  ) : (
                    repoOptions.map((r) => (
                      <button
                        key={r.path}
                        type="button"
                        className="grid-new-menu-item"
                        onClick={() => void createIn(r.path)}
                        title={r.path}
                      >
                        {r.name}
                      </button>
                    ))
                  )}
                </div>
                {recentOpen && (
                  <div className="grid-new-menu grid-recent-menu">
                    <div className="grid-new-menu-label">Recent chats</div>
                    {recentChats === null ? (
                      <div className="grid-new-menu-empty">Loading…</div>
                    ) : recentChats.length === 0 ? (
                      <div className="grid-new-menu-empty">No recent chats.</div>
                    ) : (
                      recentChats.map((r) => {
                        const onGrid = gridChatIds.has(r.chat.id);
                        return (
                          <button
                            key={`${r.repoPath}:${r.chat.id}`}
                            type="button"
                            className="grid-new-menu-item grid-recent-item"
                            onClick={() => void addRecent(r)}
                            disabled={onGrid}
                            title={onGrid ? "Already on the grid" : `Add to grid — ${r.repoPath}`}
                          >
                            <span className="grid-recent-text">
                              <span className="grid-recent-repo">{r.repoName}</span>
                              <span className="grid-recent-title">{r.chat.title || "New chat"}</span>
                            </span>
                            {onGrid ? (
                              <Check size={13} className="grid-recent-meta" />
                            ) : (
                              <span className="grid-recent-meta">{timeAgo(r.chat.updatedAt)}</span>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        {loading ? (
          <div className="grid-empty">Loading…</div>
        ) : n === 0 ? (
          <div className="grid-empty">
            No grid chats yet. Use <strong>New chat</strong> to start one — it stays here until you
            mark it done, and also appears in its repo.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            // Swap target = the card under the pointer, not the nearest centre.
            collisionDetection={pointerWithin}
            onDragStart={() => {
              draggingRef.current = true;
            }}
            onDragCancel={() => {
              draggingRef.current = false;
            }}
            onDragEnd={onDragEnd}
          >
            <div className={`grid-board-wrap${boardScrolled ? " grid-board-wrap--scrolled" : ""}`}>
              <div className="grid-board" ref={boardRef}>
                {columns.map((column) => (
                  <div className="grid-column" key={column[0].chatId}>
                    {column.map(renderCard)}
                    {/* Odd count: hold the empty lower slot so the rows stay
                        level. A lone chat is the exception — it gets the whole
                        board rather than half of it. */}
                    {column.length < ROWS && n > 1 && <div className="grid-slot-empty" />}
                  </div>
                ))}
              </div>
              {/* Cards dissolving under the Master panel's edge. */}
              <div className="grid-board-fade" />
            </div>
          </DndContext>
        )}
      </div>
    </div>
  );
}

type ArrowDir = "left" | "right" | "up" | "down";
const ARROW_DIRS: Record<string, ArrowDir | undefined> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** The card closest to `from` in direction `dir`, by centre points: distance
 *  along the direction plus a heavier penalty for drifting sideways, so moving
 *  right stays in the row and moving down picks the nearest column. */
function nearestCard(from: HTMLElement, cards: HTMLElement[], dir: ArrowDir): HTMLElement | null {
  const centre = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const a = centre(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const card of cards) {
    if (card === from) continue;
    const b = centre(card);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) continue;
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = card;
    }
  }
  return best;
}

// Same key + fallback as App's global permission-mode pref, so grid chats run
// in the mode the user picked rather than silently downgrading to "Ask".
const PERMISSION_MODE_STORAGE_KEY = "buildover.permissionMode";
// Mirrors App: these tools are user checkpoints and always show their prompt,
// even in bypass mode.
const ALWAYS_PROMPT_TOOLS = new Set(["ExitPlanMode", "RequestUserAttention", "AskUserQuestion"]);

function storedPermissionMode(): PermissionMode {
  try {
    const v = localStorage.getItem(PERMISSION_MODE_STORAGE_KEY);
    if (v === "default" || v === "acceptEdits" || v === "plan" || v === "bypassPermissions") {
      return v;
    }
  } catch {
    /* ignore */
  }
  return "bypassPermissions";
}

interface CardProps {
  entry: GridChatEntry;
  settings: GridChatSettings;
  onOpen: (repoPath: string, chatId: string) => void | Promise<void>;
  onDone: (entry: GridChatEntry) => void;
  /** Bottom-right card: its composer must dodge the floating mic FAB. */
  isCorner?: boolean;
  /** Keyboard selection ring. */
  selected: boolean;
  onSelect: () => void;
  composerOpen: boolean;
  onComposerOpenChange: (open: boolean) => void;
}

/** A grid card is a live view into a normal buildover chat: same transcript,
 *  banners, prompts, queue and Composer as the full chat view. */
function GridCard({
  entry,
  settings,
  onOpen,
  onDone,
  isCorner,
  selected,
  onSelect,
  composerOpen,
  onComposerOpenChange: setComposerOpen,
}: CardProps) {
  const { chat } = entry;
  const agent = useAgent(entry.repoPath, entry.chatId);
  // Prefer the live session status over the polled summary, which lags.
  const status = agent.status ?? chat.status;
  const attention = needsAttention(status);
  const prompt = agent.pendingAttention ?? agent.pendingPermission;

  // Per-chat settings, mirroring how App drives the full Composer.
  const [model, setModel] = useState<Model>(chat.model ?? DEFAULT_MODEL);
  useEffect(() => {
    if (chat.model) setModel(chat.model);
  }, [chat.model]);
  const handleModelChange = useCallback(
    (next: string) => {
      setModel(next);
      void api.patchChat(entry.repoPath, entry.chatId, { model: next }).catch(() => undefined);
    },
    [entry.repoPath, entry.chatId],
  );

  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => agent.chatPermissionMode ?? storedPermissionMode(),
  );
  useEffect(() => {
    if (agent.chatPermissionMode != null) setPermissionMode(agent.chatPermissionMode);
  }, [agent.chatPermissionMode]);

  const [context1m, setContext1m] = useState(false);
  useEffect(() => {
    setContext1m(agent.chatContext1m ?? false);
  }, [agent.chatContext1m]);
  const handleContext1mChange = useCallback(
    (enabled: boolean) => {
      setContext1m(enabled);
      void api
        .patchChat(entry.repoPath, entry.chatId, { context1m: enabled })
        .catch(() => undefined);
    },
    [entry.repoPath, entry.chatId],
  );

  const { setKeepWarm } = agent;
  const keepWarm = agent.meta.keepWarm;
  const { onKeepWarmEnabled } = settings;
  const handleToggleKeepWarm = useCallback(() => {
    const next = !keepWarm;
    if (next) onKeepWarmEnabled();
    setKeepWarm(next);
  }, [keepWarm, setKeepWarm, onKeepWarmEnabled]);
  const hasPromptCache = getModelProvider(model) === "claude";

  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const handleHandoff = useCallback(async () => {
    if (handoffBusy) return;
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      const { chat: next } = await api.handoffChat(entry.repoPath, entry.chatId);
      void onOpen(entry.repoPath, next.id);
    } catch (err) {
      setHandoffError(err instanceof Error ? err.message : String(err));
    } finally {
      setHandoffBusy(false);
    }
  }, [handoffBusy, entry.repoPath, entry.chatId, onOpen]);

  const chatStartedAt = (() => {
    for (const t of agent.turns) if (t.kind === "user" && t.ts) return t.ts;
    return undefined;
  })();
  const lastApiAtMs = (() => {
    const iso = agent.meta.cost?.lastApiAt ?? chat.lastApiAt ?? chat.updatedAt;
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : undefined;
  })();

  // Bypass mode auto-approves ordinary tool permissions, same as App does for
  // the open chat — otherwise a grid chat would sit blocked on a prompt.
  const { pendingPermission, respondPermission } = agent;
  useEffect(() => {
    if (permissionMode !== "bypassPermissions") return;
    if (!pendingPermission) return;
    if (ALWAYS_PROMPT_TOOLS.has(pendingPermission.toolName)) return;
    respondPermission(pendingPermission.requestId, { behavior: "allow" });
  }, [permissionMode, pendingPermission, respondPermission]);

  // Collapsed chat bubble ↔ expanded Composer. The Composer stays mounted while
  // collapsed so its draft, attachments and menus survive toggling.
  const dockRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);

  // When the composer opens, focus it and drop the caret at the end of any
  // existing draft. If a question / permission prompt has replaced the
  // composer, focus that instead so it can be answered from the keyboard.
  useEffect(() => {
    if (!composerOpen) return;
    const promptEl = dockRef.current?.querySelector<HTMLElement>(".permission");
    if (promptEl) {
      promptEl.focus();
      return;
    }
    const el = composerRef.current?.querySelector<HTMLTextAreaElement>("textarea.composer-input");
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [composerOpen]);

  // Plain draggable + droppable (not sortable): the card follows the pointer
  // and the card it is dropped on swaps places with it. Nothing else moves.
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({ id: entry.chatId });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: entry.chatId });
  const setNodeRef = useCallback(
    (el: HTMLElement | null) => {
      setDragRef(el);
      setDropRef(el);
    },
    [setDragRef, setDropRef],
  );

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    zIndex: isDragging ? 5 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-grid-card={entry.chatId}
      className={`grid-card${attention ? " grid-card--attention" : ""}${selected ? " grid-card--selected" : ""}${isDragging ? " grid-card--dragging" : ""}${isOver && !isDragging ? " grid-card--swap-target" : ""}`}
      onClickCapture={onSelect}
      onClick={() => {
        // Clicking anywhere on the card dismisses an open composer; only the
        // title opens the chat.
        if (composerOpen) setComposerOpen(false);
      }}
    >
      <div className="grid-card-head" {...attributes} {...listeners}>
        <span className="grid-card-grip" title="Drag onto another card to swap places">
          <GripVertical size={14} />
        </span>
        <span className="grid-card-status">
          <StatusIcon status={status} />
        </span>
        <span
          className="grid-card-title"
          title={chat.title}
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            void onOpen(entry.repoPath, entry.chatId);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void onOpen(entry.repoPath, entry.chatId);
            }
          }}
        >
          {chat.title || "New chat"}
        </span>
        <WarmPill
          lastApiAtMs={lastApiAtMs}
          keepWarm={!!keepWarm}
          keepWarmHours={settings.keepWarmHours}
          onToggle={hasPromptCache ? handleToggleKeepWarm : undefined}
        />
        <button
          type="button"
          className="grid-card-done"
          title="Mark done (remove from grid)"
          onClick={(e) => {
            e.stopPropagation();
            onDone(entry);
          }}
        >
          <Check size={14} />
        </button>
      </div>
      <div className="grid-card-repo">{entry.repoName}</div>
      <div className="grid-card-body">
        <MessageList
          turns={agent.turns}
          isStreaming={agent.isStreaming}
          historyReady={agent.historyReady}
          cwd={agent.cwd ?? entry.repoPath}
          branchInfo={agent.branchInfo}
          onForkMessage={(userMessageId, newText, attachments) =>
            agent.forkMessage(userMessageId, newText, attachments, {
              model,
              permissionMode,
            })
          }
          onSwitchBranch={agent.switchBranch}
          onRevert={agent.revertToCheckpoint}
          chatId={entry.chatId}
          chatKind={entry.chat.kind}
        />
      </div>

      <div className="grid-card-dock" ref={dockRef} onClick={(e) => e.stopPropagation()}>
        <ChatBanners
          chatId={entry.chatId}
          model={model}
          contextTokens={agent.contextUsage?.usedTokens ?? 0}
          lastApiAtMs={lastApiAtMs}
          busy={agent.isStreaming || agent.status === "running" || agent.status === "queued"}
          notice={agent.notice}
          slotQueue={agent.slotQueue}
          handoffTo={agent.meta.handoffTo}
          onOpenChat={(id) => void onOpen(entry.repoPath, id)}
          keepWarm={keepWarm}
          keepWarmHours={settings.keepWarmHours}
          onToggleKeepWarm={hasPromptCache ? handleToggleKeepWarm : undefined}
          onHandoff={() => void handleHandoff()}
          handoffBusy={handoffBusy}
          handoffError={handoffError}
        />
        {agent.pendingAttention && (
          <AttentionPrompt pending={agent.pendingAttention} onRespond={agent.respondAttention} />
        )}
        {agent.pendingPermission && !agent.pendingAttention && (
          <PermissionPrompt pending={agent.pendingPermission} onRespond={agent.respondPermission} />
        )}
        <div
          ref={composerRef}
          className={`composer-dock grid-card-composer${isCorner ? " grid-card-composer--corner" : ""}`}
          style={{ display: prompt ? "none" : undefined }}
          onKeyDown={(e) => {
            if (
              e.key === "Escape" &&
              (e.target as HTMLElement).classList.contains("composer-input")
            ) {
              setComposerOpen(false);
            }
          }}
        >
          <MessageQueue
            queue={agent.messageQueue}
            usageQueuedTurns={agent.queuedTurns}
            paused={agent.queuePaused}
            onTogglePause={agent.toggleQueuePaused}
            onRemove={agent.removeQueued}
            onFastTrack={agent.fastTrackQueued}
            onSteer={agent.steerQueued}
            onReorder={agent.reorderQueue}
          />
          <div
            className={`grid-card-composer-slot${composerOpen ? "" : " grid-card-composer-slot--hidden"}`}
          >
            <Composer
              chatId={entry.chatId}
              // Collapse back to the hover button once a message is sent.
              onSend={(text, attachments) => {
                agent.send(text, { model, permissionMode, attachments });
                setComposerOpen(false);
              }}
              onQueuePaused={(text, attachments) => {
                agent.enqueuePaused(text, {
                  model,
                  permissionMode,
                  attachments,
                });
                setComposerOpen(false);
              }}
              onInterrupt={agent.interrupt}
              disabled={agent.connection !== "connected"}
              isStreaming={agent.isStreaming}
              model={model}
              permissionMode={permissionMode}
              onPermissionModeChange={(m) => {
                setPermissionMode(m);
                agent.setPermissionMode(m);
              }}
              onModelChange={handleModelChange}
              availableModels={settings.availableModels}
              onRefreshModels={settings.onRefreshModels}
              onToggleMcp={() => setMcpOpen((v) => !v)}
              contextUsage={agent.contextUsage}
              repoPath={entry.repoPath}
              sdkSlashCommands={agent.slashCommands}
              context1m={context1m}
              onContext1mChange={handleContext1mChange}
              thinkingSummaries={settings.thinkingSummaries}
              onThinkingSummariesChange={settings.onThinkingSummariesChange}
              effort={settings.effort}
              onEffortChange={settings.onEffortChange}
              chatCost={agent.meta.cost}
              chatStartedAt={chatStartedAt}
              keepWarm={keepWarm}
              keepWarmHours={settings.keepWarmHours}
              onToggleKeepWarm={hasPromptCache ? handleToggleKeepWarm : undefined}
              prefill={agent.turns.length === 0 ? agent.meta.handoffPrefill : null}
              simplified
            />
          </div>
        </div>
      </div>

      {!prompt && !composerOpen && (
        <button
          type="button"
          className="grid-card-bubble"
          title="Message this agent"
          onClick={(e) => {
            e.stopPropagation();
            setComposerOpen(true);
          }}
        >
          <MessageCircle size={15} />
          <span>Message</span>
        </button>
      )}

      {/* The card is transformed by dnd-kit, which would trap a fixed overlay,
          so the MCP panel portals out to <body>. */}
      {mcpOpen &&
        createPortal(
          <McpPanel
            tools={agent.tools}
            mcpServers={agent.mcpServers}
            cwd={agent.cwd}
            onClose={() => setMcpOpen(false)}
          />,
          document.body,
        )}
    </div>
  );
}

/** Compact "time since" label for the recent chats list: now, 5m, 3h, 2d. */
function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
