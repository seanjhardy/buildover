import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, ChevronsUp, ChevronRight, ChevronDown, RefreshCw } from "lucide-react";
import { gitApi, type GitStatus } from "../lib/api.js";
import type { ChangedFile } from "../lib/api.js";

// ── Icon helpers (mirrored from FilesPanel) ────────────────────────────────────

const BASE = "/file-icons";

const EXT_MAP: Record<string, string> = {
  "ts":      "typescript.svg",
  "tsx":     "react-alt.svg",
  "js":      "javascript.svg",
  "mjs":     "javascript.svg",
  "cjs":     "javascript.svg",
  "es6":     "javascript.svg",
  "jsx":     "react.svg",
  "mts":     "typescript.svg",
  "cts":     "typescript.svg",
  "css":     "css.svg",
  "scss":    "sass.svg",
  "sass":    "sass.svg",
  "less":    "less.svg",
  "html":    "html.svg",
  "htm":     "html.svg",
  "json":    "json.svg",
  "yml":     "yaml.svg",
  "yaml":    "yaml.svg",
  "toml":    "toml.png",
  "xml":     "settings.svg",
  "ini":     "settings.svg",
  "conf":    "settings.svg",
  "env":     "dotenv.svg",
  "py":      "python.svg",
  "rs":      "rust.svg",
  "go":      "go.svg",
  "rb":      "ruby.svg",
  "php":     "php.svg",
  "java":    "java.svg",
  "cs":      "csharp.svg",
  "cpp":     "cpp.svg",
  "cc":      "cpp.svg",
  "cxx":     "cpp.svg",
  "c":       "c.png",
  "h":       "c-h.png",
  "hpp":     "cpp-h.png",
  "swift":   "swift.svg",
  "kt":      "kotlin.svg",
  "kts":     "kotlin.svg",
  "dart":    "dart.svg",
  "lua":     "lua.svg",
  "zig":     "zig.svg",
  "tf":      "terraform.svg",
  "r":       "settings.svg",
  "md":      "markdown.svg",
  "mdx":     "mdx.svg",
  "txt":     "notepad.svg",
  "log":     "log.svg",
  "sh":      "shell.png",
  "bash":    "shell.png",
  "zsh":     "shell.png",
  "fish":    "shell.png",
  "sql":     "database.svg",
  "db":      "database.svg",
  "graphql": "graphql.svg",
  "gql":     "graphql.svg",
  "prisma":  "prisma.svg",
  "svg":     "svg.svg",
  "pdf":     "pdf.svg",
  "zip":     "zip.svg",
  "rar":     "zip.svg",
  "gz":      "zip.svg",
  "png":     "image.png",
  "jpg":     "image.png",
  "jpeg":    "image.png",
  "gif":     "image.png",
  "webp":    "image.png",
  "mp3":     "audio.png",
  "wav":     "audio.png",
  "mp4":     "video.png",
  "webm":    "video.png",
  "mov":     "video.png",
};

