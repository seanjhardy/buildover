import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { X, Save, Loader, AlertCircle, Search, Code, Eye } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { fileApi } from "../lib/api.js";
import { openExternalUrl } from "../lib/openExternalUrl.js";
import { resolveFileIcon } from "./FileExplorerSidebar.js";
import {
  getLanguage,
  getLanguageLabel,
  highlightContent,
  highlightLine as sharedHighlightLine,
  isImageFile,
} from "../lib/highlight.js";

// ── Tab state ──────────────────────────────────────────────────────────────────

interface TabState {
  path: string;
  relPath: string;
  content: string | null;
  savedContent: string | null;
  loading: boolean;
  error: string | null;
  scrollTop: number;
  scrollLeft: number;
  /** Markdown only — show the rendered preview instead of the source editor */
  preview: boolean;
}

export interface OpenEditorFile {
  /** Absolute path */
  path: string;
  /** Path relative to repoPath */
  relPath: string;
  /** Optional line to jump to when first opened */
  initialLine?: number;
}

interface Props {
  files: OpenEditorFile[];
  activeFilePath: string | null;
  repoPath: string;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onFileOpen: (relPath: string, line?: number) => void;
  /** When set, immediately scroll the named file to this line (used for search-result clicks on already-open files) */
  jumpTarget?: { path: string; line: number } | null;
  onJumpConsumed?: () => void;
}

// ── Quick-open dropdown ────────────────────────────────────────────────────────

