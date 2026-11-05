import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Plus,
  Check,
  MessageCircle,
  History,
  ChevronRight,
  ArrowUpRight,
  Focus,
  Maximize,
  LayoutGrid,
  Bot,
  PanelTop,
  MessageSquare,
} from "lucide-react";
import { api } from "../lib/api.js";
import type { GridChatEntry, RecentChatEntry } from "../lib/api.js";
import { useAgent, type ChatTurn } from "../hooks/useAgent.js";
import { useSubagents } from "../hooks/useSubagents.js";
import { MessageList } from "./MessageList.js";
import { FrontPage } from "./FrontPage.js";
import { useFrontPage } from "../hooks/useFrontPage.js";
import { hasFrontPage } from "../lib/frontPage.js";
import { MessageQueue } from "./MessageQueue.js";
import { AttentionPrompt, PermissionPrompt } from "./PermissionPrompt.js";
import { StatusIcon } from "./StatusIcon.js";
import { assignRepoColors, repoColor, repoColorVars, type RepoColor } from "./RepoChip.js";
import { Composer } from "./Composer.js";
import { ChatBanners } from "./ChatBanners.js";
import { McpPanel } from "./McpPanel.js";
import { MasterButton } from "./MasterPanel.js";
import { WarmPill } from "./WarmPill.js";
import { GridQueue, timeAgo, type QueueItem } from "./GridQueue.js";
import { GridSubagents, gridSubagents } from "./GridSubagents.js";
import { GridPipelineCard, pipelineCardId } from "./GridPipelineCard.js";
import {
  FADE_SCALE,
  FAR_SCALE,
  INTERACTIVE_SCALE,
  MAX_CELL_H,
  MAX_CELL_W,
  MAX_SCALE,
  MIN_CELL_H,
  MIN_CELL_W,
  MIN_SCALE,
  arrange,
  bounds,
  clamp,
  fillets,
  key as cellKey,
  loadLayout,
  nearestFreeOffset,
  neighbourIn,
  occupancy,
  placeNew,
  repoGroups,
  saveLayout,
  sidesOf,
  windowsTouching,
  type CanvasLayout,
  type Cell,
  type Dir,
  type RepoGroup,
  type View,
} from "../lib/gridCanvas.js";
import { createValueStore, useStoreValue, type ValueStore } from "../lib/valueStore.js";
import { DEFAULT_MODEL, getModelProvider } from "../types.js";
import type {
  ChatStatus,
  EffortLevel,
  Model,
  ModelOption,
  PermissionMode,
  PipelinesView,
  RecentRepoInfo,
  RepoInfo,
} from "../types.js";

const POLL_MS = 3000;
const PIPELINES_POLL_MS = 10_000;
const NO_PIPELINES: PipelinesView = { sources: [], budget: { spentUsd: 0, capUsd: null, warnAt: 1 }, nextSweep: "" };
/** Pointer travel before a press becomes a pan or a drag (so clicks and
 *  double-clicks still work). */
const DRAG_SLOP_PX = 4;
/** How close (in cells) a dragged window must come to a free slot before it
 *  is pulled onto it. */
const MAGNET_CELLS = 0.24;

/** App-wide Composer prefs (model list, effort, thinking, keep-warm window),
 *  owned by App and shared with every grid window's Composer. */
export interface GridChatSettings {
  availableModels: ModelOption[];
  onRefreshModels: () => void;
  thinkingSummaries: boolean;
  onThinkingSummariesChange: (enabled: boolean) => void;
  effort?: EffortLevel;
  onEffortChange: (level: EffortLevel) => void;
}

interface Props {
  openRepos: RepoInfo[];
  recents: RecentRepoInfo[];
  settings: GridChatSettings;
  onOpenChat: (repoPath: string, chatId: string) => void | Promise<void>;
}

/** A chat "needs attention" when it's waiting on the user or errored. */
export function needsAttention(status: ChatStatus): boolean {
  return status === "awaiting_input" || status === "agent_done" || status === "error";
}

/** What a window's far-out tile says while it needs you. Its title bar says
 *  the same, except for "Finished": a finished chat keeps its plain tick. */
const ATTENTION_LABEL: Partial<Record<ChatStatus, string>> = {
  awaiting_input: "Needs input",
  agent_done: "Finished",
  error: "Error",
};

/** The cell a dragged window will land on, drawn as a faint outline. */
type Ghost = Cell[] | null;

/** Where a chat stands, as its window reports it to the queue. */
interface ChatReport {
  status: ChatStatus;
  /** What it's asking, or the last thing it said; only kept while it needs you. */
  summary: string;
}

/** Queue order: questions first (an agent is blocked on them), then errors,
 *  then finished chats. */
const QUEUE_RANK: Partial<Record<ChatStatus, number>> = {
  awaiting_input: 0,
  error: 1,
  agent_done: 2,
};

const ARROW_DIRS: Record<string, Dir | undefined> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** Controls that keep their own pointer and keyboard behaviour inside a window. */
const CONTROL_SELECTOR = "button, a, input, textarea, select, [contenteditable='true'], .warm-pill";

