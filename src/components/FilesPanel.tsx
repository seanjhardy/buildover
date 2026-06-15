import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { FileEntry } from "../hooks/useFilesChanged.js";

// ---------------------------------------------------------------------------
// Icon resolution — maps filenames / extensions to Great Icons assets
// ---------------------------------------------------------------------------

const BASE = "/file-icons";

/** Extension → icon filename (without leading dot). Order matters: more specific first. */
const EXT_MAP: Record<string, string> = {
  // TypeScript / JavaScript
  "ts":    "typescript.svg",
  "tsx":   "react-alt.svg",
  "js":    "javascript.svg",
  "mjs":   "javascript.svg",
  "cjs":   "javascript.svg",
  "es6":   "javascript.svg",
  "jsx":   "react.svg",
  "mts":   "typescript.svg",
  "cts":   "typescript.svg",
  // Web
  "css":   "css.svg",
  "scss":  "sass.svg",
  "sass":  "sass.svg",
  "less":  "less.svg",
  "html":  "html.svg",
  "htm":   "html.svg",
  // Data / config
  "json":  "json.svg",
  "yml":   "yaml.svg",
  "yaml":  "yaml.svg",
  "toml":  "toml.png",
  "xml":   "settings.svg",
  "ini":   "settings.svg",
  "conf":  "settings.svg",
  "env":   "dotenv.svg",
  // Languages
  "py":    "python.svg",
  "rs":    "rust.svg",
  "go":    "go.svg",
  "rb":    "ruby.svg",
  "php":   "php.svg",
  "java":  "java.svg",
  "cs":    "csharp.svg",
  "cpp":   "cpp.svg",
  "cc":    "cpp.svg",
  "cxx":   "cpp.svg",
  "c":     "c.png",
  "h":     "c-h.png",
  "hpp":   "cpp-h.png",
  "swift": "swift.svg",
  "kt":    "kotlin.svg",
  "kts":   "kotlin.svg",
  "dart":  "dart.svg",
  "lua":   "lua.svg",
  "zig":   "zig.svg",
  "tf":    "terraform.svg",
  "r":     "settings.svg",
  // Docs / text
  "md":    "markdown.svg",
  "mdx":   "mdx.svg",
  "txt":   "notepad.svg",
  "log":   "log.svg",
  // Shell
  "sh":    "shell.png",
  "bash":  "shell.png",
  "zsh":   "shell.png",
  "fish":  "shell.png",
  // DB
  "sql":   "database.svg",
  "db":    "database.svg",
  "graphql": "graphql.svg",
  "gql":   "graphql.svg",
  "prisma":"prisma.svg",
  // Tooling
  "svg":   "svg.svg",
  "pdf":   "pdf.svg",
  "zip":   "zip.svg",
  "rar":   "zip.svg",
  "gz":    "zip.svg",
  // Media
  "png":   "image.png",
  "jpg":   "image.png",
  "jpeg":  "image.png",
  "gif":   "image.png",
  "webp":  "image.png",
  "mp3":   "audio.png",
  "wav":   "audio.png",
  "mp4":   "video.png",
  "webm":  "video.png",
  "mov":   "video.png",
};

/** Exact filename → icon filename */
const NAME_MAP: Record<string, string> = {
  "package.json":         "npm.svg",
  "package-lock.json":    "npm.svg",
  "dockerfile":           "docker.svg",
  "docker-compose.yml":   "docker.svg",
  "docker-compose.yaml":  "docker.svg",
  ".gitignore":           "git.svg",
  ".gitattributes":       "git.svg",
  ".eslintrc":            "eslint.svg",
  ".eslintrc.js":         "eslint.svg",
  ".eslintrc.json":       "eslint.svg",
  ".eslintrc.yml":        "eslint.svg",
  ".prettierrc":          "prettier.svg",
  "prettier.config.js":   "prettier.svg",
  "vite.config.ts":       "vitejs.svg",
  "vite.config.js":       "vitejs.svg",
  "tailwind.config.ts":   "tailwind.svg",
  "tailwind.config.js":   "tailwind.svg",
  "next.config.ts":       "nextjs.svg",
  "next.config.js":       "nextjs.svg",
  "jest.config.ts":       "jest.svg",
  "jest.config.js":       "jest.svg",
  "vitest.config.ts":     "vitest.svg",
  "vitest.config.js":     "vitest.svg",
  "turbo.json":           "turborepo.svg",
  ".editorconfig":        "settings.svg",
  "postcss.config.js":    "postcss.svg",
  "webpack.config.js":    "webpack.svg",
  "webpack.config.ts":    "webpack.svg",
};

