import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronDown, Search, X } from "lucide-react";
import { fileApi, type FileSearchResult } from "../lib/api.js";
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

function resolveFolderIcon(label: string, open: boolean): string {
  const segment = label.split("/")[0]!.toLowerCase();
  const pair = FOLDER_MAP[segment];
  if (pair) return `${BASE}/folders/${open ? pair[1] : pair[0]}`;
  return `${BASE}/folders/${open ? "default-open.svg" : "default.svg"}`;
}

// ── Tree data structures ───────────────────────────────────────────────────────

interface ExplorerFileNode { kind: "file"; name: string; relPath: string }
interface ExplorerDirNode  { kind: "dir";  label: string; children: ExplorerTreeNode[] }
type ExplorerTreeNode = ExplorerDirNode | ExplorerFileNode;

function insertExplorerEntry(root: ExplorerDirNode, parts: string[], relPath: string): void {
  if (parts.length === 1) { root.children.push({ kind: "file", name: parts[0]!, relPath }); return; }
  const dirName = parts[0]!;
  let dir = root.children.find((c): c is ExplorerDirNode => c.kind === "dir" && c.label === dirName);
  if (!dir) { dir = { kind: "dir", label: dirName, children: [] }; root.children.push(dir); }
  insertExplorerEntry(dir, parts.slice(1), relPath);
}

function collapseExplorerSingletons(node: ExplorerDirNode): ExplorerDirNode {
  const collapsed = node.children.map((c) => c.kind === "dir" ? collapseExplorerSingletons(c) : c);
  if (collapsed.length === 1 && collapsed[0]!.kind === "dir") {
    const only = collapsed[0] as ExplorerDirNode;
    return { kind: "dir", label: node.label === "" ? only.label : `${node.label}/${only.label}`, children: only.children };
  }
  return { ...node, children: collapsed };
}

function buildExplorerTree(files: string[]): ExplorerTreeNode[] {
  const root: ExplorerDirNode = { kind: "dir", label: "", children: [] };
  for (const relPath of files) {
    const parts = relPath.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    insertExplorerEntry(root, parts, relPath);
  }
  function sortChildren(children: ExplorerTreeNode[]): ExplorerTreeNode[] {
    return [...children].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      const aL = a.kind === "dir" ? a.label : a.name;
      const bL = b.kind === "dir" ? b.label : b.name;
      return aL.localeCompare(bL);
    });
  }
  function sortTree(nodes: ExplorerTreeNode[]): ExplorerTreeNode[] {
    return sortChildren(nodes).map((n) => n.kind === "dir" ? { ...n, children: sortTree(n.children) } : n);
  }
  return sortTree(collapseExplorerSingletons(root).children);
}

// ── Tree rendering ─────────────────────────────────────────────────────────────

const INDENT = 16;
const BASE_INDENT = 4;

function ExplorerFileNodeRow({
  node, depth, activeFilePath, openFilePaths, onFileOpen,
}: {
  node: ExplorerFileNode; depth: number; activeFilePath: string | null;
  openFilePaths: Set<string>; onFileOpen: (relPath: string) => void;
}) {
  const isActive = activeFilePath === node.relPath;
  const isOpen   = openFilePaths.has(node.relPath);
  return (
    <div
      className={`files-tree-file files-tree-file--clickable${isActive ? " files-tree-file--active" : ""}`}
      style={{ paddingLeft: BASE_INDENT + depth * INDENT + 20 }}
      title={node.relPath}
      onClick={() => onFileOpen(node.relPath)}
    >
      <img className="files-tree-icon" src={resolveFileIcon(node.name)} alt="" draggable={false} />
      <span className={`files-tree-name${isOpen && !isActive ? " files-tree-name--open" : ""}`}>{node.name}</span>
    </div>
  );
}