function QuickOpenBar({
  repoPath,
  onFileOpen,
}: {
  repoPath: string;
  onFileOpen: (relPath: string) => void;
}) {
  const [open, setOpen]             = useState(false);
  const [query, setQuery]           = useState("");
  const [allFiles, setAllFiles]     = useState<string[]>([]);
  const [loading, setLoading]       = useState(false);
  const [selected, setSelected]     = useState(0);
  const inputRef                    = useRef<HTMLInputElement>(null);
  const containerRef                = useRef<HTMLDivElement>(null);
  const repoName                    = repoPath.split("/").pop() ?? repoPath;

  // Load file list lazily when first opened
  useEffect(() => {
    if (!open || allFiles.length > 0) return;
    setLoading(true);
    fileApi.listFiles(repoPath)
      .then((f) => setAllFiles(f))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, repoPath, allFiles.length]);

  // Reset file list when repo changes
  useEffect(() => { setAllFiles([]); }, [repoPath]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allFiles.slice(0, 80);
    const q = query.toLowerCase();
    return allFiles
      .filter((f) => f.toLowerCase().includes(q))
      .slice(0, 80);
  }, [allFiles, query]);

  useEffect(() => { setSelected(0); }, [query]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const openBar = () => {
    setOpen(true);
    setQuery("");
    setSelected(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const pick = (relPath: string) => {
    setOpen(false);
    setQuery("");
    onFileOpen(relPath);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); setQuery(""); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); return; }
    if (e.key === "Enter" && filtered[selected]) { pick(filtered[selected]!); return; }
  };

  return (
    <div className="fe-quickopen-wrap" ref={containerRef}>
      {/* Bar — always present, never shifts layout */}
      <div className="fe-quickopen-bar">
        <div
          className={`fe-quickopen-pill${open ? " fe-quickopen-pill--open" : ""}`}
          onClick={!open ? openBar : undefined}
        >
          <Search size={12} className="fe-quickopen-icon" />
          {open ? (
            <input
              ref={inputRef}
              className="fe-quickopen-input"
              placeholder={`Search in ${repoName}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoComplete="off"
            />
          ) : (
            <span className="fe-quickopen-label">{repoName}</span>
          )}
          {open && (
            <button
              className="fe-quickopen-close"
              onMouseDown={(e) => { e.preventDefault(); setOpen(false); setQuery(""); }}
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Floating dropdown — position:absolute, zero layout impact */}
      {open && (loading || filtered.length > 0 || query.trim().length > 0) && (
        <div className="fe-quickopen-dropdown">
          {loading && <div className="fe-quickopen-hint">Loading files…</div>}
          {!loading && filtered.length === 0 && query && (
            <div className="fe-quickopen-hint">No files match "{query}"</div>
          )}
          {!loading && filtered.map((relPath, i) => {
            const name = relPath.split("/").pop() ?? relPath;
            const dir  = relPath.includes("/") ? relPath.split("/").slice(0, -1).join("/") : "";
            return (
              <div
                key={relPath}
                className={`fe-quickopen-item${i === selected ? " fe-quickopen-item--selected" : ""}`}
                onMouseDown={() => pick(relPath)}
                onMouseEnter={() => setSelected(i)}
              >
                <img src={resolveFileIcon(name)} alt="" className="fe-quickopen-icon-file" draggable={false} />
                <span className="fe-quickopen-filename">{name}</span>
                {dir && <span className="fe-quickopen-dir">{dir}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Markdown preview ───────────────────────────────────────────────────────────

/** Resolve a link/image target relative to the markdown file's directory.
 *  Returns a repo-relative path, or null for external / in-page targets. */
function resolveRepoRelative(fileRelPath: string, target: string): string | null {
  if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
    return null;
  }
  const clean = decodeURIComponent(target.split(/[?#]/)[0] ?? "");
  const parts = clean.startsWith("/") ? [] : fileRelPath.split("/").slice(0, -1);
  for (const seg of clean.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function MarkdownPreview({
  content,
  relPath,
  repoPath,
  onFileOpen,
}: {
  content: string;
  relPath: string;
  repoPath: string;
  onFileOpen: (relPath: string) => void;
}) {
  const components = useMemo((): Components => ({
    // Never let a link navigate the app window: external URLs go to the system
    // browser, relative links open the target file in a new editor tab.
    a: ({ href, children, node: _node, ...rest }) => (
      <a
        {...rest}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (!href) return;
          if (href.startsWith("#")) {
            const id = decodeURIComponent(href.slice(1));
            e.currentTarget.closest(".fe-markdown-wrap")?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView();
            return;
          }
          const target = resolveRepoRelative(relPath, href);
          if (target) onFileOpen(target);
          else openExternalUrl(href);
        }}
      >
        {children}
      </a>
    ),
    // Serve repo-relative images through the file API.
    img: ({ src, alt, node: _node, ...rest }) => {
      const target = typeof src === "string" ? resolveRepoRelative(relPath, src) : null;
      const resolved = target !== null
        ? `/api/file/serve?path=${encodeURIComponent(`${repoPath}/${target}`)}`
        : src;
      return <img {...rest} src={resolved} alt={alt ?? ""} />;
    },
  }), [relPath, repoPath, onFileOpen]);

  return (
    <div className="fe-markdown-wrap">
      <div className="file-viewer-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function FileEditorPane({
  files,
  activeFilePath,
  repoPath,
  onActivate,
  onClose,
  onFileOpen,
  jumpTarget,
  onJumpConsumed,
}: Props) {
  const [tabs, setTabs] = useState<Map<string, TabState>>(new Map());
  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const highlightRef   = useRef<HTMLPreElement>(null);
  const gutterRef      = useRef<HTMLDivElement>(null);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Track which paths need a line-jump after content loads
  const pendingLineJump = useRef<Map<string, number>>(new Map());

  // ── Load file content when a new tab is added ────────────────────────────────
  useEffect(() => {
    for (const file of files) {
      if (tabsRef.current.has(file.path)) continue;
      const tabFilename = file.relPath.split("/").pop() ?? file.relPath;
      const tabIsImage  = isImageFile(tabFilename);
      // Markdown opens rendered, unless we were asked to jump to a specific line.
      const tabPreview  = getLanguage(tabFilename) === "markdown" && !file.initialLine;

      // Register any initial line jump request
      if (file.initialLine) pendingLineJump.current.set(file.path, file.initialLine);

      setTabs((prev) => {
        if (prev.has(file.path)) return prev;
        const next = new Map(prev);
        next.set(file.path, {
          path: file.path, relPath: file.relPath,
          content: null, savedContent: null,
          loading: !tabIsImage, error: null,
          scrollTop: 0, scrollLeft: 0,
          preview: tabPreview,
        });
        return next;
      });

      if (!tabIsImage) {
        fileApi
          .readFile(file.path)
          .then((text) => {
            setTabs((prev) => {
              const existing = prev.get(file.path);
              if (!existing) return prev;
              const next = new Map(prev);
              next.set(file.path, { ...existing, content: text, savedContent: text, loading: false, error: null });
              return next;
            });
          })
          .catch((err: unknown) => {
            setTabs((prev) => {
              const existing = prev.get(file.path);
              if (!existing) return prev;
              const next = new Map(prev);
              next.set(file.path, { ...existing, loading: false, error: err instanceof Error ? err.message : String(err) });
              return next;
            });
          });
      }
    }
    // Prune closed tabs
    setTabs((prev) => {
      const openPaths = new Set(files.map((f) => f.path));
      let changed = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!openPaths.has(key)) { next.delete(key); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [files]);

  // ── Scroll to initial line once content loads ─────────────────────────────────
  const activeTab = activeFilePath ? tabs.get(activeFilePath) : null;
  useLayoutEffect(() => {
    if (!activeFilePath || !activeTab || activeTab.loading) return;
    const targetLine = pendingLineJump.current.get(activeFilePath);
    if (!targetLine || !textareaRef.current) return;
    pendingLineJump.current.delete(activeFilePath);
    const LINE_H = 20;
    const PADDING = 14;
    const visibleRows = Math.floor(textareaRef.current.clientHeight / LINE_H);
    const scrollTop = Math.max(0, (targetLine - 1) * LINE_H + PADDING - Math.floor(visibleRows / 3) * LINE_H);
    textareaRef.current.scrollTop = scrollTop;
    syncHighlightScroll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilePath, activeTab?.loading, activeTab?.content]);

  const setPreview = useCallback((path: string, preview: boolean) => {
    setTabs((prev) => {
      const existing = prev.get(path);
      if (!existing || existing.preview === preview) return prev;
      const next = new Map(prev);
      next.set(path, { ...existing, preview });
      return next;
    });
  }, []);

  // ── Handle explicit jump target (search result click on already-open file) ───
  useLayoutEffect(() => {
    if (!jumpTarget) return;
    if (jumpTarget.path !== activeFilePath) return;
    const tab = tabsRef.current.get(jumpTarget.path);
    if (!tab || tab.loading) return;
    // Line jumps need the source editor — leave preview and retry once it mounts.
    if (tab.preview) { setPreview(jumpTarget.path, false); return; }
    if (!textareaRef.current) return;
    const LINE_H = 20;
    const PADDING = 14;
    const visibleRows = Math.floor(textareaRef.current.clientHeight / LINE_H);
    const scrollTop = Math.max(0, (jumpTarget.line - 1) * LINE_H + PADDING - Math.floor(visibleRows / 3) * LINE_H);
    textareaRef.current.scrollTop = scrollTop;
    syncHighlightScroll();
    onJumpConsumed?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTarget, activeTab?.preview]);

  // ── Save scroll position when switching tabs ─────────────────────────────────
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (prev && prev !== activeFilePath && textareaRef.current) {
      const scrollTop  = textareaRef.current.scrollTop;
      const scrollLeft = textareaRef.current.scrollLeft;
      setTabs((t) => {
        const existing = t.get(prev);
        if (!existing) return t;
        const next = new Map(t);
        next.set(prev, { ...existing, scrollTop, scrollLeft });
        return next;
      });
    }
    prevActiveRef.current = activeFilePath;
  }, [activeFilePath]);

  // ── Restore scroll when switching to a tab ───────────────────────────────────
  useLayoutEffect(() => {
    if (!activeFilePath) return;
    const tab = tabsRef.current.get(activeFilePath);
    if (!tab || tab.loading || !textareaRef.current) return;
    // Don't restore scroll if a line jump is still pending
    if (pendingLineJump.current.has(activeFilePath)) return;
    textareaRef.current.scrollTop  = tab.scrollTop;
    textareaRef.current.scrollLeft = tab.scrollLeft;
    syncHighlightScroll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilePath]);

  // ── Sync highlighted layer scroll to textarea ────────────────────────────────
  const syncHighlightScroll = useCallback(() => {
    const ta     = textareaRef.current;
    const pre    = highlightRef.current;
    const gutter = gutterRef.current;
    if (!ta || !pre) return;
    pre.scrollTop  = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    if (gutter) gutter.scrollTop = ta.scrollTop;
  }, []);

  // ── Save handler ─────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!activeFilePath) return;
    const tab = tabsRef.current.get(activeFilePath);
    if (!tab || tab.content === null) return;
    try {
      await fileApi.writeFile(activeFilePath, tab.content);
      setTabs((prev) => {
        const existing = prev.get(activeFilePath);
        if (!existing) return prev;
        const next = new Map(prev);
        next.set(activeFilePath, { ...existing, savedContent: existing.content });
        return next;
      });
    } catch (err) {
      console.error("Failed to save file:", err);
    }
  }, [activeFilePath]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); void handleSave(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // ── Content change ────────────────────────────────────────────────────────────
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!activeFilePath) return;
    const newContent = e.target.value;
    setTabs((prev) => {
      const existing = prev.get(activeFilePath);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(activeFilePath, { ...existing, content: newContent });
      return next;
    });
  }, [activeFilePath]);

  // ── Tab key inserts 2 spaces ──────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const spaces = "  ";
      const newValue = ta.value.substring(0, start) + spaces + ta.value.substring(ta.selectionEnd);
      if (activeFilePath) {
        setTabs((prev) => {
          const existing = prev.get(activeFilePath);
          if (!existing) return prev;
          const next = new Map(prev);
          next.set(activeFilePath, { ...existing, content: newValue });
          return next;
        });
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.selectionStart = start + spaces.length;
            textareaRef.current.selectionEnd   = start + spaces.length;
          }
        });
      }
    }
  }, [activeFilePath]);

  // ── Derived values ────────────────────────────────────────────────────────────
  const isDirty = !!activeTab && activeTab.content !== null && activeTab.content !== activeTab.savedContent;

  const filename = activeTab ? activeTab.relPath.split("/").pop() ?? activeTab.relPath : null;
  const lang      = filename ? getLanguage(filename) : "plaintext";
  const langLabel = filename ? getLanguageLabel(filename) : "";
  const isImage   = filename ? isImageFile(filename) : false;
  const isMarkdown = lang === "markdown";
  const showPreview = isMarkdown && !!activeTab?.preview && activeTab.content !== null;

  const highlightedLines = useMemo(
    () => (activeTab?.content != null ? highlightContent(activeTab.content, lang) : null),
    [activeTab?.content, lang],
  );

  const lineCount   = useMemo(() => (!activeTab?.content ? 0 : activeTab.content.split("\n").length), [activeTab?.content]);
  const lineNumbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1), [lineCount]);

  const highlightLine = useCallback((text: string) => sharedHighlightLine(text, lang), [lang]);
  void highlightLine;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="fe-pane">
      {/* Quick-open pill bar */}
      <QuickOpenBar repoPath={repoPath} onFileOpen={(relPath) => onFileOpen(relPath)} />

      {files.length === 0 ? (
        <div className="fe-pane--empty fe-pane-inner">
          <div className="fe-empty-hint">Select a file from the Explorer to open it</div>
        </div>
      ) : (
        <>
          {/* Tab bar */}
          <div className="fe-tabs">
            {files.map((file) => {
              const tab      = tabs.get(file.path);
              const tabDirty = !!tab && tab.content !== null && tab.content !== tab.savedContent;
              const tabName  = file.relPath.split("/").pop() ?? file.relPath;
              const isActive = file.path === activeFilePath;
              return (
                <div
                  key={file.path}
                  className={`fe-tab${isActive ? " fe-tab--active" : ""}`}
                  onClick={() => onActivate(file.path)}
                  title={file.relPath}
                >
                  <span className="fe-tab-name">{tabName}</span>
                  {tabDirty && <span className="fe-tab-dirty" title="Unsaved changes" />}
                  <button
                    className="fe-tab-close"
                    onClick={(e) => { e.stopPropagation(); onClose(file.path); }}
                    title="Close tab"
                    aria-label={`Close ${tabName}`}
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
            {activeTab && isMarkdown && (
              <button
                className="fe-tabs-action"
                onClick={() => setPreview(activeTab.path, !activeTab.preview)}
                title={activeTab.preview ? "Edit source" : "Preview markdown"}
                aria-label={activeTab.preview ? "Edit source" : "Preview markdown"}
              >
                {activeTab.preview ? <><Code size={12} />Edit</> : <><Eye size={12} />Preview</>}
              </button>
            )}
          </div>

          {/* Editor */}
          {activeTab && (
            <div className="fe-editor-wrap">
              {activeTab.loading && (
                <div className="fe-state"><Loader size={16} className="fe-spinner" /><span>Loading…</span></div>
              )}
              {activeTab.error && (
                <div className="fe-state fe-state--error"><AlertCircle size={16} /><span>{activeTab.error}</span></div>
              )}
              {/* Image preview */}
              {!activeTab.loading && !activeTab.error && isImage && (
                <div className="fe-image-wrap">
                  <img
                    src={`/api/file/serve?path=${encodeURIComponent(activeTab.path)}`}
                    alt={filename ?? "image"}
                    className="fe-image"
                  />
                </div>
              )}
              {/* Rendered markdown */}
              {!activeTab.loading && !activeTab.error && showPreview && (
                <MarkdownPreview
                  content={activeTab.content!}
                  relPath={activeTab.relPath}
                  repoPath={repoPath}
                  onFileOpen={onFileOpen}
                />
              )}
              {/* Text / code editor */}
              {!activeTab.loading && !activeTab.error && !isImage && !showPreview && activeTab.content !== null && (
                <div className="fe-editor">
                  <div className="fe-gutter" ref={gutterRef} aria-hidden="true">
                    {lineNumbers.map((n) => <div key={n} className="fe-gutter-row">{n}</div>)}
                  </div>
                  <div className="fe-code-area">
                    <pre className="fe-code-highlighted hljs" ref={highlightRef} aria-hidden="true">
                      {activeTab.content.split("\n").map((line, i) => (
                        highlightedLines ? (
                          <div key={i} className="fe-code-row" dangerouslySetInnerHTML={{ __html: (highlightedLines[i] ?? line) || "​" }} />
                        ) : (
                          <div key={i} className="fe-code-row">{line || "​"}</div>
                        )
                      ))}
                    </pre>
                    <textarea
                      ref={textareaRef}
                      className="fe-textarea"
                      value={activeTab.content}
                      onChange={handleChange}
                      onKeyDown={handleKeyDown}
                      onScroll={syncHighlightScroll}
                      spellCheck={false}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      data-gramm="false"
                      aria-label={`Edit ${filename ?? "file"}`}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Status bar */}
          {activeTab && !activeTab.loading && !activeTab.error && (
            <div className="fe-statusbar">
              {isImage ? (
                <span>{filename?.split(".").pop()?.toUpperCase() ?? "Image"}</span>
              ) : (
                <>
                  <span>{langLabel}</span>
                  <span>{lineCount} lines</span>
                  {isDirty ? (
                    <>
                      <span className="fe-statusbar-dirty">Unsaved changes</span>
                      <button className="fe-save-btn" onClick={() => void handleSave()} title="Save (Ctrl+S)">
                        <Save size={11} />Save
                      </button>
                    </>
                  ) : (
                    <span className="fe-statusbar-saved">Saved</span>
                  )}
                </>
              )}
              <span className="fe-statusbar-path">{activeTab.relPath}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