const NAME_MAP: Record<string, string> = {
  "package.json":        "npm.svg",
  "package-lock.json":   "npm.svg",
  "dockerfile":          "docker.svg",
  "docker-compose.yml":  "docker.svg",
  "docker-compose.yaml": "docker.svg",
  ".gitignore":          "git.svg",
  ".gitattributes":      "git.svg",
  ".eslintrc":           "eslint.svg",
  ".eslintrc.js":        "eslint.svg",
  ".eslintrc.json":      "eslint.svg",
  ".eslintrc.yml":       "eslint.svg",
  ".prettierrc":         "prettier.svg",
  "prettier.config.js":  "prettier.svg",
  "vite.config.ts":      "vitejs.svg",
  "vite.config.js":      "vitejs.svg",
  "tailwind.config.ts":  "tailwind.svg",
  "tailwind.config.js":  "tailwind.svg",
  "next.config.ts":      "nextjs.svg",
  "next.config.js":      "nextjs.svg",
  "jest.config.ts":      "jest.svg",
  "jest.config.js":      "jest.svg",
  "vitest.config.ts":    "vitest.svg",
  "vitest.config.js":    "vitest.svg",
  "turbo.json":          "turborepo.svg",
  ".editorconfig":       "settings.svg",
  "postcss.config.js":   "postcss.svg",
  "webpack.config.js":   "webpack.svg",
  "webpack.config.ts":   "webpack.svg",
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

function resolveFileIcon(name: string): string {
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

// ── Status helpers ─────────────────────────────────────────────────────────────

function statusToOp(statusCode: string): "write" | "delete" | "edit" {
  const x = statusCode[0] ?? " ";
  const y = statusCode[1] ?? " ";
  if (statusCode === "??" || x === "A") return "write";
  if (x === "D" || y === "D") return "delete";
  return "edit";
}

function statusLetter(statusCode: string): string {
  if (statusCode === "??") return "U";
  const x = statusCode[0] ?? " ";
  const y = statusCode[1] ?? " ";
  if (x === "A") return "A";
  if (x === "D" || y === "D") return "D";
  if (x === "R") return "R";
  if (x === "M" || y === "M") return "M";
  return x !== " " ? x : y;
}

// ── Tree data structures (adapted from FilesPanel) ─────────────────────────────

interface ScEntry {
  relPath: string;
  statusCode: string;
}

interface DirNode {
  kind: "dir";
  label: string;
  children: TreeNode[];
}

interface FileNode {
  kind: "file";
  name: string;
  entry: ScEntry;
}

type TreeNode = DirNode | FileNode;

function insertEntry(root: DirNode, parts: string[], entry: ScEntry): void {
  if (parts.length === 1) {
    root.children.push({ kind: "file", name: parts[0]!, entry });
    return;
  }
  const dirName = parts[0]!;
  let dir = root.children.find(
    (c): c is DirNode => c.kind === "dir" && c.label === dirName,
  );
  if (!dir) {
    dir = { kind: "dir", label: dirName, children: [] };
    root.children.push(dir);
  }
  insertEntry(dir, parts.slice(1), entry);
}

function collapseSingletons(node: DirNode): DirNode {
  const collapsed = node.children.map((c) =>
    c.kind === "dir" ? collapseSingletons(c) : c,
  );
  if (collapsed.length === 1 && collapsed[0]!.kind === "dir") {
    const only = collapsed[0] as DirNode;
    return {
      kind: "dir",
      label: node.label === "" ? only.label : `${node.label}/${only.label}`,
      children: only.children,
    };
  }
  return { ...node, children: collapsed };
}

function buildTree(files: ChangedFile[]): TreeNode[] {
  const root: DirNode = { kind: "dir", label: "", children: [] };
  for (const file of files) {
    const entry: ScEntry = { relPath: file.path, statusCode: file.statusCode };
    const parts = file.path.split("/").filter(Boolean);
    insertEntry(root, parts, entry);
  }
  function sortChildren(children: TreeNode[]): TreeNode[] {
    return [...children].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      const aL = a.kind === "dir" ? a.label : a.name;
      const bL = b.kind === "dir" ? b.label : b.name;
      return aL.localeCompare(bL);
    });
  }
  function sortTree(nodes: TreeNode[]): TreeNode[] {
    return sortChildren(nodes).map((n) =>
      n.kind === "dir" ? { ...n, children: sortTree(n.children) } : n,
    );
  }
  return sortTree(collapseSingletons(root).children);
}

// ── Tree rendering (same classes as FilesPanel) ────────────────────────────────

const INDENT = 16;
const BASE_INDENT = 4;

function fileNameClass(statusCode: string): string {
  const op = statusToOp(statusCode);
  if (op === "write")  return "files-tree-name files-tree-name--added";
  if (op === "delete") return "files-tree-name files-tree-name--deleted";
  return "files-tree-name";
}

function ScFileNodeRow({ node, depth }: { node: FileNode; depth: number }) {
  const paddingLeft = BASE_INDENT + depth * INDENT + 20;
  const letter = statusLetter(node.entry.statusCode);
  const op = statusToOp(node.entry.statusCode);
  const letterClass =
    op === "write"  ? "sc-status-letter sc-status-letter--added"   :
    op === "delete" ? "sc-status-letter sc-status-letter--deleted"  :
                      "sc-status-letter sc-status-letter--modified";
  return (
    <div
      className="files-tree-file"
      style={{ paddingLeft }}
      title={node.entry.relPath}
    >
      <img
        className="files-tree-icon"
        src={resolveFileIcon(node.name)}
        alt=""
        draggable={false}
      />
      <span className={fileNameClass(node.entry.statusCode)}>
        {node.name}
      </span>
      <span className={letterClass}>{letter}</span>
    </div>
  );
}