function ExplorerDirNodeRow({
  node, depth, activeFilePath, openFilePaths, onFileOpen,
}: {
  node: ExplorerDirNode; depth: number; activeFilePath: string | null;
  openFilePaths: Set<string>; onFileOpen: (relPath: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const paddingLeft = BASE_INDENT + depth * INDENT;
  const guideLeft   = paddingLeft + 8;
  return (
    <div className="files-tree-dir-group">
      <div className="files-tree-dir files-tree-dir--clickable" onClick={() => setOpen((v) => !v)} style={{ paddingLeft }}>
        <span className="files-tree-chevron">{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
        <img className="files-tree-icon" src={resolveFolderIcon(node.label, open)} alt="" draggable={false} />
        <span className="files-tree-dir-name">{node.label}</span>
      </div>
      {open && (
        <div className="files-tree-children" style={{ "--indent-guide-left": `${guideLeft}px` } as React.CSSProperties}>
          {node.children.map((child, i) =>
            child.kind === "dir" ? (
              <ExplorerDirNodeRow key={i} node={child} depth={depth + 1} activeFilePath={activeFilePath} openFilePaths={openFilePaths} onFileOpen={onFileOpen} />
            ) : (
              <ExplorerFileNodeRow key={i} node={child} depth={depth + 1} activeFilePath={activeFilePath} openFilePaths={openFilePaths} onFileOpen={onFileOpen} />
            ),
          )}
        </div>
      )}
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
}

// ── Main component ─────────────────────────────────────────────────────────────

export function FileExplorerSidebar({ repoPath, hidden, activeFilePath, openFilePaths, onFileOpen, onFileViewerOpen }: Props) {
  const [files, setFiles]           = useState<string[]>([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const hasLoadedRef                = useRef(false);
  const openFilePathsSet            = new Set(openFilePaths);

  // ── Search state ─────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery]     = useState("");
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

  // ── File tree loading ─────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      setError(null);
      const result = await fileApi.listFiles(repoPath);
      setFiles(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [repoPath]);

  useEffect(() => { setFiles([]); setError(null); hasLoadedRef.current = false; }, [repoPath]);

  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const wasHiddenRef = useRef(hidden);
  useEffect(() => {
    const becameVisible = wasHiddenRef.current && !hidden;
    wasHiddenRef.current = hidden;
    if (hidden) return;
    if (becameVisible) void refresh();
  }, [hidden, refresh]);

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
        const res = await fileApi.searchFiles(repoPath, searchQuery, excludeExts, 0);
        setSearchResults(res.matches);
        setSearchTotal(res.total);
        setSearchHasMore(res.hasMore);
        setSearchOffset(res.matches.length);
      } catch { /* ignore */ } finally {
        setSearching(false);
      }
    }, 280);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchQuery, excludeExts, repoPath]);

  // ── Load next page ────────────────────────────────────────────────────────────
  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !searchHasMore) return;
    setLoadingMore(true);
    try {
      const res = await fileApi.searchFiles(repoPath, searchQuery, excludeExts, searchOffset);
      setSearchResults((prev) => [...prev, ...res.matches]);
      setSearchTotal((prev) => prev + res.total);
      setSearchHasMore(res.hasMore);
      setSearchOffset((prev) => prev + res.matches.length);
    } catch { /* ignore */ } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, searchHasMore, repoPath, searchQuery, excludeExts, searchOffset]);

  const handleFileViewerOpen = (relPath: string) => {
    onFileViewerOpen({ path: `${repoPath}/${relPath}`, relPath, op: "edit" });
  };

  const tree = buildExplorerTree(files);

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
            placeholder="Search files…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          {searchQuery && (
            <button className="fes-search-clear" onClick={() => { setSearchQuery(""); searchInputRef.current?.focus(); }}>
              <X size={11} />
            </button>
          )}
        </div>
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
            {error && <div className="sc-error">{error}</div>}
            {!loading && !error && files.length === 0 && <div className="sc-empty">No files found</div>}
            {!error && files.length > 0 && (
              <div className="files-tree">
                {tree.map((node, i) =>
                  node.kind === "dir" ? (
                    <ExplorerDirNodeRow key={i} node={node} depth={0} activeFilePath={activeFilePath} openFilePaths={openFilePathsSet} onFileOpen={onFileOpen} />
                  ) : (
                    <ExplorerFileNodeRow key={i} node={node} depth={0} activeFilePath={activeFilePath} openFilePaths={openFilePathsSet} onFileOpen={onFileOpen} />
                  ),
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
