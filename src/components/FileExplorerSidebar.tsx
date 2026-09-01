import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight, ChevronDown, Search, X, FilePlus2, FolderPlus, RefreshCw,
  ChevronsDownUp, Scissors, Copy, ClipboardPaste, CopyPlus, Link, Link2,
  PenLine, Trash2, FolderOpen, TerminalSquare, ExternalLink, FileText,
  SearchCode, AlertTriangle,
} from "lucide-react";
import { fileApi, type DirEntry, type FileSearchResult } from "../lib/api.js";
import { hasExternalFiles, readDroppedFiles } from "../lib/dropFiles.js";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu.js";
import type { FileEntry } from "../hooks/useFilesChanged.js";

// ── Icon helpers ────────────────────────────────────────────────────────────────

const BASE = "/file-icons";

const EXT_MAP: Record<string, string> = {
  "ts": "typescript.svg", "tsx": "react-alt.svg",
  "js": "javascript.svg", "mjs": "javascript.svg", "cjs": "javascript.svg",
  "es6": "javascript.svg", "jsx": "react.svg",
  "mts": "typescript.svg", "cts": "typescript.svg",
  "css": "css.svg", "scss": "sass.svg", "sass": "sass.svg", "less": "less.svg",
  "html": "html.svg", "htm": "html.svg",
  "json": "json.svg", "yml": "yaml.svg", "yaml": "yaml.svg",
  "toml": "toml.png", "xml": "settings.svg", "ini": "settings.svg",
  "conf": "settings.svg", "env": "dotenv.svg",
  "py": "python.svg", "rs": "rust.svg", "go": "go.svg",
  "rb": "ruby.svg", "php": "php.svg", "java": "java.svg",
  "cs": "csharp.svg", "cpp": "cpp.svg", "cc": "cpp.svg",
  "cxx": "cpp.svg", "c": "c.png", "h": "c-h.png", "hpp": "cpp-h.png",
  "swift": "swift.svg", "kt": "kotlin.svg", "kts": "kotlin.svg",
  "dart": "dart.svg", "lua": "lua.svg", "zig": "zig.svg",
  "tf": "terraform.svg", "r": "settings.svg",
  "md": "markdown.svg", "mdx": "mdx.svg",
  "txt": "notepad.svg", "log": "log.svg",
  "sh": "shell.png", "bash": "shell.png", "zsh": "shell.png", "fish": "shell.png",
  "sql": "database.svg", "db": "database.svg",
  "graphql": "graphql.svg", "gql": "graphql.svg",
  "prisma": "prisma.svg", "svg": "svg.svg", "pdf": "pdf.svg",
  "zip": "zip.svg", "rar": "zip.svg", "gz": "zip.svg",
  "png": "image.png", "jpg": "image.png", "jpeg": "image.png",
  "gif": "image.png", "webp": "image.png",
  "mp3": "audio.png", "wav": "audio.png",
  "mp4": "video.png", "webm": "video.png", "mov": "video.png",
};

const NAME_MAP: Record<string, string> = {
  "package.json": "npm.svg", "package-lock.json": "npm.svg",
  "dockerfile": "docker.svg", "docker-compose.yml": "docker.svg",
  "docker-compose.yaml": "docker.svg",
  ".gitignore": "git.svg", ".gitattributes": "git.svg",
  ".eslintrc": "eslint.svg", ".eslintrc.js": "eslint.svg",
  ".eslintrc.json": "eslint.svg", ".eslintrc.yml": "eslint.svg",
  ".prettierrc": "prettier.svg", "prettier.config.js": "prettier.svg",
  "vite.config.ts": "vitejs.svg", "vite.config.js": "vitejs.svg",
  "tailwind.config.ts": "tailwind.svg", "tailwind.config.js": "tailwind.svg",
  "next.config.ts": "nextjs.svg", "next.config.js": "nextjs.svg",
  "jest.config.ts": "jest.svg", "jest.config.js": "jest.svg",
  "vitest.config.ts": "vitest.svg", "vitest.config.js": "vitest.svg",
  "turbo.json": "turborepo.svg", ".editorconfig": "settings.svg",
  "postcss.config.js": "postcss.svg",
  "webpack.config.js": "webpack.svg", "webpack.config.ts": "webpack.svg",
};

const FOLDER_MAP: Record<string, [string, string]> = {
  "src":          ["src.svg",    "src-open.svg"],
  "source":       ["src.svg",    "src-open.svg"],
  "styles":       ["styles.svg", "styles-open.svg"],
  "style":        ["styles.svg", "styles-open.svg"],
  "node_modules": ["node.svg",   "node-open.svg"],
  "build":        ["build.svg",  "build-open.svg"],
  "dist":         ["build.svg",  "build-open.svg"],
  "out":          ["build.svg",  "build-open.svg"],
  ".next":        ["next.svg",   "next-open.svg"],
  "test":         ["tests.svg",  "tests-open.svg"],
  "tests":        ["tests.svg",  "tests-open.svg"],
  "__tests__":    ["tests.svg",  "tests-open.svg"],
  ".git":         ["git.svg",    "git-open.svg"],
  ".github":      ["git.svg",    "git-open.svg"],
  "db":           ["db.svg",     "db-open.svg"],
  "database":     ["db.svg",     "db-open.svg"],
  "app":          ["app.svg",    "app-open.svg"],
  "images":       ["images.svg", "images-open.svg"],
  "img":          ["images.svg", "images-open.svg"],
  "icons":        ["images.svg", "images-open.svg"],
};