/** Folder name → icon filename (closed, open) */
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

  // Multi-part extension: e.g. "foo.test.ts", "foo.spec.tsx"
  const parts = lower.split(".");
  if (parts.length >= 3) {
    const compound = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (compound === "test.ts" || compound === "spec.ts" || compound === "test.tsx" || compound === "spec.tsx") {
      return `${BASE}/vitest.svg`;
    }
    if (compound === "test.js" || compound === "spec.js" || compound === "test.jsx" || compound === "spec.jsx") {
      return `${BASE}/jest.svg`;
    }
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

// ---------------------------------------------------------------------------
// Tree data structure
// ---------------------------------------------------------------------------

interface DirNode {
  kind: "dir";
  label: string;
  children: TreeNode[];
}

interface FileNode {
  kind: "file";
  name: string;
  entry: FileEntry;
}

type TreeNode = DirNode | FileNode;

function insertEntry(root: DirNode, parts: string[], entry: FileEntry): void {
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
  const collapsedChildren = node.children.map((c) =>
    c.kind === "dir" ? collapseSingletons(c) : c,
  );
  if (collapsedChildren.length === 1 && collapsedChildren[0]!.kind === "dir") {
    const only = collapsedChildren[0] as DirNode;
    return {
      kind: "dir",
      label: node.label === "" ? only.label : `${node.label}/${only.label}`,
      children: only.children,
    };
  }
  return { ...node, children: collapsedChildren };
}

function buildTree(entries: FileEntry[]): TreeNode[] {
  const root: DirNode = { kind: "dir", label: "", children: [] };
  for (const entry of entries) {
    const parts = entry.relPath.split("/").filter(Boolean);
    insertEntry(root, parts, entry);
  }
  function sortChildren(children: TreeNode[]): TreeNode[] {
    return [...children].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      const aLabel = a.kind === "dir" ? a.label : a.name;
      const bLabel = b.kind === "dir" ? b.label : b.name;
      return aLabel.localeCompare(bLabel);
    });
  }
  function sortTree(nodes: TreeNode[]): TreeNode[] {
    return sortChildren(nodes).map((n) =>
      n.kind === "dir" ? { ...n, children: sortTree(n.children) } : n,
    );
  }
  const collapsed = collapseSingletons(root);
  return sortTree(collapsed.children);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function fileNameClass(op: FileEntry["op"]): string {
  if (op === "write")  return "files-tree-name files-tree-name--added";
  if (op === "delete") return "files-tree-name files-tree-name--deleted";
  return "files-tree-name files-tree-name--edited";
}

function StatBadge({ added, removed }: { added?: number; removed?: number }) {
  const hasAdded   = (added   ?? 0) > 0;
  const hasRemoved = (removed ?? 0) > 0;
  if (!hasAdded && !hasRemoved) return null;
  return (
    <span className="files-stats">
      {hasAdded   && <span className="files-stat-added">+{added}</span>}
      {hasRemoved && <span className="files-stat-removed">-{removed}</span>}
    </span>
  );
}

const INDENT = 16;
const BASE_INDENT = 4;