function ScDirNodeRow({ node, depth }: { node: DirNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const paddingLeft = BASE_INDENT + depth * INDENT;
  const guideLeft = paddingLeft + 8;

  return (
    <div className="files-tree-dir-group">
      <div
        className="files-tree-dir files-tree-dir--clickable"
        onClick={() => setOpen((v) => !v)}
        style={{ paddingLeft }}
      >
        <span className="files-tree-chevron">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <img
          className="files-tree-icon"
          src={resolveFolderIcon(node.label, open)}
          alt=""
          draggable={false}
        />
        <span className="files-tree-dir-name">{node.label}</span>
      </div>
      {open && (
        <div
          className="files-tree-children"
          style={{ "--indent-guide-left": `${guideLeft}px` } as React.CSSProperties}
        >
          {node.children.map((child, i) =>
            child.kind === "dir" ? (
              <ScDirNodeRow key={i} node={child} depth={depth + 1} />
            ) : (
              <ScFileNodeRow key={i} node={child} depth={depth + 1} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ScFileTree({ files }: { files: ChangedFile[] }) {
  const tree = buildTree(files);
  return (
    <div className="files-tree">
      {tree.map((node, i) =>
        node.kind === "dir" ? (
          <ScDirNodeRow key={i} node={node} depth={0} />
        ) : (
          <ScFileNodeRow key={i} node={node} depth={0} />
        ),
      )}
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  repoPath: string;
  onOpenGraph?: () => void;
}

// ── Main component ─────────────────────────────────────────────────────────────

export function SourceControlSidebar({ repoPath, onOpenGraph }: Props) {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [statusFiles, setStatusFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [opLoading, setOpLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [showCommitInput, setShowCommitInput] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [stagedExpanded, setStagedExpanded] = useState(true);
  const [changesExpanded, setChangesExpanded] = useState(true);
  const branchPickerRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [status, filesResult] = await Promise.all([
        gitApi.getStatus(repoPath),
        gitApi.getStatusFiles(repoPath).catch(() => null),
      ]);
      setGitStatus(status);
      if (filesResult) setStatusFiles(filesResult);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [repoPath]);

  // Reset when repo changes
  useEffect(() => {
    setGitStatus(null);
    setStatusFiles([]);
    setError(null);
    setShowBranchPicker(false);
    setShowCommitInput(false);
    setCommitMessage("");
  }, [repoPath]);

  // Initial load + polling
  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Close branch picker on outside click
  useEffect(() => {
    if (!showBranchPicker) return;
    const handler = (e: MouseEvent) => {
      if (branchPickerRef.current && !branchPickerRef.current.contains(e.target as Node)) {
        setShowBranchPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showBranchPicker]);

  const handleCheckout = async (branch: string) => {
    setShowBranchPicker(false);
    setOpLoading("checkout");
    setError(null);
    try {
      await gitApi.checkout(repoPath, branch);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpLoading(null);
    }
  };

  const handleCommit = async () => {
    if (!commitMessage.trim()) return;
    setOpLoading("commit");
    setError(null);
    try {
      await gitApi.commit(repoPath, commitMessage.trim());
      setCommitMessage("");
      setShowCommitInput(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpLoading(null);
    }
  };

  const handlePush = async () => {
    setOpLoading("push");
    setError(null);
    try {
      await gitApi.push(repoPath);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpLoading(null);
    }
  };

  const handleForcePush = async () => {
    setOpLoading("push");
    setError(null);
    try {
      await gitApi.forcePush(repoPath);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpLoading(null);
    }
  };

  const handlePull = async () => {
    setOpLoading("pull");
    setError(null);
    try {
      await gitApi.pull(repoPath);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpLoading(null);
    }
  };

  const busy = opLoading !== null;
  const stagedFiles = statusFiles.filter((f) => f.staged);
  const unstagedFiles = statusFiles.filter((f) => f.unstaged);
  const hasChanges = statusFiles.length > 0 || (gitStatus?.isDirty ?? false);

  return (
    <div className="sc-sidebar">
      {/* Header */}
      <div className="sc-sidebar-header">
        <span className="sc-sidebar-title">Source Control</span>
        <button
          className="sc-icon-btn"
          onClick={() => void refresh()}
          disabled={loading && !gitStatus}
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />
        </button>
      </div>

      {/* Scrollable file tree */}
      <div className="sc-sidebar-body">
        {loading && !gitStatus && (
          <div className="git-status-row git-muted" style={{ padding: "6px 12px" }}>
            Loading…
          </div>
        )}

        {error && (
          <div className="git-error" style={{ margin: "6px 8px" }} title={error}>
            {error.length > 80 ? error.slice(0, 80) + "…" : error}
          </div>
        )}

        {gitStatus && (
          <>
            {stagedFiles.length > 0 && (
              <div className="sc-section">
                <button
                  className="sc-section-header"
                  onClick={() => setStagedExpanded((v) => !v)}
                >
                  {stagedExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  Staged Changes
                  <span className="sc-section-count">{stagedFiles.length}</span>
                </button>
                {stagedExpanded && <ScFileTree files={stagedFiles} />}
              </div>
            )}

            {unstagedFiles.length > 0 && (
              <div className="sc-section">
                <button
                  className="sc-section-header"
                  onClick={() => setChangesExpanded((v) => !v)}
                >
                  {changesExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  Changes
                  <span className="sc-section-count">{unstagedFiles.length}</span>
                </button>
                {changesExpanded && <ScFileTree files={unstagedFiles} />}
              </div>
            )}

            {!hasChanges && (
              <div className="git-muted" style={{ padding: "6px 12px" }}>
                No changes
              </div>
            )}
          </>
        )}
      </div>

      {/* Git controls footer — matches GitPanel design exactly */}
      {gitStatus && (
        <div className="sc-sidebar-footer">
          {/* Branch switcher + graph button */}
          <div className="git-branch-row-wrap">
            <div className="git-branch-row" ref={branchPickerRef}>
              <button
                type="button"
                className="git-branch-btn"
                onClick={() => setShowBranchPicker((v) => !v)}
                disabled={busy}
              >
                <span className="git-icon">⎇</span>
                <span className="git-branch-name">{gitStatus.currentBranch}</span>
                <span className="git-chevron">
                  {opLoading === "checkout" ? "…" : "▾"}
                </span>
              </button>

              {showBranchPicker && (
                <div className="git-branch-list">
                  {gitStatus.branches.map((b) => (
                    <button
                      key={b}
                      type="button"
                      className={`git-branch-item${b === gitStatus.currentBranch ? " active" : ""}`}
                      onClick={() => void handleCheckout(b)}
                    >
                      {b === gitStatus.currentBranch && (
                        <span className="git-branch-check">✓ </span>
                      )}
                      {b}
                    </button>
                  ))}
                  {gitStatus.branches.length === 0 && (
                    <div className="git-branch-item git-muted">No branches found</div>
                  )}
                </div>
              )}
            </div>

            {/* Open git graph */}
            <button
              type="button"
              className="git-tree-btn"
              onClick={() => onOpenGraph?.()}
              title="Open git graph"
            >
              <GitBranch size={13} />
            </button>
          </div>

          {/* Commit */}
          <div className="git-section">
            {showCommitInput ? (
              <div className="git-commit-form">
                <input
                  className="git-commit-input"
                  type="text"
                  placeholder="Commit message…"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCommit();
                    if (e.key === "Escape") {
                      setShowCommitInput(false);
                      setCommitMessage("");
                    }
                  }}
                  autoFocus
                  disabled={opLoading === "commit"}
                />
                <div className="git-commit-actions">
                  <button
                    type="button"
                    className="git-action-btn git-action-primary"
                    onClick={() => void handleCommit()}
                    disabled={!commitMessage.trim() || opLoading === "commit"}
                  >
                    {opLoading === "commit" ? "Committing…" : "Commit"}
                  </button>
                  <button
                    type="button"
                    className="git-action-btn"
                    onClick={() => { setShowCommitInput(false); setCommitMessage(""); }}
                    disabled={opLoading === "commit"}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="git-action-btn"
                onClick={() => setShowCommitInput(true)}
                disabled={!hasChanges || busy}
                title={hasChanges ? "Stage all & commit" : "Nothing to commit"}
              >
                <span className="git-icon">✓</span>
                Commit
                {hasChanges && (
                  <span className="git-dirty-dot" title="Uncommitted changes" />
                )}
              </button>
            )}
          </div>

          {/* Push / Pull */}
          <div className="git-sync-row">
            <button
              type="button"
              className="git-action-btn git-sync-btn"
              onClick={() => void handlePull()}
              disabled={busy}
              title="Pull from origin"
            >
              <span className="git-icon">↓</span>
              {opLoading === "pull" ? "Pulling…" : "Pull"}
              {gitStatus.behind > 0 && (
                <span className="git-badge">{gitStatus.behind}</span>
              )}
            </button>
            <div className="git-push-split">
              <button
                type="button"
                className="git-action-btn git-push-main"
                onClick={() => void handlePush()}
                disabled={busy}
                title="Push to origin"
              >
                <span className="git-icon">↑</span>
                {opLoading === "push" ? "Pushing…" : "Push"}
                {gitStatus.ahead > 0 && (
                  <span className="git-badge">{gitStatus.ahead}</span>
                )}
              </button>
              <div className="git-force-push-wrap">
                <button
                  type="button"
                  className="git-action-btn git-force-push-btn"
                  onClick={() => void handleForcePush()}
                  disabled={busy}
                  aria-label="Force push (--force-with-lease)"
                >
                  <ChevronsUp size={12} />
                </button>
                <div className="git-force-push-tooltip">
                  Force push
                  <span className="git-force-push-tooltip-sub">--force-with-lease</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