export function resolveFileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (NAME_MAP[lower]) return `${BASE}/${NAME_MAP[lower]}`;
  const parts = lower.split(".");
  if (parts.length >= 3) {
    const compound = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (["test.ts","spec.ts","test.tsx","spec.tsx"].includes(compound)) return `${BASE}/vitest.svg`;
    if (["test.js","spec.js","test.jsx","spec.jsx"].includes(compound)) return `${BASE}/jest.svg`;
  }
  const ext = parts[parts.length - 1] ?? "";
  return EXT_MAP[ext] ? `${BASE}/${EXT_MAP[ext]}` : `${BASE}/file.png`;
}

function resolveFolderIcon(name: string, open: boolean): string {
  const pair = FOLDER_MAP[name.toLowerCase()];
  if (pair) return `${BASE}/folders/${open ? pair[1] : pair[0]}`;
  return `${BASE}/folders/${open ? "default-open.svg" : "default.svg"}`;
}

// ── Path helpers ───────────────────────────────────────────────────────────────

const INDENT = 16;
const BASE_INDENT = 4;
const ICON_OFFSET = 20; // files sit where a folder's chevron+icon would be

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const ALT = IS_MAC ? "⌥" : "Alt+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";

/** Cap on a single Finder drop, so dragging in a huge tree fails fast. */
const MAX_IMPORT_FILES = 500;

const parentOf = (relPath: string) =>
  relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";

const nameOf = (relPath: string) => relPath.slice(relPath.lastIndexOf("/") + 1);

const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** True when `path` is `ancestor` itself or sits underneath it. */
const isWithin = (path: string, ancestor: string) =>
  ancestor === "" || path === ancestor || path.startsWith(`${ancestor}/`);

/**
 * Rewrites `from` (and everything beneath it) to `to`. Used after a rename or a
 * move so expanded folders and selections keep pointing at the same entries.
 */
function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return path;
}

/** Drops the extension from a selection range so renaming edits the stem first. */
function stemLength(name: string): number {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name.length : dot;
}

// ── Flattened row model ────────────────────────────────────────────────────────
// The tree renders as a flat list rather than nested components so range
// selection, drag targets and keyboard actions can all work off row order.

type Row =
  | { type: "dir" | "file"; relPath: string; name: string; depth: number }
  | { type: "note"; key: string; text: string; depth: number; isError?: boolean }
  | { type: "draft"; parentDir: string; kind: "file" | "dir"; depth: number };

interface Draft { parentDir: string; kind: "file" | "dir" }

function buildRows(
  entries: Map<string, DirEntry[]>,
  errors: Map<string, string>,
  expanded: Set<string>,
  draft: Draft | null,
): Row[] {
  const rows: Row[] = [];

  const walk = (dir: string, depth: number) => {
    // New entries are typed in at the top of their folder, as in VS Code. This
    // comes first so the input appears immediately, even while the folder it
    // was created in is still being read.
    if (draft?.parentDir === dir) {
      rows.push({ type: "draft", parentDir: dir, kind: draft.kind, depth });
    }
    const error = errors.get(dir);
    if (error) {
      rows.push({ type: "note", key: `err:${dir}`, text: error, depth, isError: true });
      return;
    }
    const list = entries.get(dir);
    if (!list) {
      rows.push({ type: "note", key: `load:${dir}`, text: "Loading…", depth });
      return;
    }
    if (list.length === 0) {
      if (draft?.parentDir !== dir) {
        rows.push({ type: "note", key: `empty:${dir}`, text: "empty", depth });
      }
      return;
    }
    for (const entry of list) {
      const relPath = joinRel(dir, entry.name);
      rows.push({ type: entry.kind, relPath, name: entry.name, depth });
      if (entry.kind === "dir" && expanded.has(relPath)) walk(relPath, depth + 1);
    }
  };

  walk("", 0);
  return rows;
}

// ── Indent guides ──────────────────────────────────────────────────────────────

function IndentGuides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          className="fes-guide"
          style={{ left: BASE_INDENT + i * INDENT + 8 }}
          aria-hidden
        />
      ))}
    </>
  );
}

// ── Inline name input (new file/folder and rename) ─────────────────────────────

function InlineInput({
  initialValue, iconSrc, depth, indented, onCommit, onCancel,
}: {
  initialValue: string;
  iconSrc: string;
  depth: number;
  indented: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against onBlur firing a second commit after Enter or Escape.
  const settledRef = useRef(false);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, stemLength(initialValue));
  }, [initialValue]);

  const settle = (commit: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    const value = inputRef.current?.value.trim() ?? "";
    if (commit && value && value !== initialValue) onCommit(value);
    else onCancel();
  };

  return (
    <div
      className="fes-row fes-row--editing"
      style={{ paddingLeft: BASE_INDENT + depth * INDENT + (indented ? ICON_OFFSET : 0) }}
    >
      <IndentGuides depth={depth} />
      <img className="files-tree-icon" src={iconSrc} alt="" draggable={false} />
      <input
        ref={inputRef}
        className="fes-inline-input"
        defaultValue={initialValue}
        spellCheck={false}
        autoComplete="off"
        onBlur={() => settle(true)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); settle(true); }
          if (e.key === "Escape") { e.preventDefault(); settle(false); }
        }}
      />
    </div>
  );
}

// ── Delete confirmation ────────────────────────────────────────────────────────

