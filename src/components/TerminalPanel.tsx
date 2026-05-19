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

  const [isOpen, setIsOpen]       = useState(saved?.isOpen ?? false);
  const [height, setHeight]       = useState(saved?.height ?? 280);
  const [tabs, setTabs]           = useState<TerminalTab[]>(() =>
    saved?.tabs?.length ? saved.tabs : [makeTab(defaultCwd, 0)]
  );
  const [activeTabId, setActiveTabId] = useState<string | null>(() =>
    saved?.activeTabId ?? null
  );

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

  useEffect(() => {
    const ws = new WebSocket("ws://localhost:8787/terminal");
    wsRef.current = ws;

    ws.onopen = () => {
      wsOpenRef.current = true;
      for (const msg of pendingRef.current) ws.send(JSON.stringify(msg));
      pendingRef.current = [];
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type: string; tabId: string; data?: string; code?: number;
        };
        if (msg.type === "output" && msg.data) {
          terminalsRef.current.get(msg.tabId)?.terminal.write(msg.data);
        } else if (msg.type === "exit") {
          const inst = terminalsRef.current.get(msg.tabId);
          if (inst) {
            inst.terminal.write(
              "\r\n\x1b[2m[process exited — press Enter to restart]\x1b[0m\r\n"
            );
            // Restart on next keystroke
            const onData = inst.terminal.onData((d) => {
              if (d === "\r" || d === "\n") {
                onData.dispose();
                const tab = tabs.find((t) => t.id === msg.tabId);
                if (tab) wsSend({ type: "create", tabId: tab.id, cwd: tab.cwd });
              }
            });
          }
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => { wsOpenRef.current = false; };

    return () => {
      wsOpenRef.current = false;
      ws.close();
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
      fontSize: 12,
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      allowTransparency: false,
      macOptionIsMeta: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(container);

    terminal.onData((data) => wsSend({ type: "input", tabId: tab.id, data }));
    terminal.onResize(({ cols, rows }) => wsSend({ type: "resize", tabId: tab.id, cols, rows }));

    terminalsRef.current.set(tab.id, { terminal, fitAddon });

    // Tell the server to spawn the PTY, then fit so xterm knows its dimensions
    wsSend({ type: "create", tabId: tab.id, cwd: tab.cwd });
    requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.focus();
    });
  }, [wsSend]);

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
        requestAnimationFrame(() => {
          inst.fitAddon.fit();
          inst.terminal.focus();
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

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
        requestAnimationFrame(() => {
          inst.fitAddon.fit();
          inst.terminal.focus();
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // Refit visible terminal after panel height changes (drag resize)
  useEffect(() => {
    if (!isOpen || !activeTabId) return;
    const inst = terminalsRef.current.get(activeTabId);
    if (inst) requestAnimationFrame(() => inst.fitAddon.fit());
  }, [height, isOpen, activeTabId]);

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

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragStateRef.current) return;
      const delta = dragStateRef.current.startY - ev.clientY;
      const next = Math.max(120, Math.min(700, dragStateRef.current.startHeight + delta));
      setHeight(next);
    };

    const onMouseUp = () => {
      dragStateRef.current = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      if (activeTabId) {
        const inst = terminalsRef.current.get(activeTabId);
        requestAnimationFrame(() => inst?.fitAddon.fit());
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [height, activeTabId]);

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

  return (
    <div
      className={`terminal-panel${isOpen ? " terminal-panel--open" : ""}`}
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