function FileNodeRow({
  node,
  depth,
  onFileOpen,
  activeFilePath,
}: {
  node: FileNode;
  depth: number;
  onFileOpen: (entry: FileEntry) => void;
  activeFilePath: string | null;
}) {
  const paddingLeft = BASE_INDENT + depth * INDENT + 20;
  const isActive = activeFilePath === node.entry.path;
  return (
    <div
      className={`files-tree-file files-tree-file--clickable${isActive ? " files-tree-file--active" : ""}`}
      style={{ paddingLeft }}
      onClick={() => onFileOpen(node.entry)}
      title={node.entry.relPath}
    >
      <img
        className="files-tree-icon"
        src={resolveFileIcon(node.name)}
        alt=""
        draggable={false}
      />
      <span className={fileNameClass(node.entry.op)}>
        {node.name}
      </span>
      <StatBadge added={node.entry.added} removed={node.entry.removed} />
    </div>
  );
}

function DirNodeRow({
  node,
  depth,
  onFileOpen,
  activeFilePath,
}: {
  node: DirNode;
  depth: number;
  onFileOpen: (entry: FileEntry) => void;
  activeFilePath: string | null;
}) {
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
              <DirNodeRow
                key={i}
                node={child}
                depth={depth + 1}
                onFileOpen={onFileOpen}
                activeFilePath={activeFilePath}
              />
            ) : (
              <FileNodeRow
                key={i}
                node={child}
                depth={depth + 1}
                onFileOpen={onFileOpen}
                activeFilePath={activeFilePath}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface Props {
  files: FileEntry[];
  onFileOpen: (entry: FileEntry) => void;
  activeFilePath: string | null;
  /** When true, renders as a narrow icon strip (same style as the jump bar) */
  compact?: boolean;
}

function opIcon(op: FileEntry["op"]): string {
  if (op === "write") return "+";
  if (op === "delete") return "−";
  return "~";
}

/** Full panel — shown when there is enough horizontal space */
function FullPanel({ files, onFileOpen, activeFilePath }: { files: FileEntry[]; onFileOpen: (entry: FileEntry) => void; activeFilePath: string | null }) {
  const [collapsed, setCollapsed] = useState(false);

  const tree = buildTree(files);
  const totalAdded   = files.reduce((s, f) => s + (f.added   ?? 0), 0);
  const totalRemoved = files.reduce((s, f) => s + (f.removed ?? 0), 0);

  return (
    <div className="files-panel">
      <div
        className="files-panel-header"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? "Expand files" : "Collapse files"}
      >
        <span>Files</span>
        <span className="files-panel-header-right">
          {collapsed ? (
            <span className="files-panel-count">{files.length}</span>
          ) : (
            <StatBadge added={totalAdded} removed={totalRemoved} />
          )}
          <span className="files-panel-chevron">
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
        </span>
      </div>
      {!collapsed && (
        <div className="files-tree">
          {tree.map((node, i) =>
            node.kind === "dir" ? (
              <DirNodeRow
                key={i}
                node={node}
                depth={0}
                onFileOpen={onFileOpen}
                activeFilePath={activeFilePath}
              />
            ) : (
              <FileNodeRow
                key={i}
                node={node}
                depth={0}
                onFileOpen={onFileOpen}
                activeFilePath={activeFilePath}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Icon strip — shown when the window is narrow; sits in the right-rail beside the jump bar */
function IconStrip({ files, onFileOpen }: { files: FileEntry[]; onFileOpen: (entry: FileEntry) => void }) {
  return (
    <div className="files-icon-strip">
      {files.map((file, i) => (
        <button
          key={i}
          type="button"
          className={`files-strip-item files-strip-item--${file.op}`}
          onClick={() => onFileOpen(file)}
        >
          <span className="files-strip-icon">{opIcon(file.op)}</span>
          <div className="files-strip-tooltip">
            {file.relPath}
          </div>
        </button>
      ))}
    </div>
  );
}

export function FilesPanel({ files, onFileOpen, activeFilePath, compact }: Props) {
  if (files.length === 0) return null;
  return compact ? <IconStrip files={files} onFileOpen={onFileOpen} /> : <FullPanel files={files} onFileOpen={onFileOpen} activeFilePath={activeFilePath} />;
}