const NO_SELECTION: ReadonlySet<string> = new Set();

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Keep the click that ends a drag from landing on whatever is under it. */
function swallowNextClick() {
  const swallow = (ce: MouseEvent) => {
    ce.stopPropagation();
    ce.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/** Windows lifted off the board for a drag, and how to set them back down. */
interface Lifted {
  cards: HTMLElement[];
  land: () => void;
}

/** The classes that join a window on each side, and the step to that side. */
const SIDE_CLASSES: [string, number, number][] = [
  ["gc-n", 0, -1],
  ["gc-e", 1, 0],
  ["gc-s", 0, 1],
  ["gc-w", -1, 0],
];

/** Lift `group` off the board for a drag: where it parts from the windows it
 *  leaves behind, both sides round their corners and close their edges, and
 *  the inner corners beside it hide until it lands. `land` undoes all that. */
function lift(canvas: HTMLElement, group: string[], positions: Record<string, Cell>): Lifted {
  const inGroup = new Set(group);
  const occ = occupancy(positions);
  const cards: HTMLElement[] = [];
  const undo: (() => void)[] = [];
  for (const el of canvas.querySelectorAll<HTMLElement>(":scope > .gc-card")) {
    const id = el.dataset.gridCard ?? "";
    const p = positions[id];
    if (!p) continue;
    const moving = inGroup.has(id);
    if (moving) {
      cards.push(el);
      el.classList.add("gc-card--dragging");
    }
    for (const [cls, dc, dr] of SIDE_CLASSES) {
      const n = occ.get(cellKey(p.c + dc, p.r + dr));
      if (n == null || inGroup.has(n) === moving || !el.classList.contains(cls)) continue;
      el.classList.remove(cls);
      undo.push(() => el.classList.add(cls));
    }
  }
  for (const el of canvas.querySelectorAll<HTMLElement>(":scope > .gc-fillet")) {
    const [x, y] = (el.dataset.at ?? "").split(",").map(Number);
    const around = [cellKey(x - 1, y - 1), cellKey(x, y - 1), cellKey(x - 1, y), cellKey(x, y)];
    if (!around.some((k) => inGroup.has(occ.get(k) ?? ""))) continue;
    el.style.visibility = "hidden";
    undo.push(() => el.style.removeProperty("visibility"));
  }
  return {
    cards,
    land: () => {
      for (const el of cards) el.classList.remove("gc-card--dragging");
      for (const fn of undo) fn();
    },
  };
}

/** `next`, keeping the previous object for every entry that hasn't changed (and
 *  the previous array when nothing has), so a poll only re-renders the windows
 *  it actually touched. */
function reuseEntries(prev: GridChatEntry[], next: GridChatEntry[]): GridChatEntry[] {
  const old = new Map(prev.map((e) => [e.chatId, e]));
  let same = prev.length === next.length;
  const out = next.map((e, i) => {
    const o = old.get(e.chatId);
    if (o && JSON.stringify(o) === JSON.stringify(e)) {
      if (prev[i] !== o) same = false;
      return o;
    }
    same = false;
    return e;
  });
  return same ? prev : out;
}

/**
 * The Grid page: an infinite canvas of chat windows. Pan with the trackpad (or
 * a wheel-button drag), pinch to zoom. Click a window to focus it: arrow keys
 * then move between windows, Enter starts typing, and the focused window's
 * title bar drags it. Drag across empty board to select every window the box
 * touches, or Shift/⌘-click windows in and out of the selection; dragging a
 * window moves it (or, if selected, the whole selection), and a plain click
 * clears the selection.
 * Windows snap onto a shared grid and join into one shape where they touch.
 * Zoomed far out, each window shows its repo colour and title instead of its
 * transcript. The column on the right lists every chat that is waiting on the
 * user.
 */
export function GridPanel({ openRepos, recents, settings, onOpenChat }: Props) {
  const [entries, setEntries] = useState<GridChatEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // "Recent chats" flyout beside the "+" menu; null until first fetched.
  const [recentOpen, setRecentOpen] = useState(false);
  const [recentChats, setRecentChats] = useState<RecentChatEntry[] | null>(null);
  const [openComposers, setOpenComposers] = useState<ReadonlySet<string>>(() => new Set());
  const setComposerOpen = useCallback((chatId: string, open: boolean) => {
    setOpenComposers((prev) => {
      if (prev.has(chatId) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(chatId);
      else next.delete(chatId);
      return next;
    });
  }, []);
  const openComposersRef = useRef(openComposers);
  openComposersRef.current = openComposers;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  /** Grid edits (new chat, add, done) in flight, and how many have started: a
   *  poll that overlaps one would undo it, or place its new chat before we
   *  know which cell it was asked for. */
  const editsRef = useRef({ active: 0, started: 0 });

  // The focused window: drawn with a bright ring, the target of Enter and the
  // arrow keys, and the only window whose title bar drags it.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedRef = useRef(focusedId);
  focusedRef.current = focusedId;
  // The selected windows, which move together when any of them is dragged. The
  // focused window is always one of them; the rest get a ring of their own.
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_SELECTION);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /** Focus `chatId` and select just it, or (null) clear both. */
  const selectOnly = useCallback((chatId: string | null) => {
    setFocusedId(chatId);
    setSelected((prev) =>
      chatId == null ? NO_SELECTION : prev.size === 1 && prev.has(chatId) ? prev : new Set([chatId]),
    );
  }, []);
  /** Shift/⌘-click: add `chatId` to the selection, or take it out (and, if it
   *  was focused, drop the focus). */
  const toggleSelected = useCallback((chatId: string) => {
    const next = new Set(selectedRef.current);
    if (next.delete(chatId)) {
      if (focusedRef.current === chatId) setFocusedId(null);
    } else {
      next.add(chatId);
    }
    setSelected(next);
  }, []);
  /** A chat just put on the grid, to fly to once it has a cell (and, if it's
   *  brand new, to open for typing). `cell` is where it was asked to go. */
  const pendingFocusRef = useRef<{ chatId: string; compose: boolean; cell?: Cell } | null>(null);

  // App passes these inline; pin them so the memoised windows don't all
  // re-render whenever App does.
  const onOpenChatRef = useRef(onOpenChat);
  onOpenChatRef.current = onOpenChat;
  const openChat = useCallback(
    (repoPath: string, chatId: string) => onOpenChatRef.current(repoPath, chatId),
    [],
  );
  const {
    availableModels,
    onRefreshModels,
    thinkingSummaries,
    onThinkingSummariesChange,
    effort,
    onEffortChange,
  } = settings;
  const cardSettings = useMemo<GridChatSettings>(
    () => ({
      availableModels,
      onRefreshModels,
      thinkingSummaries,
      onThinkingSummariesChange,
      effort,
      onEffortChange,
    }),
    [availableModels, onRefreshModels, thinkingSummaries, onThinkingSummariesChange, effort, onEffortChange],
  );

  // ── Layout + view ──
  const [layout, setLayout] = useState<CanvasLayout>(loadLayout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const viewStore = useMemo(
    () => createValueStore<View>(layoutRef.current.view ?? { x: 80, y: 80, scale: 0.8 }),
    [],
  );
  const ghostStore = useMemo(() => createValueStore<Ghost>(null), []);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dotsRef = useRef<HTMLDivElement | null>(null);
  const marqueeRef = useRef<HTMLDivElement | null>(null);
  const animRef = useRef<number | null>(null);
  /** View to return to after a double-click focus. */
  const prevViewRef = useRef<View | null>(null);

  const refresh = useCallback(async () => {
    // Don't let a poll move windows out from under an in-progress drag, or
    // land over a grid edit made while it was in flight.
    const edits = editsRef.current;
    if (draggingRef.current || edits.active > 0) return;
    const started = edits.started;
    try {
      const next = await api.listGrid();
      if (draggingRef.current || edits.started !== started) return;
      setEntries((prev) => reuseEntries(prev, next));
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

  /** Run a grid edit, keeping polls from landing over it. */
  const edit = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    const edits = editsRef.current;
    edits.active++;
    edits.started++;
    try {
      return await run();
    } finally {
      edits.active--;
    }
  }, []);

  /** Start a chat in `repoPath`, in `cell` if given (and still free), else
   *  beside the repo's other windows. */
  const createIn = useCallback(
    async (repoPath: string, cell?: Cell) => {
      setMenuOpen(false);
      setCreating(true);
      try {
        const res = await edit(() =>
          api.createGridChat({
            repoPath,
            model: DEFAULT_MODEL,
            permissionMode: storedPermissionMode(),
          }),
        );
        // Fly to it once it has a cell, ready to type in.
        pendingFocusRef.current = { chatId: res.entry.chatId, compose: true, cell };
        setEntries((prev) => reuseEntries(prev, res.entries));
      } catch {
        void refresh();
      } finally {
        setCreating(false);
      }
    },
    [edit, refresh],
  );

  const addRecent = useCallback(
    async (recent: RecentChatEntry) => {
      setMenuOpen(false);
      try {
        const next = await edit(() => api.addToGrid(recent.chat.id, recent.repoPath));
        pendingFocusRef.current = { chatId: recent.chat.id, compose: false };
        setEntries((prev) => reuseEntries(prev, next));
      } catch {
        void refresh();
      }
    },
    [edit, refresh],
  );

  const gridChatIds = useMemo(() => new Set(entries.map((e) => e.chatId)), [entries]);

  // Each pipeline is a window on the canvas too, beside the chats it starts.
  const [pipelines, setPipelines] = useState<PipelinesView | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getPipelines()
        .then((v) => alive && setPipelines(v))
        // Without pipelines the grid still settles which windows it has.
        .catch(() => alive && setPipelines((v) => v ?? NO_PIPELINES));
    void load();
    const timer = setInterval(load, PIPELINES_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const runPipeline = useCallback(async (id: string) => {
    try {
      setPipelines(await api.runPipeline(id));
    } catch {
      /* the next poll shows what happened */
    }
  }, []);
  const pipelineKey = (pipelines?.sources ?? []).map((s) => `${pipelineCardId(s.id)}\t${s.repoPath}`).join("\n");
  /** Every window's repo: chats' and pipelines'. */
  const repoById = useMemo(() => {
    const out = new Map(entries.map((e) => [e.chatId, e.repoPath]));
    for (const line of pipelineKey ? pipelineKey.split("\n") : []) {
      const [id, repoPath] = line.split("\t");
      out.set(id, repoPath);
    }
    return out;
  }, [entries, pipelineKey]);
  const pipelinesLoaded = pipelines !== null;

  const markDone = useCallback(
    async (entry: GridChatEntry) => {
      try {
        const next = await edit(() => api.removeFromGrid(entry.chatId, entry.repoPath, true));
        setEntries((prev) => reuseEntries(prev, next));
      } catch {
        /* ignore */
      }
    },
    [edit],
  );

  // Give new chats and pipelines a cell (the one asked for, if it's still
  // free, else one beside their repo's other windows), and forget cells of
  // ones that have left the grid.
  useEffect(() => {
    if (loading) return;
    const asked = pendingFocusRef.current;
    setLayout((prev) => {
      const positions: Record<string, Cell> = {};
      let changed = false;
      for (const [id, p] of Object.entries(prev.positions)) {
        if (repoById.has(id) || (!pipelinesLoaded && id.startsWith("pipeline:"))) positions[id] = p;
        else changed = true;
      }
      for (const e of entries) {
        if (positions[e.chatId]) continue;
        const want = asked?.chatId === e.chatId ? asked.cell : undefined;
        positions[e.chatId] =
          want && !occupancy(positions).has(cellKey(want.c, want.r))
            ? want
            : placeNew(positions, (id) => repoById.get(id), e.repoPath);
        changed = true;
      }
      for (const [id, repoPath] of repoById) {
        if (positions[id]) continue;
        positions[id] = placeNew(positions, (other) => repoById.get(other), repoPath);
        changed = true;
      }
      return changed ? { ...prev, positions } : prev;
    });
  }, [entries, repoById, pipelinesLoaded, loading]);

  useEffect(() => {
    saveLayout({ ...layout, view: viewStore.get() });
  }, [layout, viewStore]);

  // Pan/zoom is applied straight to the DOM, never through React state: it
  // changes every frame and the canvas holds a dozen live transcripts. Only the
  // few elements that size themselves by the zoom read --z (it's registered as
  // non-inheriting in CSS), so zooming doesn't restyle the transcripts.
  // Even so, a new --z re-rounds every window's clip and a new scale
  // re-rasterises the canvas, so every transcript would repaint each step. While
  // the scale moves, the canvas is held as one picture (gc-canvas--zooming) and
  // --z waits until it rests, except far out, where the transcripts are hidden.
  // The far-out look fades in with the zoom rather than switching on, so it
  // follows every step: --far (0 at FADE_SCALE, 1 by FAR_SCALE) and, while it
  // shows, --zl (the zoom, for the title's size). Only the label, edges and
  // corners read them, and the label fades on the compositor.
  useLayoutEffect(() => {
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let restTimer: ReturnType<typeof setTimeout> | undefined;
    let lastZ = NaN;
    let lastFar = NaN;
    let lastPitch = NaN;
    const rest = () => {
      const canvas = canvasRef.current;
      canvas?.style.setProperty("--z", String(viewStore.get().scale));
      canvas?.classList.remove("gc-canvas--zooming");
    };
    const apply = () => {
      const v = viewStore.get();
      const canvas = canvasRef.current;
      const dots = dotsRef.current;
      // Whole device pixels keep text and dots crisp.
      const dpr = window.devicePixelRatio || 1;
      const snap = (n: number) => Math.round(n * dpr) / dpr;
      const x = snap(v.x);
      const y = snap(v.y);
      if (canvas) {
        // A 3D translate keeps the canvas on its own compositor layer, so a pan
        // only moves pixels.
        canvas.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${v.scale})`;
        if (v.scale !== lastZ) {
          const first = Number.isNaN(lastZ);
          const far = v.scale < FAR_SCALE;
          // Even in log zoom, as the wheel and pinch zoom by ratios.
          const fade = clamp(Math.log(FADE_SCALE / v.scale) / Math.log(FADE_SCALE / FAR_SCALE), 0, 1);
          lastZ = v.scale;
          canvas.classList.toggle("gc-canvas--live", v.scale >= INTERACTIVE_SCALE);
          canvas.classList.toggle("gc-canvas--far", far);
          canvas.classList.toggle("gc-canvas--fading", fade > 0 && !far);
          if (fade !== lastFar) {
            lastFar = fade;
            canvas.style.setProperty("--far", String(fade));
          }
          if (fade > 0) canvas.style.setProperty("--zl", String(v.scale));
          clearTimeout(restTimer);
          if (first || far) {
            rest();
          } else {
            canvas.classList.add("gc-canvas--zooming");
            restTimer = setTimeout(rest, 150);
          }
        }
      }
      if (dots) {
        const pitch = 22 * v.scale;
        if (pitch !== lastPitch) {
          lastPitch = pitch;
          dots.style.backgroundSize = `${pitch}px ${pitch}px`;
        }
        // Slide by the offset into one pitch: the same dots, never repainted.
        const dx = snap((((x % pitch) + pitch) % pitch) - pitch);
        const dy = snap((((y % pitch) + pitch) % pitch) - pitch);
        dots.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveLayout({ ...layoutRef.current, view: v }), 400);
    };
    apply();
    const unsub = viewStore.subscribe(apply);
    return () => {
      unsub();
      clearTimeout(saveTimer);
      clearTimeout(restTimer);
      rest();
    };
  }, [viewStore, loading]);

  // Mark windows that are out of view (data-away) so CSS can pause their
  // spinners: off screen they'd tick on the main thread every frame.
  useEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) return;
    const io = new IntersectionObserver(
      (seen) => {
        for (const e of seen) e.target.toggleAttribute("data-away", !e.isIntersecting);
      },
      { root: viewport },
    );
    const watch = (records: MutationRecord[] = []) => {
      for (const r of records) for (const n of r.removedNodes) if (n instanceof Element) io.unobserve(n);
      for (const el of canvas.querySelectorAll(":scope > .gc-card")) io.observe(el);
    };
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(canvas, { childList: true });
    return () => {
      mo.disconnect();
      io.disconnect();
    };
  }, [loading]);

  const cancelAnim = useCallback(() => {
    if (animRef.current != null) cancelAnimationFrame(animRef.current);
    animRef.current = null;
  }, []);

  /** Glide to `target`, keeping the motion centred on the screen. */
  const animateTo = useCallback(
    (target: View, ms = 420) => {
      cancelAnim();
      const viewport = viewportRef.current;
      if (!viewport) return;
      const w = viewport.clientWidth;
      const h = viewport.clientHeight;
      const from = viewStore.get();
      // World point at screen centre, before and after.
      const c0 = { x: (w / 2 - from.x) / from.scale, y: (h / 2 - from.y) / from.scale };
      const c1 = { x: (w / 2 - target.x) / target.scale, y: (h / 2 - target.y) / target.scale };
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / ms);
        const e = 1 - Math.pow(1 - t, 3);
        const scale = from.scale * Math.pow(target.scale / from.scale, e);
        const cx = c0.x + (c1.x - c0.x) * e;
        const cy = c0.y + (c1.y - c0.y) * e;
        viewStore.set({ x: w / 2 - cx * scale, y: h / 2 - cy * scale, scale });
        animRef.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      animRef.current = requestAnimationFrame(step);
    },
    [cancelAnim, viewStore],
  );

  /** The view that shows a world rect centred, at `maxScale` or smaller. */
  const viewFor = useCallback(
    (x: number, y: number, w: number, h: number, maxScale: number, margin = 48): View | null => {
      const viewport = viewportRef.current;
      if (!viewport) return null;
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      const scale = clamp(
        Math.min(maxScale, (vw - margin * 2) / w, (vh - margin * 2) / h),
        MIN_SCALE,
        MAX_SCALE,
      );
      return { x: vw / 2 - (x + w / 2) * scale, y: vh / 2 - (y + h / 2) * scale, scale };
    },
    [],
  );

  const fitAll = useCallback(
    (animate = true) => {
      const lay = layoutRef.current;
      const b = bounds(lay.positions);
      if (!b) return;
      const v = viewFor(
        b.minC * lay.cellW,
        b.minR * lay.cellH,
        (b.maxC - b.minC) * lay.cellW,
        (b.maxR - b.minR) * lay.cellH,
        1,
        64,
      );
      if (!v) return;
      if (animate) animateTo(v);
      else viewStore.set(v);
    },
    [animateTo, viewFor, viewStore],
  );

  // First visit: frame every window.
  const fittedRef = useRef(layout.view != null);
  useEffect(() => {
    if (fittedRef.current || Object.keys(layout.positions).length === 0) return;
    fittedRef.current = true;
    fitAll(false);
  }, [layout.positions, fitAll]);

  /** Focus a window and zoom in as far as it fits on screen, centred. */
  const focusCard = useCallback(
    (chatId: string) => {
      const lay = layoutRef.current;
      const p = lay.positions[chatId];
      if (!p) return;
      selectOnly(chatId);
      const v = viewFor(p.c * lay.cellW, p.r * lay.cellH, lay.cellW, lay.cellH, MAX_SCALE, 24);
      if (!v) return;
      prevViewRef.current = viewStore.get();
      animateTo(v);
    },
    [animateTo, selectOnly, viewFor, viewStore],
  );

  /** Focus a window and, if it isn't wholly on screen, glide it to the centre
   *  at the current zoom (so arrowing round keeps your zoom level). */
  const revealCard = useCallback(
    (chatId: string) => {
      const viewport = viewportRef.current;
      const lay = layoutRef.current;
      const p = lay.positions[chatId];
      if (!viewport || !p) return;
      selectOnly(chatId);
      const v = viewStore.get();
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      const w = lay.cellW * v.scale;
      const h = lay.cellH * v.scale;
      const x0 = v.x + p.c * w;
      const y0 = v.y + p.r * h;
      const m = 12;
      if (x0 >= m && y0 >= m && x0 + w <= vw - m && y0 + h <= vh - m) return;
      animateTo(
        { scale: v.scale, x: vw / 2 - (p.c + 0.5) * w, y: vh / 2 - (p.r + 0.5) * h },
        320,
      );
    },
    [animateTo, selectOnly, viewStore],
  );

  // A chat just made (or brought back) here: fly to it once it has a cell.
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending || !layout.positions[pending.chatId]) return;
    pendingFocusRef.current = null;
    focusCard(pending.chatId);
    if (pending.compose) setComposerOpen(pending.chatId, true);
  }, [layout.positions, focusCard, setComposerOpen]);

  /** Bring the chat `from` was continued in (a handoff) onto the grid, in the
   *  free cell beside `from` if it has one (else beside its repo's windows),
   *  and fly to it, with its composer open on the handoff note if nothing has
   *  been sent yet. Already here: just fly to it. */
  const continueChat = useCallback(
    async (from: GridChatEntry, chatId: string) => {
      if (layoutRef.current.positions[chatId]) {
        focusCard(chatId);
        return;
      }
      try {
        const next = await edit(() => api.addToGrid(chatId, from.repoPath));
        const positions = layoutRef.current.positions;
        const repoById = new Map(next.map((e) => [e.chatId, e.repoPath]));
        const src = positions[from.chatId];
        const cell = placeNew(positions, (id) => repoById.get(id), from.repoPath, [from.chatId]);
        const beside = src != null && Math.abs(cell.c - src.c) + Math.abs(cell.r - src.r) === 1;
        pendingFocusRef.current = {
          chatId,
          compose: !next.find((e) => e.chatId === chatId)?.chat.preview,
          cell: beside ? cell : undefined,
        };
        setEntries((prev) => reuseEntries(prev, next));
      } catch {
        void refresh();
      }
    },
    [edit, refresh, focusCard],
  );

  // Forget the focus and selection of windows that leave the grid.
  useEffect(() => {
    if (loading || !pipelinesLoaded) return;
    if (focusedId && !repoById.has(focusedId)) setFocusedId(null);
    setSelected((prev) => {
      const kept = [...prev].filter((id) => repoById.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [repoById, focusedId, loading, pipelinesLoaded]);

  // Trackpad: two-finger scroll pans, pinch (ctrl+wheel) zooms about the
  // cursor. At reading zoom a vertical scroll over the focused window's
  // transcript or composer scrolls that instead; sideways always pans.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewStore.get();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.clientHeight : 1;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        cancelAnim();
        const rect = viewport.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const scale = clamp(v.scale * Math.exp(-e.deltaY * unit * 0.01), MIN_SCALE, MAX_SCALE);
        const k = scale / v.scale;
        viewStore.set({ x: px - (px - v.x) * k, y: py - (py - v.y) * k, scale });
        return;
      }
      const target = e.target as HTMLElement;
      if (
        v.scale >= INTERACTIVE_SCALE &&
        Math.abs(e.deltaY) >= Math.abs(e.deltaX) &&
        target.closest(".gc-card--focused :is(.gc-card-body, .gc-card-dock, .gc-agents)")
      ) {
        return;
      }
      e.preventDefault();
      cancelAnim();
      viewStore.set({ ...v, x: v.x - e.deltaX * unit, y: v.y - e.deltaY * unit });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [viewStore, cancelAnim, loading]);

  /** A wheel-button drag pans (a left drag selects instead). The pointer is
   *  only captured once it moves, so a wheel click on a link still opens it. */
  const beginPan = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const el = e.currentTarget;
      const pointerId = e.pointerId;
      const start = viewStore.get();
      const sx = e.clientX;
      const sy = e.clientY;
      let panning = false;
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        if (!panning) {
          if (Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
          panning = true;
          cancelAnim();
          try {
            el.setPointerCapture(pointerId);
          } catch {
            /* pointer already gone */
          }
          el.classList.add("gc-viewport--panning");
        }
        viewStore.set({ ...start, x: start.x + dx, y: start.y + dy });
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        el.classList.remove("gc-viewport--panning");
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [cancelAnim, viewStore],
  );

  /** A left drag draws a box, and every window it touches is selected (with
   *  Shift/⌘, added to the selection). A press that doesn't move is a click: on
   *  a window it focuses and selects just that one (Shift/⌘ adds or removes it
   *  instead); on empty board it clears the selection and the focus. The
   *  pointer is only captured once it moves, so buttons in windows still click. */
  const beginSelect = useCallback(
    (e: React.PointerEvent<HTMLElement>, chatId: string | null, additive: boolean) => {
      const box = marqueeRef.current;
      if (!box) return;
      const el = e.currentTarget;
      const pointerId = e.pointerId;
      const rect = el.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      // The pressed corner is pinned to the board, so a scroll or zoom mid-drag
      // doesn't slide it off the windows it started on.
      const v0 = viewStore.get();
      const ax = (sx - rect.left - v0.x) / v0.scale;
      const ay = (sy - rect.top - v0.y) / v0.scale;
      const base = additive ? selectedRef.current : NO_SELECTION;
      let at = { x: sx - rect.left, y: sy - rect.top };
      let active = false;
      let unsubscribe = () => {};
      const draw = () => {
        const v = viewStore.get();
        const lay = layoutRef.current;
        const bx = (at.x - v.x) / v.scale;
        const by = (at.y - v.y) / v.scale;
        const area = {
          left: Math.min(ax, bx),
          top: Math.min(ay, by),
          right: Math.max(ax, bx),
          bottom: Math.max(ay, by),
        };
        box.style.transform = `translate(${v.x + area.left * v.scale}px, ${v.y + area.top * v.scale}px)`;
        box.style.width = `${(area.right - area.left) * v.scale}px`;
        box.style.height = `${(area.bottom - area.top) * v.scale}px`;
        const next = new Set(base);
        for (const id of windowsTouching(lay.positions, lay.cellW, lay.cellH, area)) next.add(id);
        setSelected((prev) => (sameSet(prev, next) ? prev : next));
      };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        at = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        if (!active) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_SLOP_PX) return;
          active = true;
          cancelAnim();
          try {
            el.setPointerCapture(pointerId);
          } catch {
            /* pointer already gone */
          }
          el.classList.add("gc-viewport--selecting");
          if (!additive) setFocusedId(null);
          unsubscribe = viewStore.subscribe(draw);
        }
        draw();
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (active) {
          unsubscribe();
          el.classList.remove("gc-viewport--selecting");
          swallowNextClick();
          return;
        }
        if (ev.type !== "pointerup") return;
        if (!additive) selectOnly(chatId);
        else if (chatId != null) toggleSelected(chatId);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [cancelAnim, selectOnly, toggleSelected, viewStore],
  );

  /** Dragging a window moves it, or, if it is selected, the whole selection,
   *  keeping its shape; it is pulled onto the nearest cells where it all fits
   *  when close enough. Windows joined to it but not selected stay put. With
   *  Shift/⌘ the window joins the selection and moves with it. A press that
   *  doesn't move is a click, which selects just that window (Shift/⌘ adds or
   *  removes it instead). */
  const beginCardDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, chatId: string, additive = false) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const lay = layoutRef.current;
      if (!lay.positions[chatId]) return;
      const sel = selectedRef.current;
      const ids = sel.has(chatId) ? [...sel] : additive ? [...sel, chatId] : [chatId];
      const group = ids.filter((id) => lay.positions[id]);
      const handle = e.currentTarget;
      const pointerId = e.pointerId;
      const sx = e.clientX;
      const sy = e.clientY;
      let active = false;
      let lifted: Lifted = { cards: [], land: () => {} };
      let snap: Cell = { c: 0, r: 0 };
      let visual = { x: 0, y: 0 };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        if (!active) {
          if (Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
          active = true;
          draggingRef.current = true;
          cancelAnim();
          try {
            handle.setPointerCapture(pointerId);
          } catch {
            /* pointer already gone */
          }
          lifted = lift(canvas, group, lay.positions);
          if (additive && !sel.has(chatId)) setSelected(new Set(group));
        }
        const s = viewStore.get().scale;
        const raw = { c: dx / s / lay.cellW, r: dy / s / lay.cellH };
        const prevSnap = snap;
        snap = nearestFreeOffset(group, lay.positions, Math.round(raw.c), Math.round(raw.r));
        const dist = Math.hypot(raw.c - snap.c, raw.r - snap.r);
        const t = dist < MAGNET_CELLS ? 1 - dist / MAGNET_CELLS : 0;
        const pull = t * t * (3 - 2 * t);
        visual = {
          x: (raw.c + (snap.c - raw.c) * pull) * lay.cellW,
          y: (raw.r + (snap.r - raw.r) * pull) * lay.cellH,
        };
        const transform = `translate(${visual.x}px, ${visual.y}px)`;
        for (const el of lifted.cards) el.style.transform = transform;
        if (!ghostStore.get() || snap.c !== prevSnap.c || snap.r !== prevSnap.r) {
          ghostStore.set(
            group.map((id) => ({ c: lay.positions[id].c + snap.c, r: lay.positions[id].r + snap.r })),
          );
        }
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (!active) {
          if (ev.type !== "pointerup") return;
          if (additive) toggleSelected(chatId);
          else selectOnly(chatId);
          return;
        }
        draggingRef.current = false;
        ghostStore.set(null);
        lifted.land();
        // Land from where the windows visually are onto their new cells.
        const transform = `translate(${visual.x - snap.c * lay.cellW}px, ${visual.y - snap.r * lay.cellH}px)`;
        for (const el of lifted.cards) el.style.transform = transform;
        setLayout((prev) => {
          const positions = { ...prev.positions };
          for (const id of group) {
            const p = prev.positions[id];
            if (p) positions[id] = { c: p.c + snap.c, r: p.r + snap.r };
          }
          return { ...prev, positions };
        });
        const { cards } = lifted;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            for (const el of cards) {
              el.classList.add("gc-card--settling");
              el.style.transform = "";
            }
            setTimeout(() => {
              for (const el of cards) el.classList.remove("gc-card--settling");
            }, 220);
          }),
        );
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [cancelAnim, ghostStore, selectOnly, toggleSelected, viewStore],
  );

  // One handler for every press on the board. The focused window behaves like
  // a normal chat: its controls and, close up, its transcript and composer take
  // the press, and its title bar (or, zoomed out, any of it) drags the
  // selection. Any part of any other window drags it (and the selection, if
  // it is in it). Only on empty board does a left drag draw a selection box;
  // a wheel-button drag pans.
  const onViewportPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.button !== 1) return;
      const target = e.target as HTMLElement;
      if (target.closest(".gc-resize, .gc-add")) return;
      if (e.button === 1) {
        beginPan(e);
        return;
      }
      const chatId = target.closest<HTMLElement>("[data-grid-card]")?.dataset.gridCard ?? null;
      const additive = e.shiftKey || e.metaKey;
      if (chatId != null && chatId === focusedRef.current) {
        if (target.closest(CONTROL_SELECTOR)) return;
        const live = viewStore.get().scale >= INTERACTIVE_SCALE;
        if (live && !target.closest(".gc-head")) {
          // Working in the window: the rest of the selection lets go.
          if (!additive) selectOnly(chatId);
          return;
        }
      }
      if (chatId != null) {
        beginCardDrag(e, chatId, additive);
        return;
      }
      beginSelect(e, null, additive);
    },
    [beginCardDrag, beginPan, beginSelect, selectOnly, viewStore],
  );

  // Double-click a title bar (or, zoomed out, a whole window) to zoom in on it;
  // double-click empty canvas to step back out.
  const onViewportDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(`${CONTROL_SELECTOR}, .gc-resize`)) return;
      const chatId = target.closest<HTMLElement>("[data-grid-card]")?.dataset.gridCard;
      if (chatId) {
        const live = viewStore.get().scale >= INTERACTIVE_SCALE;
        if (!live || target.closest(".gc-head")) focusCard(chatId);
        return;
      }
      const prev = prevViewRef.current;
      if (!prev) return;
      prevViewRef.current = null;
      animateTo(prev);
    },
    [animateTo, focusCard, viewStore],
  );

  // Links and images in a window would start a native drag instead of a
  // selection box or a move.
  const onViewportDragStart = useCallback((e: React.DragEvent) => {
    const card = (e.target as HTMLElement).closest?.("[data-grid-card]") as HTMLElement | null;
    if (card?.dataset.gridCard !== focusedRef.current) e.preventDefault();
  }, []);

  /** Pack every repo into a tidy block, sliding each window from where it was
   *  to its new cell, then frame the result. */
  const autoArrange = useCallback(() => {
    const canvas = canvasRef.current;
    const lay = layoutRef.current;
    const next = arrange(lay.positions, (id) => repoById.get(id));
    const els: HTMLElement[] = [];
    for (const [id, to] of Object.entries(next)) {
      const from = lay.positions[id];
      const el = canvas?.querySelector<HTMLElement>(`[data-grid-card="${CSS.escape(id)}"]`);
      if (!el || !from || (from.c === to.c && from.r === to.r)) continue;
      el.style.transform = `translate(${(from.c - to.c) * lay.cellW}px, ${(from.r - to.r) * lay.cellH}px)`;
      els.push(el);
    }
    setLayout((prev) => ({ ...prev, positions: next }));
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const el of els) {
          el.classList.add("gc-card--arranging");
          el.style.transform = "";
        }
        setTimeout(() => {
          for (const el of els) el.classList.remove("gc-card--arranging");
        }, 460);
        fitAll();
      }),
    );
  }, [repoById, fitAll]);

  /** Edge drag: every window shares one size, so this resizes the whole grid.
   *  The window being dragged keeps its top-left corner where it is. */
  const beginResize = useCallback(
    (e: React.PointerEvent, chatId: string, axis: "e" | "s" | "se") => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const canvas = canvasRef.current;
      const lay = layoutRef.current;
      const p = lay.positions[chatId];
      if (!canvas || !p) return;
      cancelAnim();
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);
      const v0 = viewStore.get();
      const sx = e.clientX;
      const sy = e.clientY;
      const anchorX = v0.x + p.c * lay.cellW * v0.scale;
      const anchorY = v0.y + p.r * lay.cellH * v0.scale;
      let w = lay.cellW;
      let h = lay.cellH;
      canvas.classList.add("gc-canvas--resizing");
      const move = (ev: PointerEvent) => {
        if (axis !== "s") w = clamp(lay.cellW + (ev.clientX - sx) / v0.scale, MIN_CELL_W, MAX_CELL_W);
        if (axis !== "e") h = clamp(lay.cellH + (ev.clientY - sy) / v0.scale, MIN_CELL_H, MAX_CELL_H);
        canvas.style.setProperty("--cell-w", `${w}px`);
        canvas.style.setProperty("--cell-h", `${h}px`);
        viewStore.set({
          scale: v0.scale,
          x: anchorX - p.c * w * v0.scale,
          y: anchorY - p.r * h * v0.scale,
        });
      };
      const up = () => {
        canvas.classList.remove("gc-canvas--resizing");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        setLayout((prev) => ({ ...prev, cellW: Math.round(w), cellH: Math.round(h) }));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    },
    [cancelAnim, viewStore],
  );

  // Repo swatches for the repos actually on the board, de-collided against
  // each other so two projects on screen never share a colour.
  const repoKey = useMemo(() => [...new Set(entries.map((e) => e.repoPath))].sort().join("\n"), [entries]);
  const repoColors = useMemo(() => assignRepoColors(repoKey ? repoKey.split("\n") : []), [repoKey]);
  const colorOf = useCallback(
    (repoPath: string) => repoColors.get(repoPath) ?? repoColor(repoPath),
    [repoColors],
  );

  const occ = useMemo(() => occupancy(layout.positions), [layout.positions]);
  const filletList = useMemo(() => fillets(layout.positions), [layout.positions]);
  const entryById = useMemo(() => new Map(entries.map((e) => [e.chatId, e])), [entries]);

  // ── "+" beside each repo block ──
  // A block is a repo's windows joined edge to edge. Its "+" sits in the free
  // cell its next chat would take, and shows while the pointer is over the
  // block or that cell.
  const groups = useMemo(
    () => repoGroups(layout.positions, (id) => repoById.get(id)),
    [repoById, layout.positions],
  );
  /** The block (named by its first window) whose "+" is showing. */
  const hoverStore = useMemo(() => createValueStore<string | null>(null), []);
  /** cell key → the block the pointer is "over" there. */
  const hoverCells = useMemo(() => {
    const out = new Map<string, string>();
    for (const g of groups) {
      for (const id of g.ids) {
        const p = layout.positions[id];
        out.set(cellKey(p.c, p.r), g.ids[0]);
      }
    }
    for (const g of groups) {
      if (g.slot && !out.has(cellKey(g.slot.c, g.slot.r))) out.set(cellKey(g.slot.c, g.slot.r), g.ids[0]);
    }
    return out;
  }, [groups, layout.positions]);
  const hoverCellsRef = useRef(hoverCells);
  hoverCellsRef.current = hoverCells;

  // Track the cell under the pointer, through pans and zooms too; nothing
  // shows mid-drag.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let at: { x: number; y: number } | null = null;
    const update = (own?: string) => {
      if (!at || draggingRef.current) {
        hoverStore.set(null);
        return;
      }
      const v = viewStore.get();
      const lay = layoutRef.current;
      const c = Math.floor((at.x - v.x) / v.scale / lay.cellW);
      const r = Math.floor((at.y - v.y) / v.scale / lay.cellH);
      hoverStore.set(own ?? hoverCellsRef.current.get(cellKey(c, r)) ?? null);
    };
    const onMove = (e: PointerEvent) => {
      const rect = viewport.getBoundingClientRect();
      at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // Far out, the "+" itself reaches past its cell.
      update((e.target as Element).closest<HTMLElement>(".gc-add")?.dataset.group);
    };
    const onLeave = () => {
      at = null;
      update();
    };
    viewport.addEventListener("pointermove", onMove);
    viewport.addEventListener("pointerleave", onLeave);
    const unsub = viewStore.subscribe(() => update());
    return () => {
      viewport.removeEventListener("pointermove", onMove);
      viewport.removeEventListener("pointerleave", onLeave);
      unsub();
    };
  }, [hoverStore, viewStore, loading]);

  // ── "Needs you" column ──
  // Live status per window (windows report it; the polled summary lags), and
  // when each one started waiting. A chat stays listed for as long as it's
  // waiting on the user; visiting it doesn't clear it.
  const [reports, setReports] = useState<ReadonlyMap<string, ChatReport>>(() => new Map());
  const waitingSinceRef = useRef(new Map<string, number>());
  const reportChat = useCallback((chatId: string, report: ChatReport) => {
    setReports((prev) => {
      const old = prev.get(chatId);
      if (old && old.status === report.status && old.summary === report.summary) return prev;
      return new Map(prev).set(chatId, report);
    });
  }, []);

  const queueItems = useMemo<QueueItem[]>(() => {
    const since = waitingSinceRef.current;
    const items: QueueItem[] = [];
    for (const e of entries) {
      const report = reports.get(e.chatId);
      const status = report?.status ?? e.chat.status;
      if (!needsAttention(status)) {
        since.delete(e.chatId);
        continue;
      }
      if (!since.has(e.chatId)) {
        const updated = Date.parse(e.chat.updatedAt);
        since.set(e.chatId, Number.isFinite(updated) ? updated : Date.now());
      }
      items.push({
        chatId: e.chatId,
        title: e.chat.title || "New chat",
        repoName: e.repoName,
        color: colorOf(e.repoPath),
        status,
        since: since.get(e.chatId)!,
        summary: report?.summary ?? "",
      });
    }
    return items.sort(
      (a, b) => (QUEUE_RANK[a.status] ?? 3) - (QUEUE_RANK[b.status] ?? 3) || a.since - b.since,
    );
  }, [entries, reports, colorOf]);

  // Keys, when nothing is being typed into: arrows move the focus to the
  // nearest window that way (from the one nearest the middle of the screen if
  // none is focused), Enter opens the focused window's message box, Escape
  // closes it (or, with it shut, lets go of the rest of the selection).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          target.closest("[role='dialog'], [aria-modal='true'], .master-popover"))
      ) {
        return;
      }
      if (document.querySelector(".master-popover--open")) return;
      const lay = layoutRef.current;
      const dir = ARROW_DIRS[e.key];
      if (dir) {
        const from = focusedRef.current;
        let next: string | null = null;
        if (from && lay.positions[from]) next = neighbourIn(from, lay.positions, dir);
        else next = nearestToCentre();
        e.preventDefault();
        if (!next) return;
        // Drop focus from whatever was clicked last (a window control, or the
        // button used to get here) so Enter acts on the grid.
        if (target && target !== document.body) target.blur();
        revealCard(next);
        return;
      }
      const id = focusedRef.current;
      if (id && e.key === "Escape" && openComposersRef.current.has(id)) {
        e.preventDefault();
        setComposerOpen(id, false);
        return;
      }
      if (e.key === "Escape" && selectedRef.current.size > (id ? 1 : 0)) {
        e.preventDefault();
        selectOnly(id);
        return;
      }
      if (!id) return;
      if (e.key === "Enter") {
        // A focused control inside a window keeps its own Enter. Anything else
        // focused (say the Grid button used to get here) would be "clicked".
        const control = target?.closest("button, a, [role='button']");
        if (control && canvasRef.current?.contains(control)) return;
        e.preventDefault();
        if (viewStore.get().scale < INTERACTIVE_SCALE) focusCard(id);
        else revealCard(id);
        setComposerOpen(id, true);
      }
    };
    /** The window nearest the middle of the screen. */
    const nearestToCentre = () => {
      const viewport = viewportRef.current;
      const lay = layoutRef.current;
      if (!viewport) return null;
      const v = viewStore.get();
      const cx = (viewport.clientWidth / 2 - v.x) / v.scale / lay.cellW - 0.5;
      const cy = (viewport.clientHeight / 2 - v.y) / v.scale / lay.cellH - 0.5;
      let best: string | null = null;
      let bestD = Infinity;
      for (const [id, p] of Object.entries(lay.positions)) {
        const d = Math.hypot(p.c - cx, p.r - cy);
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
      return best;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusCard, revealCard, selectOnly, setComposerOpen, viewStore]);

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

  const n = entries.length;

  return (
    <div className="grid-page gc-stage">
      <div className="gc-main">
        <div
          className="gc-viewport"
          ref={viewportRef}
          onPointerDown={onViewportPointerDown}
          onDoubleClick={onViewportDoubleClick}
          onDragStart={onViewportDragStart}
        >
          <div className="gc-dots" ref={dotsRef} aria-hidden />
          <div
            className="gc-canvas"
            ref={canvasRef}
            style={
              {
                "--cell-w": `${layout.cellW}px`,
                "--cell-h": `${layout.cellH}px`,
              } as React.CSSProperties
            }
          >
            {filletList.map((f) => {
              const repo = repoById.get(f.chatId);
              const color = repo ? colorOf(repo) : { hue: 0, tone: 0 };
              // A window that needs you carries its ring round its half of the
              // arc. A focused or selected one sits over the corner, ring and
              // all, so it doesn't.
              const ringOf = (id: string) => {
                const e = entryById.get(id);
                if (!e || id === focusedId || selected.has(id)) return undefined;
                const status = reports.get(id)?.status ?? e.chat.status;
                return needsAttention(status) ? status : undefined;
              };
              return (
                <div
                  key={`${f.x},${f.y}`}
                  data-at={`${f.x},${f.y}`}
                  data-h={ringOf(f.chatId)}
                  data-v={ringOf(f.vChatId)}
                  className={`gc-fillet gc-tinted gc-fillet--${f.dx > 0 ? "r" : "l"}${f.dy > 0 ? "b" : "t"}`}
                  style={{ ...repoColorVars(color), "--x": f.x, "--y": f.y } as React.CSSProperties}
                  aria-hidden
                />
              );
            })}
            {entries.map((entry) => {
              const p = layout.positions[entry.chatId];
              if (!p) return null;
              const s = sidesOf(p, occ);
              const color = colorOf(entry.repoPath);
              return (
                <GridCard
                  key={entry.chatId}
                  entry={entry}
                  c={p.c}
                  r={p.r}
                  sideClass={`${s.n ? " gc-n" : ""}${s.e ? " gc-e" : ""}${s.s ? " gc-s" : ""}${s.w ? " gc-w" : ""}`}
                  repoHue={color.hue}
                  repoTone={color.tone}
                  settings={cardSettings}
                  onOpen={openChat}
                  onContinue={continueChat}
                  onDone={markDone}
                  composerOpen={openComposers.has(entry.chatId)}
                  onComposerOpenChange={setComposerOpen}
                  onBeginResize={beginResize}
                  onFocus={focusCard}
                  onReport={reportChat}
                  focused={focusedId === entry.chatId}
                  selected={selected.has(entry.chatId)}
                />
              );
            })}
            {pipelines?.sources.map((source) => {
              const id = pipelineCardId(source.id);
              const p = layout.positions[id];
              if (!p) return null;
              const s = sidesOf(p, occ);
              const color = colorOf(source.repoPath);
              return (
                <GridPipelineCard
                  key={id}
                  source={source}
                  budget={pipelines.budget}
                  c={p.c}
                  r={p.r}
                  sideClass={`${s.n ? " gc-n" : ""}${s.e ? " gc-e" : ""}${s.s ? " gc-s" : ""}${s.w ? " gc-w" : ""}`}
                  repoHue={color.hue}
                  repoTone={color.tone}
                  focused={focusedId === id}
                  selected={selected.has(id)}
                  onRun={runPipeline}
                  onFocusChat={focusCard}
                />
              );
            })}
            <GroupAdds
              groups={groups}
              hover={hoverStore}
              entryById={entryById}
              colorOf={colorOf}
              disabled={creating}
              onAdd={createIn}
            />
            <DragGhost store={ghostStore} />
          </div>
          <div className="gc-marquee" ref={marqueeRef} aria-hidden />
        </div>

        {loading ? (
          <div className="grid-empty">Loading…</div>
        ) : n === 0 && !pipelines?.sources.length ? (
          <div className="grid-empty">
            No grid chats yet. Use <strong>New chat</strong> to start one — it stays here until you
            mark it done, and also appears in its repo. Marking done only takes a chat off the grid;
            bring it back any time from <strong>New chat → Recent chats</strong>.
          </div>
        ) : null}

        <div className="gc-toolbar" ref={menuRef}>
          <button
            type="button"
            className="gc-tool-btn"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={creating}
            title="New grid chat"
          >
            <Plus size={15} />
            <span>New chat</span>
          </button>
          <button
            type="button"
            className="gc-tool-btn gc-tool-btn--icon"
            onClick={() => fitAll()}
            disabled={n === 0}
            title="Show every window"
          >
            <Maximize size={14} />
          </button>
          <button
            type="button"
            className="gc-tool-btn gc-tool-btn--icon"
            onClick={autoArrange}
            disabled={n === 0}
            title="Tidy windows into a block per repo"
          >
            <LayoutGrid size={14} />
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
                            <span className="grid-recent-repo">
                              <span
                                className="repo-dot"
                                style={repoColorVars(repoColor(r.repoPath)) as React.CSSProperties}
                                aria-hidden
                              />
                              {r.repoName}
                            </span>
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
      </div>

      {n > 0 && <GridQueue items={queueItems} open={focusedId} onOpen={focusCard} />}

      <MasterButton settings={cardSettings} />
    </div>
  );
}

/** Where a block's "+" sits, by which side of its cell the block lies on: the
 *  middle of the edge the new window would share with the block, and the way
 *  into the free cell from there. */
const ADD_EDGE: Record<RepoGroup["side"], { x: number; y: number; dx: number; dy: number }> = {
  w: { x: 0, y: 0.5, dx: 1, dy: 0 },
  n: { x: 0.5, y: 0, dx: 0, dy: 1 },
  e: { x: 1, y: 0.5, dx: -1, dy: 0 },
  s: { x: 0.5, y: 1, dx: 0, dy: -1 },
};

/** A small "+" beside each repo block, shown while the pointer is over the
 *  block. It starts a chat in that repo in the free cell it sits in, which is
 *  outlined while the "+" is hovered. */
function GroupAdds({
  groups,
  hover,
  entryById,
  colorOf,
  disabled,
  onAdd,
}: {
  groups: RepoGroup[];
  hover: ValueStore<string | null>;
  entryById: Map<string, GridChatEntry>;
  colorOf: (repoPath: string) => RepoColor;
  disabled: boolean;
  onAdd: (repoPath: string, cell: Cell) => Promise<void>;
}) {
  const shown = useStoreValue(hover);
  return (
    <>
      {groups.map((g) => {
        const slot = g.slot;
        if (!slot) return null;
        const edge = ADD_EDGE[g.side];
        const label = `New chat in ${entryById.get(g.ids[0])?.repoName ?? "this repo"}`;
        return (
          <Fragment key={g.ids[0]}>
            <button
              type="button"
              className={`gc-add gc-tinted${shown === g.ids[0] ? " gc-add--shown" : ""}`}
              data-group={g.ids[0]}
              style={
                {
                  ...repoColorVars(colorOf(g.repo)),
                  "--x": slot.c + edge.x,
                  "--y": slot.r + edge.y,
                  "--dx": edge.dx,
                  "--dy": edge.dy,
                } as React.CSSProperties
              }
              disabled={disabled}
              title={label}
              aria-label={label}
              onClick={() => void onAdd(g.repo, slot)}
            >
              <Plus size={14} />
            </button>
            <div
              className="gc-ghost gc-add-slot"
              style={{ "--c": slot.c, "--r": slot.r } as React.CSSProperties}
              aria-hidden
            />
          </Fragment>
        );
      })}
    </>
  );
}

/** Outline of the cells a dragged group will land on. */
function DragGhost({ store }: { store: ValueStore<Ghost> }) {
  const cells = useStoreValue(store);
  if (!cells) return null;
  return (
    <>
      {cells.map((p) => (
        <div
          key={`${p.c},${p.r}`}
          className="gc-ghost"
          style={{ "--c": p.c, "--r": p.r } as React.CSSProperties}
        />
      ))}
    </>
  );
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

/** The last thing the agent said, flattened to one line for the queue. */
function lastAssistantText(turns: ChatTurn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.kind !== "assistant") continue;
    for (let j = t.content.length - 1; j >= 0; j--) {
      const b = t.content[j];
      if (b.type === "text" && b.text.trim()) return oneLine(b.text);
    }
  }
  return "";
}

function oneLine(text: string): string {
  const flat = text.replace(/[#*_`>]+/g, "").replace(/\s+/g, " ").trim();
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
}

interface CardProps {
  entry: GridChatEntry;
  c: number;
  r: number;
  /** " gc-n gc-e …" for each side that touches another window: those edges
   *  become seams and lose their rounding. */
  sideClass: string;
  /** Swatch for this window's repo, assigned across the whole canvas. */
  repoHue: number;
  repoTone: number;
  settings: GridChatSettings;
  onOpen: (repoPath: string, chatId: string) => void | Promise<void>;
  /** Opens a chat this one leads to in its own window: the one it was
   *  continued in (a handoff), or a subagent chat it spawned. */
  onContinue: (from: GridChatEntry, chatId: string) => void | Promise<void>;
  /** Done, or from the front page also "not now" / "not relevant". */
  onDone: (entry: GridChatEntry) => void;
  composerOpen: boolean;
  onComposerOpenChange: (chatId: string, open: boolean) => void;
  onBeginResize: (e: React.PointerEvent, chatId: string, axis: "e" | "s" | "se") => void;
  onFocus: (chatId: string) => void;
  onReport: (chatId: string, report: ChatReport) => void;
  focused: boolean;
  /** One of several selected windows (the focused one shows as focused). */
  selected: boolean;
}

/** A grid window is a live view into a normal buildover chat: same transcript,
 *  banners, prompts, queue and Composer as the full chat view. Memoised: the
 *  canvas re-renders on every poll and drag, and each window holds a whole
 *  transcript. */
const GridCard = memo(function GridCard({
  entry,
  c,
  r,
  sideClass,
  repoHue,
  repoTone,
  settings,
  onOpen,
  onContinue,
  onDone,
  composerOpen,
  onComposerOpenChange,
  onBeginResize,
  onFocus,
  onReport,
  focused,
  selected,
}: CardProps) {
  const { chat } = entry;
  const agent = useAgent(entry.repoPath, entry.chatId);
  // The front page the agent wrote, if any; the chat is on the back.
  const page = useFrontPage(agent.turns);
  const [flipped, setFlipped] = useState(false);
  const withFront = hasFrontPage(page);
  const showFront = withFront && !flipped;
  // An offered answer other than the big one starts a message for Sean to finish.
  const [optionDraft, setOptionDraft] = useState<string | null>(null);
  // Prefer the live session status over the polled summary, which lags.
  const status = agent.status ?? chat.status;
  const attention = needsAttention(status);
  const prompt = agent.pendingAttention ?? agent.pendingPermission;
  const setComposerOpen = useCallback(
    (open: boolean) => onComposerOpenChange(entry.chatId, open),
    [onComposerOpenChange, entry.chatId],
  );

  // What the queue shows under the title: the question, or what it last said.
  // Only worked out while the chat is waiting, so streaming costs nothing.
  const summary = useMemo(() => {
    if (!attention) return "";
    if (agent.pendingAttention) return oneLine(agent.pendingAttention.message);
    if (agent.pendingPermission) return `Wants to use ${agent.pendingPermission.toolName}`;
    const said = lastAssistantText(agent.turns);
    if (status === "error") return agent.notice?.message ?? (said || "Hit an error");
    return said;
  }, [attention, status, agent.pendingAttention, agent.pendingPermission, agent.notice, agent.turns]);

  useEffect(() => {
    onReport(entry.chatId, { status, summary });
  }, [onReport, entry.chatId, status, summary]);

  // Its subagents: the SDK ones in its transcript and the chats it spawned.
  // A badge over the transcript counts the working ones and opens a list of
  // what they're doing.
  const transcriptSubagents = useSubagents(agent.turns, agent.isStreaming, agent.backgroundTasks);
  const subagents = useMemo(
    () => gridSubagents(transcriptSubagents, entry.subagents),
    [transcriptSubagents, entry.subagents],
  );
  const openSubagentChat = useCallback(
    (chatId: string) => void onContinue(entry, chatId),
    [onContinue, entry],
  );

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

  const { setKeepWarm, addKeepWarmHours } = agent;
  const keepWarmUntil = agent.meta.keepWarmUntil;
  const handleStopKeepWarm = useCallback(() => setKeepWarm(false), [setKeepWarm]);
  const hasPromptCache = getModelProvider(model) === "claude";

  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const handleHandoff = useCallback(async () => {
    if (handoffBusy) return;
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      const { chat: next } = await api.handoffChat(entry.repoPath, entry.chatId);
      void onContinue(entry, next.id);
    } catch (err) {
      setHandoffError(err instanceof Error ? err.message : String(err));
    } finally {
      setHandoffBusy(false);
    }
  }, [handoffBusy, entry, onContinue]);

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
  // Opened from far out (a new chat, or Enter on a tile) the dock stays hidden
  // until the zoom-in passes FAR_SCALE, and a hidden field can't take focus, so
  // keep trying each frame until it does, unless focus goes somewhere else.
  useEffect(() => {
    if (!composerOpen) return;
    const from = document.activeElement;
    const giveUpAt = performance.now() + 1000;
    let frame = 0;
    const tryFocus = () => {
      const el =
        dockRef.current?.querySelector<HTMLElement>(".permission") ??
        composerRef.current?.querySelector<HTMLTextAreaElement>("textarea.composer-input");
      if (!el) return;
      // preventScroll: the viewport clips rather than scrolls, and focusing an
      // off-screen field would otherwise shove the whole canvas sideways.
      el.focus({ preventScroll: true });
      const now = document.activeElement;
      if (now === el) {
        if (el instanceof HTMLTextAreaElement) {
          const end = el.value.length;
          el.setSelectionRange(end, end);
        }
        return;
      }
      if ((now === from || now === document.body) && performance.now() < giveUpAt) {
        frame = requestAnimationFrame(tryFocus);
      }
    };
    tryFocus();
    return () => cancelAnimationFrame(frame);
  }, [composerOpen]);

  const title = chat.title || "New chat";
  const headFlag = status === "agent_done" ? undefined : ATTENTION_LABEL[status];

  return (
    <div
      data-grid-card={entry.chatId}
      className={`gc-card gc-tinted${sideClass}${attention ? ` gc-card--attention gc-card--${status}` : ""}${focused ? " gc-card--focused" : selected ? " gc-card--selected" : ""}`}
      style={
        {
          "--repo-hue": repoHue,
          "--repo-tone": repoTone,
          "--c": c,
          "--r": r,
        } as React.CSSProperties
      }
      onClick={() => {
        // Clicking anywhere on the window dismisses an open composer.
        if (composerOpen) setComposerOpen(false);
      }}
    >
      <div className="gc-head">
        <div className="gc-head-side">
          <button
            type="button"
            className="gc-head-btn"
            aria-label="Mark done — removes this chat from the grid only"
            title="Mark done — takes it off the grid only. The chat is kept: find it again under New chat → Recent chats, or in its repo's Archive."
            onClick={(e) => {
              e.stopPropagation();
              onDone(entry);
            }}
          >
            <Check size={12} />
          </button>
          <button
            type="button"
            className="gc-head-btn"
            aria-label="Centre this window"
            title="Centre at reading size (or double-click the title bar)"
            onClick={(e) => {
              e.stopPropagation();
              onFocus(entry.chatId);
            }}
          >
            <Focus size={12} />
          </button>
        </div>
        <div className="gc-head-title" title={`${title} — ${entry.repoPath}`}>
          <span className={`gc-head-status${headFlag ? " gc-head-status--flag" : ""}`}>
            <StatusIcon status={status} />
            {headFlag && <span className="gc-head-status-text">{headFlag}</span>}
          </span>
          <span className="gc-head-name">{title}</span>
          <span className="gc-head-repo">
            <span className="gc-head-repo-dot" aria-hidden />
            {entry.repoName}
          </span>
        </div>
        <div className="gc-head-side gc-head-side--end">
          {withFront && (
            <button
              type="button"
              className="gc-head-btn"
              aria-label={flipped ? "Show the card" : "Show the chat"}
              title={flipped ? "Show the card" : "Show the chat"}
              onClick={(e) => {
                e.stopPropagation();
                setFlipped(!flipped);
              }}
            >
              {flipped ? <PanelTop size={12} /> : <MessageSquare size={12} />}
            </button>
          )}
          <WarmPill
            lastApiAtMs={lastApiAtMs}
            keepWarmUntil={keepWarmUntil}
            onAddHours={hasPromptCache ? addKeepWarmHours : undefined}
            onDisable={handleStopKeepWarm}
          />
          <button
            type="button"
            className="gc-head-btn"
            aria-label="Open as a full chat"
            title="Open as a full chat"
            onClick={(e) => {
              e.stopPropagation();
              void onOpen(entry.repoPath, entry.chatId);
            }}
          >
            <ArrowUpRight size={13} />
          </button>
        </div>
      </div>

      <GridSubagents
        list={subagents}
        focused={focused}
        onStopTask={agent.stopBackgroundTask}
        onOpenChat={openSubagentChat}
      />

      <div className="gc-card-body">
        {showFront ? (
          <FrontPage
            page={page}
            onAnswer={(label) => agent.send(label, { model, permissionMode })}
            onDraft={(label) => {
              setOptionDraft(`${label}: `);
              setComposerOpen(true);
            }}
          />
        ) : (
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
        )}
      </div>

      <div className="gc-card-dock" ref={dockRef} onClick={(e) => e.stopPropagation()}>
        <ChatBanners
          chatId={entry.chatId}
          model={model}
          contextTokens={agent.contextUsage?.usedTokens ?? 0}
          lastApiAtMs={lastApiAtMs}
          busy={agent.isStreaming || agent.status === "running" || agent.status === "queued"}
          notice={agent.notice}
          slotQueue={agent.slotQueue}
          handoffTo={agent.meta.handoffTo}
          onOpenChat={(id) => void onContinue(entry, id)}
          hideCostWarning
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
          className="composer-dock gc-card-composer"
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
            className={`gc-card-composer-slot${composerOpen ? "" : " gc-card-composer-slot--hidden"}`}
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
              prefill={optionDraft ?? (agent.turns.length === 0 ? agent.meta.handoffPrefill : null)}
              simplified
            />
          </div>
        </div>
      </div>

      {!prompt && !composerOpen && (
        <button
          type="button"
          className="gc-card-bubble"
          title="Message this agent"
          onClick={(e) => {
            e.stopPropagation();
            setComposerOpen(true);
          }}
        >
          <MessageCircle size={14} />
          <span>Message</span>
        </button>
      )}

      {/* Zoomed far out the transcript is hidden and this takes its place: the
          repo and the chat's name, on the repo's tint, under a badge while it
          needs you and over a count of its working subagents. */}
      <div className="gc-label" aria-hidden>
        {attention && (
          <span className="gc-label-flag">
            <StatusIcon status={status} />
            {ATTENTION_LABEL[status]}
          </span>
        )}
        <span className="gc-label-repo">{entry.repoName}</span>
        <span className="gc-label-title">{title}</span>
        {subagents.working > 0 && (
          <span className="gc-label-agents">
            <Bot />
            {subagents.working} subagent{subagents.working === 1 ? "" : "s"} running
          </span>
        )}
      </div>
      <div className="gc-edges" aria-hidden />

      <div className="gc-resize gc-resize--e" onPointerDown={(e) => onBeginResize(e, entry.chatId, "e")} />
      <div className="gc-resize gc-resize--s" onPointerDown={(e) => onBeginResize(e, entry.chatId, "s")} />
      <div className="gc-resize gc-resize--se" onPointerDown={(e) => onBeginResize(e, entry.chatId, "se")} />

      {/* The window is transformed with the canvas, which would trap a fixed
          overlay, so the MCP panel portals out to <body>. */}
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
});
