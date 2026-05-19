import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Plus, X, ChevronDown, Terminal as TerminalIcon } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

// ── Types ──────────────────────────────────────────────────────────────────────

interface TerminalTab {
  id: string;
  name: string;
  cwd: string;
}

interface StoredState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  height: number;
  isOpen: boolean;
}

export interface TerminalPanelProps {
  repoPath: string;
  defaultCwd: string;
  /** When true the entire panel is hidden (display:none) but stays mounted,
   *  keeping WebSocket + PTY sessions alive across repo switches. */
  hidden?: boolean;
}

const TERMINAL_FONT_SIZE = 11;
const MIN_FIT_WIDTH = 40;
const MIN_FIT_HEIGHT = 40;

// ── Helpers ────────────────────────────────────────────────────────────────────

function storageKey(repoPath: string) {
  return `buildover.terminal.${repoPath}`;
}

function loadState(repoPath: string): StoredState | null {
  try {
    const raw = localStorage.getItem(storageKey(repoPath));
    if (raw) return JSON.parse(raw) as StoredState;
  } catch { /* ignore */ }
  return null;
}

function makeTab(cwd: string, count: number): TerminalTab {
  return {
    id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: `shell ${count + 1}`,
    cwd,
  };
}

const XTERM_THEME = {
  background:       "#181818",
  foreground:       "#cccccc",
  cursor:           "#d97757",
  cursorAccent:     "#181818",
  selectionBackground: "rgba(4,57,94,0.6)",
  black:            "#1e1e1e",
  brightBlack:      "#555555",
  red:              "#f48771",
  brightRed:        "#f14c4c",
  green:            "#89d185",
  brightGreen:      "#23d18b",
  yellow:           "#cca700",
  brightYellow:     "#f5f543",
  blue:             "#569cd6",
  brightBlue:       "#3b8eea",
  magenta:          "#c586c0",
  brightMagenta:    "#d670d6",
  cyan:             "#4ec9b0",
  brightCyan:       "#29b8db",
  white:            "#cccccc",
  brightWhite:      "#e5e5e5",
};

// ── Component ──────────────────────────────────────────────────────────────────