function DeleteConfirm({
  paths, onCancel, onConfirm,
}: {
  paths: string[];
  onCancel: () => void;
  onConfirm: (permanent: boolean) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      if (e.key === "Enter") { e.preventDefault(); onConfirm(false); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel, onConfirm]);

  const label = paths.length === 1
    ? `"${nameOf(paths[0]!)}"`
    : `${paths.length} selected items`;

  return (
    <div className="fes-modal-backdrop" onMouseDown={onCancel}>
      <div className="fes-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fes-modal-title">
          <AlertTriangle size={14} />
          Delete {label}?
        </div>
        <div className="fes-modal-body">
          {paths.length > 1 && (
            <ul className="fes-modal-list">
              {paths.slice(0, 8).map((p) => <li key={p}>{p}</li>)}
              {paths.length > 8 && <li>…and {paths.length - 8} more</li>}
            </ul>
          )}
          <p>You can restore this from the Trash.</p>
        </div>
        <div className="fes-modal-actions">
          <button className="fes-modal-btn" onClick={onCancel}>Cancel</button>
          <button className="fes-modal-btn fes-modal-btn--ghost" onClick={() => onConfirm(true)}>
            Delete Permanently
          </button>
          <button className="fes-modal-btn fes-modal-btn--primary" onClick={() => onConfirm(false)} autoFocus>
            Move to Trash
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Search result highlighting ─────────────────────────────────────────────────

function HighlightedLine({ text, query }: { text: string; query: string }) {
  if (!query) return <span>{text}</span>;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return <span>{text}</span>;
  return (
    <>
      <span>{text.slice(0, idx)}</span>
      <span className="fes-match-highlight">{text.slice(idx, idx + query.length)}</span>
      <span>{text.slice(idx + query.length)}</span>
    </>
  );
}

// ── Search results view ────────────────────────────────────────────────────────

function SearchResultsView({
  results, total, query, hasMore, loadingMore, onLoadMore, onFileOpen, onFileViewerOpen,
}: {
  results: FileSearchResult[];
  total: number;
  query: string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onFileOpen: (relPath: string, line?: number) => void;
  onFileViewerOpen: (relPath: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (relPath: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(relPath) ? next.delete(relPath) : next.add(relPath);
      return next;
    });

  return (
    <div className="fes-results">
      <div className="fes-result-summary">
        {total} result{total !== 1 ? "s" : ""} in {results.length} file{results.length !== 1 ? "s" : ""}
        {hasMore && " (more below)"}
      </div>
      {results.map((file) => {
        const fileName = file.relPath.split("/").pop() ?? file.relPath;
        const isOpen = !collapsed.has(file.relPath);
        return (
          <div key={file.relPath} className="fes-file-group">
            <div
              className="fes-file-header"
              onClick={() => toggle(file.relPath)}
              onDoubleClick={() => onFileViewerOpen(file.relPath)}
              title={`${file.relPath} — double-click to open in viewer`}
            >
              <span className="fes-file-chevron">{isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
              <img className="fes-file-icon" src={resolveFileIcon(fileName)} alt="" draggable={false} />
              <span className="fes-file-name">{fileName}</span>
              <span className="fes-file-dir">{file.relPath.includes("/") ? file.relPath.split("/").slice(0, -1).join("/") : ""}</span>
              <span className="fes-match-badge">{file.lines.length}</span>
            </div>
            {isOpen && (
              <div className="fes-file-lines">
                {file.lines.map((match, i) => (
                  <div
                    key={i}
                    className="fes-match-row"
                    onClick={() => onFileOpen(file.relPath, match.line)}
                    title={`Line ${match.line}: ${match.text}`}
                  >
                    <span className="fes-line-num">{match.line}</span>
                    <span className="fes-line-text">
                      <HighlightedLine text={match.text} query={query} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Load more */}
      {hasMore && (
        <button
          className={`fes-load-more${loadingMore ? " fes-load-more--loading" : ""}`}
          onClick={onLoadMore}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading…" : "Load more files"}
        </button>
      )}
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  repoPath: string;
  hidden?: boolean;
  activeFilePath: string | null;
  openFilePaths: string[];
  onFileOpen: (relPath: string, line?: number) => void;
  onFileViewerOpen: (entry: FileEntry) => void;
  /** Runs a command in the repo's integrated terminal. */
  onRunCommand?: (command: string) => void;
  /** Open editors follow files that were renamed or moved on disk. */
  onEntriesMoved?: (moves: Array<{ from: string; to: string }>) => void;
  /** Open editors for deleted files are closed. */
  onEntriesDeleted?: (relPaths: string[]) => void;
}

// ── Main component ─────────────────────────────────────────────────────────────

export function FileExplorerSidebar({
  repoPath, hidden, activeFilePath, openFilePaths, onFileOpen, onFileViewerOpen,
  onRunCommand, onEntriesMoved, onEntriesDeleted,
}: Props) {
  const [dirEntries, setDirEntries] = useState<Map<string, DirEntry[]>>(new Map());
  const [dirErrors, setDirErrors]   = useState<Map<string, string>>(new Map());
  const [expanded, setExpanded]     = useState<Set<string>>(new Set());
  const [loading, setLoading]       = useState(false);
  const expandedRef                 = useRef<Set<string>>(new Set());
  const requestedRef                = useRef<Set<string>>(new Set());
  const openFilePathsSet            = useMemo(() => new Set(openFilePaths), [openFilePaths]);

  // ── Explorer interaction state ───────────────────────────────────────────────
  const [selection, setSelection]   = useState<string[]>([]);
  const [clipboard, setClipboard]   = useState<{ paths: string[]; mode: "copy" | "cut" } | null>(null);
  const [menu, setMenu]             = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const [draft, setDraft]           = useState<Draft | null>(null);
  const [renaming, setRenaming]     = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const [opError, setOpError]       = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [importing, setImporting]   = useState<{ done: number; total: number } | null>(null);
  const anchorRef                   = useRef<string | null>(null);
  const dragPathsRef                = useRef<string[]>([]);
  const treeRef                     = useRef<HTMLDivElement>(null);

  // ── Search state ─────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery]     = useState("");
  const [searchScope, setSearchScope]     = useState("");
  const [searchResults, setSearchResults] = useState<FileSearchResult[]>([]);
  const [searchTotal, setSearchTotal]     = useState(0);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchOffset, setSearchOffset]   = useState(0);
  const [searching, setSearching]         = useState(false);
  const [loadingMore, setLoadingMore]     = useState(false);
  const [excludeExts, setExcludeExts]     = useState<string>(() => {
    try { return localStorage.getItem(`buildover.fileSearch.excludeExts.${repoPath}`) ?? ""; }
    catch { return ""; }
  });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist exclude exts per repo
  useEffect(() => {
    try { localStorage.setItem(`buildover.fileSearch.excludeExts.${repoPath}`, excludeExts); }
    catch { /* ignore */ }
  }, [excludeExts, repoPath]);

  // Reset exclude exts when repo changes
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`buildover.fileSearch.excludeExts.${repoPath}`);
      setExcludeExts(stored ?? "");
    } catch { /* ignore */ }
  }, [repoPath]);

  // ── Lazy per-directory loading ────────────────────────────────────────────────
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;

  const loadDir = useCallback(async (relPath: string) => {
    requestedRef.current.add(relPath);
    try {
      const entries = await fileApi.listDir(relPath ? `${repoPath}/${relPath}` : repoPath);
      if (repoPathRef.current !== repoPath) return; // repo switched mid-flight
      setDirEntries((prev) => new Map(prev).set(relPath, entries));
      setDirErrors((prev) => {
        if (!prev.has(relPath)) return prev;
        const next = new Map(prev);
        next.delete(relPath);
        return next;
      });
    } catch (err) {
      requestedRef.current.delete(relPath);
      if (repoPathRef.current !== repoPath) return;
      setDirErrors((prev) => new Map(prev).set(relPath, err instanceof Error ? err.message : String(err)));
    }
  }, [repoPath]);

  // Re-reads the root plus every currently expanded folder, so a refresh picks
  // up files the agent created without collapsing the user's tree.
  const refresh = useCallback(async () => {
    requestedRef.current = new Set();
    setLoading(true);
    try {
      await Promise.all(["", ...expandedRef.current].map(loadDir));
    } finally {
      setLoading(false);
    }
  }, [loadDir]);

  /** Re-reads only the folders an operation touched, skipping unopened ones. */
  const reloadDirs = useCallback(async (dirs: string[]) => {
    const wanted = [...new Set(dirs)].filter(
      (dir) => dir === "" || expandedRef.current.has(dir) || requestedRef.current.has(dir),
    );
    await Promise.all(wanted.map(loadDir));
  }, [loadDir]);

  useEffect(() => {
    setDirEntries(new Map());
    setDirErrors(new Map());
    setExpanded(new Set());
    expandedRef.current = new Set();
    requestedRef.current = new Set();
    setSelection([]);
    setClipboard(null);
    setDraft(null);
    setRenaming(null);
    setSearchScope("");
    anchorRef.current = null;
  }, [repoPath]);

  useEffect(() => { void refresh(); }, [refresh]);

  const wasHiddenRef = useRef(hidden);
  useEffect(() => {
    const becameVisible = wasHiddenRef.current && !hidden;
    wasHiddenRef.current = hidden;
    if (becameVisible) void refresh();
  }, [hidden, refresh]);

  const setExpandedSet = useCallback((next: Set<string>) => {
    expandedRef.current = next;
    setExpanded(next);
  }, []);

  const handleToggleDir = useCallback((relPath: string) => {
    const wasOpen = expandedRef.current.has(relPath);
    const next = new Set(expandedRef.current);
    wasOpen ? next.delete(relPath) : next.add(relPath);
    setExpandedSet(next);
    if (!wasOpen && !requestedRef.current.has(relPath)) void loadDir(relPath);
  }, [loadDir, setExpandedSet]);

  const expandDir = useCallback((relPath: string) => {
    if (!relPath || expandedRef.current.has(relPath)) return;
    setExpandedSet(new Set(expandedRef.current).add(relPath));
    if (!requestedRef.current.has(relPath)) void loadDir(relPath);
  }, [loadDir, setExpandedSet]);

  // ── Debounced search (first page) ────────────────────────────────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!searchQuery.trim()) {
      setSearchResults([]); setSearchTotal(0); setSearchHasMore(false); setSearchOffset(0);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fileApi.searchFiles(repoPath, searchQuery, excludeExts, 0, searchScope);
        setSearchResults(res.matches);
        setSearchTotal(res.total);
        setSearchHasMore(res.hasMore);
        setSearchOffset(res.matches.length);
      } catch { /* ignore */ } finally {
        setSearching(false);
      }
    }, 280);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchQuery, excludeExts, repoPath, searchScope]);

  // ── Load next page ────────────────────────────────────────────────────────────
  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !searchHasMore) return;
    setLoadingMore(true);
    try {
      const res = await fileApi.searchFiles(repoPath, searchQuery, excludeExts, searchOffset, searchScope);
      setSearchResults((prev) => [...prev, ...res.matches]);
      setSearchTotal((prev) => prev + res.total);
      setSearchHasMore(res.hasMore);
      setSearchOffset((prev) => prev + res.matches.length);
    } catch { /* ignore */ } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, searchHasMore, repoPath, searchQuery, excludeExts, searchOffset, searchScope]);

  const handleFileViewerOpen = useCallback((relPath: string) => {
    onFileViewerOpen({ path: `${repoPath}/${relPath}`, relPath, op: "edit" });
  }, [onFileViewerOpen, repoPath]);

  // ── Operations ───────────────────────────────────────────────────────────────

  const run = useCallback(async (fn: () => Promise<void>) => {
    try {
      setOpError(null);
      await fn();
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const absPath = useCallback(
    (relPath: string) => (relPath ? `${repoPath}/${relPath}` : repoPath),
    [repoPath],
  );

  const beginCreate = useCallback((parentDir: string, kind: "file" | "dir") => {
    setRenaming(null);
    if (parentDir) expandDir(parentDir);
    setDraft({ parentDir, kind });
  }, [expandDir]);

  const commitCreate = useCallback((parentDir: string, kind: "file" | "dir", name: string) => {
    setDraft(null);
    void run(async () => {
      const { relPath } = await fileApi.createEntry(repoPath, joinRel(parentDir, name), kind);
      await reloadDirs([parentDir]);
      setSelection([relPath]);
      anchorRef.current = relPath;
      if (kind === "file") onFileOpen(relPath);
      else expandDir(relPath);
    });
  }, [repoPath, run, reloadDirs, onFileOpen, expandDir]);

  const commitRename = useCallback((from: string, newName: string) => {
    setRenaming(null);
    void run(async () => {
      const { relPath: to } = await fileApi.renameEntry(repoPath, from, joinRel(parentOf(from), newName));
      await reloadDirs([parentOf(from)]);
      setExpandedSet(new Set([...expandedRef.current].map((p) => remapPath(p, from, to))));
      setSelection((prev) => prev.map((p) => remapPath(p, from, to)));
      onEntriesMoved?.([{ from, to }]);
    });
  }, [repoPath, run, reloadDirs, setExpandedSet, onEntriesMoved]);

  const confirmDelete = useCallback((paths: string[], permanent: boolean) => {
    setPendingDelete(null);
    void run(async () => {
      const { deleted } = await fileApi.deleteEntries(repoPath, paths, permanent);
      await reloadDirs(deleted.map(parentOf));
      setExpandedSet(
        new Set([...expandedRef.current].filter((p) => !deleted.some((d) => isWithin(p, d)))),
      );
      setSelection((prev) => prev.filter((p) => !deleted.some((d) => isWithin(p, d))));
      setClipboard((prev) =>
        prev && prev.paths.some((p) => deleted.some((d) => isWithin(p, d))) ? null : prev,
      );
      onEntriesDeleted?.(deleted);
    });
  }, [repoPath, run, reloadDirs, setExpandedSet, onEntriesDeleted]);

  const transfer = useCallback((paths: string[], toDir: string, mode: "copy" | "move") => {
    void run(async () => {
      const { moves } = await fileApi.transferEntries(repoPath, paths, toDir, mode);
      await reloadDirs([toDir, ...paths.map(parentOf)]);
      if (mode === "move") {
        setExpandedSet(
          new Set([...expandedRef.current].map((p) => {
            const hit = moves.find((m) => isWithin(p, m.from));
            return hit ? remapPath(p, hit.from, hit.to) : p;
          })),
        );
        onEntriesMoved?.(moves);
      }
      if (toDir) expandDir(toDir);
      setSelection(moves.map((m) => m.to));
    });
  }, [repoPath, run, reloadDirs, setExpandedSet, onEntriesMoved, expandDir]);

  const paste = useCallback((toDir: string) => {
    if (!clipboard) return;
    transfer(clipboard.paths, toDir, clipboard.mode === "cut" ? "move" : "copy");
    if (clipboard.mode === "cut") setClipboard(null);
  }, [clipboard, transfer]);

  const copyToClipboard = useCallback((text: string) => {
    void run(async () => { await navigator.clipboard.writeText(text); });
  }, [run]);

  const findInFolder = useCallback((dir: string) => {
    setSearchScope(dir);
    searchInputRef.current?.focus();
  }, []);

  const openInTerminal = useCallback((dir: string) => {
    onRunCommand?.(`cd ${JSON.stringify(absPath(dir))}`);
  }, [onRunCommand, absPath]);

  // ── Selection ────────────────────────────────────────────────────────────────

  const rows = useMemo(
    () => buildRows(dirEntries, dirErrors, expanded, draft),
    [dirEntries, dirErrors, expanded, draft],
  );

  const selectableRows = useMemo(
    () => rows.filter((r): r is Extract<Row, { type: "dir" | "file" }> => r.type === "dir" || r.type === "file"),
    [rows],
  );

  const handleRowClick = useCallback((relPath: string, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSelection((prev) =>
        prev.includes(relPath) ? prev.filter((p) => p !== relPath) : [...prev, relPath],
      );
      anchorRef.current = relPath;
      return true;
    }
    if (e.shiftKey && anchorRef.current) {
      const order = selectableRows.map((r) => r.relPath);
      const from = order.indexOf(anchorRef.current);
      const to = order.indexOf(relPath);
      if (from !== -1 && to !== -1) {
        setSelection(order.slice(Math.min(from, to), Math.max(from, to) + 1));
        return true;
      }
    }
    setSelection([relPath]);
    anchorRef.current = relPath;
    return false;
  }, [selectableRows]);

  // ── Context menus ────────────────────────────────────────────────────────────

  const buildMenu = useCallback((target: { relPath: string; kind: "dir" | "file" } | null): ContextMenuEntry[] => {
    const multi = target ? selection.length > 1 && selection.includes(target.relPath) : false;
    const targets = multi ? selection : target ? [target.relPath] : [];
    const dir = !target ? "" : target.kind === "dir" ? target.relPath : parentOf(target.relPath);
    const pasteLabel = clipboard
      ? `Paste${clipboard.paths.length > 1 ? ` ${clipboard.paths.length} Items` : ""}`
      : "Paste";

    // Multi-selection collapses to the actions that make sense in bulk.
    if (multi) {
      return [
        { label: "Cut", icon: Scissors, shortcut: `${MOD}X`, onSelect: () => setClipboard({ paths: targets, mode: "cut" }) },
        { label: "Copy", icon: Copy, shortcut: `${MOD}C`, onSelect: () => setClipboard({ paths: targets, mode: "copy" }) },
        { label: `${pasteLabel} into "${dir || "root"}"`, icon: ClipboardPaste, shortcut: `${MOD}V`, disabled: !clipboard, onSelect: () => paste(dir) },
        { label: "Duplicate", icon: CopyPlus, onSelect: () => transfer(targets, dir, "copy") },
        "divider",
        { label: "Copy Paths", icon: Link, onSelect: () => copyToClipboard(targets.map(absPath).join("\n")) },
        { label: "Copy Relative Paths", icon: Link2, onSelect: () => copyToClipboard(targets.join("\n")) },
        "divider",
        { label: `Delete ${targets.length} Items`, icon: Trash2, danger: true, shortcut: "⌫", onSelect: () => setPendingDelete(targets) },
      ];
    }

    const common: ContextMenuEntry[] = [
      { label: "Reveal in Finder", icon: FolderOpen, shortcut: `${SHIFT}${MOD}R`, onSelect: () => void run(() => fileApi.revealEntry(repoPath, target?.relPath ?? "").then(() => undefined)) },
      ...(onRunCommand ? [{ label: "Open in Integrated Terminal", icon: TerminalSquare, onSelect: () => openInTerminal(dir) }] : []),
      { label: "Find in Folder…", icon: SearchCode, onSelect: () => findInFolder(dir) },
    ];

    // Empty space below the tree acts on the repository root.
    if (!target) {
      return [
        { label: "New File…", icon: FilePlus2, onSelect: () => beginCreate("", "file") },
        { label: "New Folder…", icon: FolderPlus, onSelect: () => beginCreate("", "dir") },
        "divider",
        ...common,
        "divider",
        { label: pasteLabel, icon: ClipboardPaste, shortcut: `${MOD}V`, disabled: !clipboard, onSelect: () => paste("") },
        "divider",
        { label: "Copy Path", icon: Link, onSelect: () => copyToClipboard(repoPath) },
        "divider",
        { label: "Refresh Explorer", icon: RefreshCw, onSelect: () => void refresh() },
        { label: "Collapse Folders in Explorer", icon: ChevronsDownUp, onSelect: () => setExpandedSet(new Set()) },
      ];
    }

    const relPath = target.relPath;
    const isDir = target.kind === "dir";

    return [
      ...(isDir
        ? [
            { label: "New File…", icon: FilePlus2, onSelect: () => beginCreate(relPath, "file") } as ContextMenuEntry,
            { label: "New Folder…", icon: FolderPlus, onSelect: () => beginCreate(relPath, "dir") } as ContextMenuEntry,
          ]
        : [
            { label: "Open", icon: FileText, shortcut: "↩", onSelect: () => onFileOpen(relPath) } as ContextMenuEntry,
            { label: "Open in Viewer", icon: FileText, onSelect: () => handleFileViewerOpen(relPath) } as ContextMenuEntry,
            { label: "Open with Default App", icon: ExternalLink, onSelect: () => void run(() => fileApi.openExternally(repoPath, relPath).then(() => undefined)) } as ContextMenuEntry,
          ]),
      "divider",
      ...common,
      "divider",
      { label: "Cut", icon: Scissors, shortcut: `${MOD}X`, onSelect: () => setClipboard({ paths: [relPath], mode: "cut" }) },
      { label: "Copy", icon: Copy, shortcut: `${MOD}C`, onSelect: () => setClipboard({ paths: [relPath], mode: "copy" }) },
      { label: pasteLabel, icon: ClipboardPaste, shortcut: `${MOD}V`, disabled: !clipboard, onSelect: () => paste(dir) },
      { label: "Duplicate", icon: CopyPlus, onSelect: () => transfer([relPath], parentOf(relPath), "copy") },
      "divider",
      { label: "Copy Path", icon: Link, onSelect: () => copyToClipboard(absPath(relPath)) },
      { label: "Copy Relative Path", icon: Link2, shortcut: `${ALT}${MOD}C`, onSelect: () => copyToClipboard(relPath) },
      "divider",
      { label: "Rename…", icon: PenLine, shortcut: "F2", onSelect: () => { setDraft(null); setRenaming(relPath); } },
      { label: "Delete", icon: Trash2, danger: true, shortcut: "⌫", onSelect: () => setPendingDelete([relPath]) },
    ];
  }, [
    selection, clipboard, repoPath, onRunCommand, run, paste, transfer, copyToClipboard,
    absPath, beginCreate, findInFolder, openInTerminal, refresh, setExpandedSet, onFileOpen,
    handleFileViewerOpen,
  ]);

  const openRowMenu = useCallback((e: React.MouseEvent, row: { relPath: string; kind: "dir" | "file" }) => {
    e.preventDefault();
    e.stopPropagation();
    // Right-clicking outside the current selection retargets it, as in VS Code.
    if (!selection.includes(row.relPath)) {
      setSelection([row.relPath]);
      anchorRef.current = row.relPath;
    }
    setMenu({ x: e.clientX, y: e.clientY, items: buildMenu(row) });
  }, [selection, buildMenu]);

  const openRootMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: buildMenu(null) });
  }, [buildMenu]);

  // ── Keyboard shortcuts on the focused tree ───────────────────────────────────

  const handleTreeKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (selection.length === 0) return;
    const mod = e.metaKey || e.ctrlKey;
    const single = selection.length === 1 ? selection[0]! : null;

    if (e.key === "F2" && single) {
      e.preventDefault();
      setDraft(null);
      setRenaming(single);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      setPendingDelete(selection);
      return;
    }
    if (mod && e.key.toLowerCase() === "x") {
      e.preventDefault();
      setClipboard({ paths: selection, mode: "cut" });
      return;
    }
    if (mod && e.altKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copyToClipboard(selection.join("\n"));
      return;
    }
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      setClipboard({ paths: selection, mode: "copy" });
      return;
    }
    if (mod && e.key.toLowerCase() === "v" && clipboard && single) {
      e.preventDefault();
      const row = selectableRows.find((r) => r.relPath === single);
      paste(row?.type === "dir" ? single : parentOf(single));
      return;
    }
    if (e.key === "Enter" && single) {
      const row = selectableRows.find((r) => r.relPath === single);
      if (!row) return;
      e.preventDefault();
      row.type === "dir" ? handleToggleDir(single) : onFileOpen(single);
    }
  }, [selection, clipboard, copyToClipboard, paste, selectableRows, handleToggleDir, onFileOpen]);

  // ── Drag & drop ──────────────────────────────────────────────────────────────

  const handleDragStart = useCallback((e: React.DragEvent, relPath: string) => {
    const paths = selection.includes(relPath) ? selection : [relPath];
    dragPathsRef.current = paths;
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/plain", paths.map(absPath).join("\n"));
  }, [selection, absPath]);

  /** A move is only legal into a folder that isn't the source or inside it. */
  const canDropInto = useCallback((dir: string) => {
    const paths = dragPathsRef.current;
    if (paths.length === 0) return false;
    return !paths.some((p) => dir === p || dir.startsWith(`${p}/`) || parentOf(p) === dir);
  }, []);

  /**
   * Copies files dragged in from Finder into `toDir`. Must be invoked straight
   * from the drop handler: readDroppedFiles takes its handles on the DataTransfer
   * synchronously, because the browser empties it as soon as the handler returns.
   */
  const importDropped = useCallback((dataTransfer: DataTransfer, toDir: string) => {
    const pending = readDroppedFiles(dataTransfer, MAX_IMPORT_FILES);
    void run(async () => {
      const { files, truncated } = await pending;
      if (files.length === 0) return;
      const created: string[] = [];
      try {
        setImporting({ done: 0, total: files.length });
        for (const { relPath, file } of files) {
          const res = await fileApi.uploadFile(repoPath, toDir, relPath, file);
          created.push(res.relPath);
          setImporting({ done: created.length, total: files.length });
        }
      } finally {
        setImporting(null);
        // Show whatever landed even if a later file failed mid-drop.
        await reloadDirs([toDir, ...created.map(parentOf)]);
        if (toDir) expandDir(toDir);
        setSelection(created);
      }
      if (truncated) {
        throw new Error(`Only the first ${MAX_IMPORT_FILES} files were imported — drop a smaller selection.`);
      }
    });
  }, [run, repoPath, reloadDirs, expandDir]);

  const handleDragOver = useCallback((e: React.DragEvent, dir: string) => {
    const internal = dragPathsRef.current.length > 0;
    if (!internal && !hasExternalFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!internal) {
      e.dataTransfer.dropEffect = "copy"; // Finder drops always copy
      setDropTarget(dir);
      return;
    }
    const copying = e.altKey;
    e.dataTransfer.dropEffect = copying ? "copy" : canDropInto(dir) ? "move" : "none";
    setDropTarget(copying || canDropInto(dir) ? dir : null);
  }, [canDropInto]);

  const handleDrop = useCallback((e: React.DragEvent, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const paths = dragPathsRef.current;
    dragPathsRef.current = [];

    if (paths.length > 0) {
      const mode = e.altKey ? "copy" : "move";
      if (mode === "move" && !canDropInto(dir)) return;
      transfer(paths, dir, mode);
      return;
    }
    if (hasExternalFiles(e.dataTransfer)) importDropped(e.dataTransfer, dir);
  }, [canDropInto, transfer, importDropped]);

  // ── Render ───────────────────────────────────────────────────────────────────

  const rootEntries = dirEntries.get("");
  const rootError   = dirErrors.get("");
  const cutSet      = useMemo(
    () => new Set(clipboard?.mode === "cut" ? clipboard.paths : []),
    [clipboard],
  );
  const selectionSet = useMemo(() => new Set(selection), [selection]);

  const renderRow = (row: Row) => {
    if (row.type === "note") {
      return (
        <div
          key={row.key}
          className={row.isError ? "files-tree-note files-tree-note--error" : "files-tree-note"}
          style={{ paddingLeft: BASE_INDENT + row.depth * INDENT + ICON_OFFSET }}
        >
          <IndentGuides depth={row.depth} />
          {row.text}
        </div>
      );
    }

    if (row.type === "draft") {
      return (
        <InlineInput
          key={`draft:${row.parentDir}`}
          initialValue=""
          iconSrc={row.kind === "dir" ? resolveFolderIcon("", false) : `${BASE}/file.png`}
          depth={row.depth}
          indented={row.kind === "file"}
          onCommit={(value) => commitCreate(row.parentDir, row.kind, value)}
          onCancel={() => setDraft(null)}
        />
      );
    }

    const { relPath, name, depth } = row;
    const isDir = row.type === "dir";
    const open = isDir && expanded.has(relPath);

    if (renaming === relPath) {
      return (
        <InlineInput
          key={`rename:${relPath}`}
          initialValue={name}
          iconSrc={isDir ? resolveFolderIcon(name, open) : resolveFileIcon(name)}
          depth={depth}
          indented={!isDir}
          onCommit={(value) => commitRename(relPath, value)}
          onCancel={() => setRenaming(null)}
        />
      );
    }

    const isSelected = selectionSet.has(relPath);
    const isActive   = !isDir && activeFilePath === relPath;
    const isOpenTab  = !isDir && openFilePathsSet.has(relPath);
    const dropDir    = isDir ? relPath : parentOf(relPath);

    const classes = [
      "fes-row",
      isSelected ? "fes-row--selected" : "",
      isActive && !isSelected ? "fes-row--active" : "",
      cutSet.has(relPath) ? "fes-row--cut" : "",
      dropTarget === dropDir && isDir ? "fes-row--drop" : "",
    ].filter(Boolean).join(" ");

    return (
      <div
        key={relPath}
        className={classes}
        style={{ paddingLeft: BASE_INDENT + depth * INDENT + (isDir ? 0 : ICON_OFFSET) }}
        title={relPath}
        draggable
        onDragStart={(e) => handleDragStart(e, relPath)}
        onDragEnd={() => { dragPathsRef.current = []; setDropTarget(null); }}
        onDragOver={(e) => handleDragOver(e, dropDir)}
        onDragLeave={() => setDropTarget((prev) => (prev === dropDir ? null : prev))}
        onDrop={(e) => handleDrop(e, dropDir)}
        onContextMenu={(e) => openRowMenu(e, { relPath, kind: row.type })}
        onClick={(e) => {
          treeRef.current?.focus();
          if (handleRowClick(relPath, e)) return; // range/toggle select only
          isDir ? handleToggleDir(relPath) : onFileOpen(relPath);
        }}
        onDoubleClick={() => { if (!isDir) handleFileViewerOpen(relPath); }}
      >
        <IndentGuides depth={depth} />
        {isDir && (
          <span className="files-tree-chevron">
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        )}
        <img
          className="files-tree-icon"
          src={isDir ? resolveFolderIcon(name, open) : resolveFileIcon(name)}
          alt=""
          draggable={false}
        />
        <span className={`fes-row-name${isOpenTab && !isActive && !isSelected ? " fes-row-name--open" : ""}`}>
          {name}
        </span>
      </div>
    );
  };

  return (
    <div className="sc-sidebar" style={{ display: hidden ? "none" : undefined }} aria-hidden={hidden}>
      {/* Search bar */}
      <div className="fes-search-section">
        <div className="fes-search-bar">
          {searching ? (
            <span className="fes-search-spinner" />
          ) : (
            <Search size={13} className="fes-search-icon" />
          )}
          <input
            ref={searchInputRef}
            className="fes-search-input"
            placeholder={searchScope ? `Search in ${nameOf(searchScope)}…` : "Search files…"}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          {(searchQuery || searchScope) && (
            <button
              className="fes-search-clear"
              onClick={() => { setSearchQuery(""); setSearchScope(""); searchInputRef.current?.focus(); }}
            >
              <X size={11} />
            </button>
          )}
        </div>
        {searchScope && (
          <div className="fes-scope-chip">
            <SearchCode size={11} />
            <span className="fes-scope-path">{searchScope}</span>
            <button className="fes-scope-clear" onClick={() => setSearchScope("")} title="Search the whole repo">
              <X size={10} />
            </button>
          </div>
        )}
        {searchQuery && (
          <div className="fes-exclude-row">
            <input
              className="fes-exclude-input"
              placeholder="Exclude types: ts, css…"
              value={excludeExts}
              onChange={(e) => setExcludeExts(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
      </div>

      {importing && (
        <div className="fes-import-status">
          <span className="fes-search-spinner" />
          Importing {importing.done} of {importing.total} file{importing.total !== 1 ? "s" : ""}…
        </div>
      )}

      {opError && (
        <div className="fes-op-error" role="alert">
          <AlertTriangle size={12} />
          <span className="fes-op-error-text">{opError}</span>
          <button className="fes-op-error-close" onClick={() => setOpError(null)}><X size={11} /></button>
        </div>
      )}

      {/* Body */}
      <div className="sc-sidebar-body">
        {searchQuery ? (
          searchResults.length > 0 ? (
            <SearchResultsView
              results={searchResults}
              total={searchTotal}
              query={searchQuery}
              hasMore={searchHasMore}
              loadingMore={loadingMore}
              onLoadMore={handleLoadMore}
              onFileOpen={onFileOpen}
              onFileViewerOpen={handleFileViewerOpen}
            />
          ) : !searching ? (
            <div className="sc-empty">No results for "{searchQuery}"</div>
          ) : null
        ) : (
          <>
            {rootError && <div className="sc-error">{rootError}</div>}
            {!rootError && loading && !rootEntries && <div className="sc-empty">Loading files…</div>}
            {!rootError && rootEntries && (
              <div
                ref={treeRef}
                className={`files-tree fes-tree${dropTarget === "" ? " fes-tree--drop" : ""}`}
                tabIndex={0}
                onKeyDown={handleTreeKeyDown}
                onContextMenu={openRootMenu}
                onDragOver={(e) => handleDragOver(e, "")}
                onDragLeave={() => setDropTarget((prev) => (prev === "" ? null : prev))}
                onDrop={(e) => handleDrop(e, "")}
                onClick={(e) => { if (e.target === e.currentTarget) setSelection([]); }}
              >
                {rows.map(renderRow)}
                {rootEntries.length === 0 && !draft && (
                  <div className="sc-empty">This folder is empty</div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {pendingDelete && (
        <DeleteConfirm
          paths={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={(permanent) => confirmDelete(pendingDelete, permanent)}
        />
      )}
    </div>
  );
}