export function TerminalPanel({ repoPath, defaultCwd, hidden }: TerminalPanelProps) {
  const key = storageKey(repoPath);
  const saved = loadState(repoPath);
  const initialTabsRef = useRef<TerminalTab[] | null>(null);
  if (!initialTabsRef.current) {
    initialTabsRef.current = saved?.tabs?.length ? saved.tabs : [makeTab(defaultCwd, 0)];
  }
  const initialTabs = initialTabsRef.current;

  const [isOpen, setIsOpen]       = useState(saved?.isOpen ?? false);
  const [height, setHeight]       = useState(saved?.height ?? 280);
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [tabs, setTabs]           = useState<TerminalTab[]>(() => initialTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(() =>
    saved?.activeTabId && initialTabs.some((t) => t.id === saved.activeTabId)
      ? saved.activeTabId
      : initialTabs[0]?.id ?? null
  );
  const [settingUpTabIds, setSettingUpTabIds] = useState<Set<string>>(() => new Set(initialTabs.map((t) => t.id)));
  const tabsRef = useRef(tabs);
  const settingUpTabIdsRef = useRef(settingUpTabIds);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    settingUpTabIdsRef.current = settingUpTabIds;
  }, [settingUpTabIds]);

  // Ensure activeTabId is always in sync with tabs list
  useEffect(() => {
    setActiveTabId((prev) => {
      if (prev && tabs.some((t) => t.id === prev)) return prev;
      return tabs[0]?.id ?? null;
    });
  }, [tabs]);

  // Persist state to localStorage whenever relevant bits change
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ isOpen, height, tabs, activeTabId }));
    } catch { /* ignore */ }
  }, [isOpen, height, tabs, activeTabId, key]);

  // ── xterm.js instances (one per tab, kept alive across tab switches) ─────────
  const terminalsRef = useRef<Map<string, { terminal: Terminal; fitAddon: FitAddon }>>(new Map());
  // DOM container refs — set via ref-callback on each container div
  const containerRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  const setTabSettingUp = useCallback((tabId: string, isSettingUp: boolean) => {
    const next = new Set(settingUpTabIdsRef.current);
    if (isSettingUp) {
      next.add(tabId);
    } else {
      next.delete(tabId);
    }

    settingUpTabIdsRef.current = next;
    const inst = terminalsRef.current.get(tabId);
    if (inst) inst.terminal.options.disableStdin = isSettingUp;
    setSettingUpTabIds(next);
  }, []);

  // ── WebSocket ─────────────────────────────────────────────────────────────────
  const wsRef            = useRef<WebSocket | null>(null);
  const wsOpenRef        = useRef(false);
  const pendingRef       = useRef<object[]>([]);

  const wsSend = useCallback((msg: object) => {
    if (wsRef.current && wsOpenRef.current) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      pendingRef.current.push(msg);
    }
  }, []);

  const fitTerminalWhenReady = useCallback((
    tabId: string,
    terminal: Terminal,
    fitAddon: FitAddon,
    options: { focus?: boolean; attempts?: number } = {}
  ) => {
    const { focus = false, attempts = 8 } = options;

    const tryFit = (remaining: number) => {
      const container = containerRefs.current.get(tabId);
      if (!container) return;

      const rect = container.getBoundingClientRect();
      if (!hidden && isOpen && rect.width >= MIN_FIT_WIDTH && rect.height >= MIN_FIT_HEIGHT) {
        fitAddon.fit();
        if (focus) terminal.focus();
        return;
      }

      if (remaining > 0) {
        requestAnimationFrame(() => tryFit(remaining - 1));
      }
    };

    requestAnimationFrame(() => tryFit(attempts));
  }, [hidden, isOpen]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (disposed) return;

      const ws = new WebSocket("ws://localhost:8787/terminal");
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return;
        wsOpenRef.current = true;

        for (const tab of tabsRef.current) {
          if (terminalsRef.current.has(tab.id)) {
            setTabSettingUp(tab.id, true);
            ws.send(JSON.stringify({ type: "create", tabId: tab.id, cwd: tab.cwd }));
          }
        }

        for (const msg of pendingRef.current) ws.send(JSON.stringify(msg));
        pendingRef.current = [];
      };

      ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type: string; tabId: string; data?: string; code?: number;
          };
          if (msg.type === "output" && msg.data) {
            setTabSettingUp(msg.tabId, false);
            terminalsRef.current.get(msg.tabId)?.terminal.write(msg.data);
          } else if (msg.type === "exit") {
            const inst = terminalsRef.current.get(msg.tabId);
            if (inst) {
              setTabSettingUp(msg.tabId, true);
              inst.terminal.write(
                "\r\n\x1b[2m[process exited - restarting]\x1b[0m\r\n"
              );
              const tab = tabsRef.current.find((t) => t.id === msg.tabId);
              if (tab) wsSend({ type: "create", tabId: tab.id, cwd: tab.cwd });
            }
          }
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsOpenRef.current = false;
          wsRef.current = null;
        }
        for (const tabId of terminalsRef.current.keys()) {
          setTabSettingUp(tabId, true);
        }
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, 500);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      wsOpenRef.current = false;
      wsRef.current?.close();
      wsRef.current = null;
    };
  // Only run once per mount — ws lifecycle is independent of prop changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Terminal initialisation ────────────────────────────────────────────────────

  const initTerminal = useCallback((tab: TerminalTab, container: HTMLDivElement) => {
    if (terminalsRef.current.has(tab.id)) return;

    const terminal = new Terminal({
      theme: XTERM_THEME,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      allowTransparency: false,
      macOptionIsMeta: true,
      disableStdin: settingUpTabIdsRef.current.has(tab.id),
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(container);

    terminal.onData((data) => {
      if (settingUpTabIdsRef.current.has(tab.id) || !wsOpenRef.current) return;
      wsSend({ type: "input", tabId: tab.id, data });
    });
    terminal.onResize(({ cols, rows }) => wsSend({ type: "resize", tabId: tab.id, cols, rows }));

    terminalsRef.current.set(tab.id, { terminal, fitAddon });

    // Tell the server to spawn the PTY, then fit so xterm knows its dimensions
    setTabSettingUp(tab.id, true);
    wsSend({ type: "create", tabId: tab.id, cwd: tab.cwd });
    fitTerminalWhenReady(tab.id, terminal, fitAddon, { focus: true });
  }, [fitTerminalWhenReady, setTabSettingUp, wsSend]);

  // Ref-callback: called whenever a container div mounts/unmounts.
  // Initialises immediately (panel closed or not) so PTYs are pre-warmed.
  const setContainerRef = useCallback((tabId: string, el: HTMLDivElement | null) => {
    containerRefs.current.set(tabId, el);
    if (el) {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab && !terminalsRef.current.has(tabId)) {
        initTerminal(tab, el);
      }
    }
  }, [tabs, initTerminal]);

  // When the panel opens, initialise the active tab and focus it
  useEffect(() => {
    if (!isOpen || !activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    const container = containerRefs.current.get(activeTabId);
    if (tab && container && !terminalsRef.current.has(activeTabId)) {
      initTerminal(tab, container);
    } else {
      const inst = terminalsRef.current.get(activeTabId);
      if (inst) {
        fitTerminalWhenReady(activeTabId, inst.terminal, inst.fitAddon, { focus: true });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, hidden]);

  // When switching tabs, fit + focus the newly visible terminal
  useEffect(() => {
    if (!isOpen || !activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    const container = containerRefs.current.get(activeTabId);
    if (tab && container && !terminalsRef.current.has(activeTabId)) {
      initTerminal(tab, container);
    } else {
      const inst = terminalsRef.current.get(activeTabId);
      if (inst) {
        fitTerminalWhenReady(activeTabId, inst.terminal, inst.fitAddon, { focus: true });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, hidden]);

  // Refit visible terminal after panel height changes (not during drag — fit on mouseup)
  useEffect(() => {
    if (isResizing || !isOpen || !activeTabId) return;
    const inst = terminalsRef.current.get(activeTabId);
    if (inst) fitTerminalWhenReady(activeTabId, inst.terminal, inst.fitAddon);
  }, [height, isOpen, activeTabId, isResizing, fitTerminalWhenReady]);

  // ── Tab management ─────────────────────────────────────────────────────────────

  const addTab = useCallback(() => {
    const newTab = makeTab(defaultCwd, tabs.length);
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [defaultCwd, tabs.length]);

  const closeTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    wsSend({ type: "destroy", tabId });
    const inst = terminalsRef.current.get(tabId);
    if (inst) {
      inst.terminal.dispose();
      terminalsRef.current.delete(tabId);
    }
    containerRefs.current.delete(tabId);
    setSettingUpTabIds((prev) => {
      const next = new Set(prev);
      next.delete(tabId);
      settingUpTabIdsRef.current = next;
      return next;
    });
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) {
        const replacement = makeTab(defaultCwd, 0);
        setActiveTabId(replacement.id);
        return [replacement];
      }
      return next;
    });
    setActiveTabId((prev) => {
      if (prev !== tabId) return prev;
      const remaining = tabs.filter((t) => t.id !== tabId);
      return remaining[remaining.length - 1]?.id ?? null;
    });
  }, [wsSend, defaultCwd, tabs]);

  // ── Drag-to-resize ─────────────────────────────────────────────────────────────

  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = { startY: e.clientY, startHeight: height };
    setIsResizing(true);

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragStateRef.current) return;
      const delta = dragStateRef.current.startY - ev.clientY;
      const next = Math.max(120, Math.min(700, dragStateRef.current.startHeight + delta));
      // Update DOM directly — avoid React re-renders, localStorage writes, and
      // xterm refits on every mousemove (those made drag feel extremely laggy).
      if (panelRef.current) panelRef.current.style.height = `${next}px`;
    };

    const onMouseUp = () => {
      const panel = panelRef.current;
      const finalHeight = panel?.style.height
        ? parseInt(panel.style.height, 10)
        : dragStateRef.current?.startHeight ?? height;
      dragStateRef.current = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      setIsResizing(false);
      if (Number.isFinite(finalHeight)) setHeight(finalHeight);
      if (activeTabId) {
        const inst = terminalsRef.current.get(activeTabId);
        if (inst) fitTerminalWhenReady(activeTabId, inst.terminal, inst.fitAddon);
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [height, activeTabId, fitTerminalWhenReady]);

  const handlePanelTransitionEnd = useCallback((e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.propertyName !== "height" || !isOpen || !activeTabId) return;
    const inst = terminalsRef.current.get(activeTabId);
    if (inst) fitTerminalWhenReady(activeTabId, inst.terminal, inst.fitAddon, { focus: true });
  }, [activeTabId, fitTerminalWhenReady, isOpen]);

  // ── Keyboard shortcut: Cmd+T ──────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "t") {
        e.preventDefault();
        setIsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      for (const [tabId, inst] of terminalsRef.current) {
        wsSend({ type: "destroy", tabId });
        inst.terminal.dispose();
      }
      terminalsRef.current.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────────
  const activeTabSettingUp = activeTabId ? settingUpTabIds.has(activeTabId) : false;

  return (
    <div
      ref={panelRef}
      className={`terminal-panel${isOpen ? " terminal-panel--open" : ""}${isResizing ? " terminal-panel--resizing" : ""}`}
      onTransitionEnd={handlePanelTransitionEnd}
      style={{
        ...(isOpen ? { height } : {}),
        // Keep mounted but invisible when another repo is active
        ...(hidden ? { display: "none" } : {}),
      }}
    >
      {/* Drag handle — only shown when open */}
      {isOpen && (
        <div
          className="terminal-resize-handle"
          onMouseDown={handleResizeMouseDown}
          title="Drag to resize"
        />
      )}

      {/* Header bar — always visible */}
      <div className="terminal-header" onClick={() => setIsOpen((v) => !v)}>
        <div className="terminal-header-left">
          <TerminalIcon size={12} />
          <span className="terminal-header-label">Terminal</span>
          <span className="terminal-header-hint">⌘T</span>
        </div>
        {/* stopPropagation so button clicks don't also toggle the panel */}
        <div className="terminal-header-right" onClick={(e) => e.stopPropagation()}>
          {isOpen && (
            <button className="terminal-header-btn" onClick={addTab} title="New terminal tab">
              <Plus size={12} />
            </button>
          )}
          <button
            className="terminal-header-btn"
            onClick={() => setIsOpen((v) => !v)}
            title={isOpen ? "Collapse terminal (⌘T)" : "Expand terminal (⌘T)"}
          >
            <ChevronDown
              size={13}
              className={`terminal-chevron${isOpen ? "" : " terminal-chevron--up"}`}
            />
          </button>
        </div>
      </div>

      {/* Body — always in DOM so PTYs are pre-warmed; hidden via CSS until open */}
      <div className="terminal-body" style={{ display: isOpen ? undefined : "none" }}>
        {/* xterm viewport area (left, flex: 1) */}
        <div className="terminal-xterm-area">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              ref={(el) => setContainerRef(tab.id, el)}
              className="terminal-xterm-container"
              style={{ display: tab.id === activeTabId ? "flex" : "none" }}
            />
          ))}
          {activeTabSettingUp && (
            <div className="terminal-loading-overlay" aria-live="polite">
              <span className="terminal-loading-spinner" />
              <span>Setting up terminal</span>
            </div>
          )}
        </div>

        {/* Tab list (right sidebar) */}
        <div className="terminal-tab-list">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-tab${tab.id === activeTabId ? " terminal-tab--active" : ""}`}
              onClick={() => setActiveTabId(tab.id)}
              title={tab.cwd}
            >
              <TerminalIcon size={11} className="terminal-tab-icon" />
              <span className="terminal-tab-name">{tab.name}</span>
              <button
                className="terminal-tab-close"
                onClick={(e) => closeTab(tab.id, e)}
                title="Close terminal"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
