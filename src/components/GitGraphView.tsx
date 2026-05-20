import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  RefreshCw,
  GitBranch,
  GitCommit as GitCommitIcon,
  Tag,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { gitApi, type CommitDiffFile, type GitCommit, type GitLogResult } from "../lib/api.js";

// ─── constants ────────────────────────────────────────────────────────────────

const ROW_H        = 34;
const EXPANDED_H   = 300;   // fixed height of expanded diff panel
const LANE_W       = 16;
const DOT_R        = 4;
const HEAD_R       = 5;
const LANE_OFFSET  = 12;
const RESIZE_W     = 4;
const MIN_TREE_W   = 60;
const DEFAULT_TREE_W = 220;

// Vibrant, saturated branch colours — index 0 always reserved for HEAD/main
const LANE_COLOURS = [
  "#ff6b2b", // vivid orange   (HEAD / main)
  "#3b9eff", // vivid blue
  "#40c057", // vivid green
  "#9c36b5", // vivid purple
  "#f59f00", // vivid amber
  "#0891b2", // vivid cyan
  "#e03131", // vivid red
  "#1098ad", // vivid teal
];

function laneColor(index: number): string {
  return LANE_COLOURS[index % LANE_COLOURS.length] ?? LANE_COLOURS[0]!;
}

// ─── graph layout ─────────────────────────────────────────────────────────────

export interface GraphNode {
  commit:     GitCommit;
  row:        number;
  lane:       number;
  color:      string;
  parentEdges: ParentEdge[];
  refLabels:  RefLabel[];
  isHead:     boolean;
}

interface EdgeSegment {
  fromRow: number;
  fromX:   number;
  toRow:   number;
  toX:     number;
}

interface ParentEdge {
  segments:   EdgeSegment[];
  color:      string;
  isMerge:    boolean;
  parentHash: string;
}

export interface RefLabel {
  text:        string;
  kind:        "head" | "local" | "remote" | "tag";
  remoteName?: string;  // for remote refs, e.g. "origin"
}

function parseRefs(refs: string): RefLabel[] {
  if (!refs.trim()) return [];
  return refs
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .flatMap<RefLabel>((r) => {
      if (r.startsWith("HEAD -> ")) {
        let branch = r.slice("HEAD -> ".length);
        // git log --decorate=full emits "refs/heads/main"; strip the prefix
        if (branch.startsWith("refs/heads/")) branch = branch.slice("refs/heads/".length);
        return [
          { text: "HEAD",   kind: "head"  as const },
          { text: branch,   kind: "local" as const },
        ];
      }
      if (r === "HEAD") return [{ text: "HEAD", kind: "head" as const }];
      if (r.startsWith("refs/remotes/")) {
        const without = r.slice("refs/remotes/".length);
        const slash   = without.indexOf("/");
        return slash !== -1
          ? [{ text: without.slice(slash + 1), kind: "remote" as const, remoteName: without.slice(0, slash) }]
          : [{ text: without, kind: "remote" as const }];
      }
      if (r.startsWith("refs/heads/"))
        return [{ text: r.slice("refs/heads/".length), kind: "local" as const }];
      if (r.startsWith("refs/tags/"))
        return [{ text: r.slice("refs/tags/".length), kind: "tag" as const }];
      if (r.startsWith("tag: "))
        return [{ text: r.slice("tag: ".length), kind: "tag" as const }];
      return [{ text: r, kind: "local" as const }];
    });
}

export function buildGraphLayout(commits: GitCommit[], currentBranch: string): GraphNode[] {
  if (commits.length === 0) return [];
  const N = commits.length;
  const rowByHash = new Map<string, number>();
  commits.forEach((c, i) => rowByHash.set(c.hash, i));

  const rowOccupied: (Set<number> | undefined)[] = new Array(N);
  const rowNextX:    (number    | undefined)[]   = new Array(N);

  function claimXAt(row: number, x: number) {
    if (row < 0 || row >= N) return;
    let s = rowOccupied[row];
    if (!s) { s = new Set(); rowOccupied[row] = s; }
    s.add(x);
    const cur = rowNextX[row] ?? 0;
    if (x >= cur) rowNextX[row] = x + 1;
  }
  function isXFreeInRange(x: number, r0: number, r1: number) {
    for (let r = r0; r <= r1; r++) if (rowOccupied[r]?.has(x)) return false;
    return true;
  }
  function allocateFreshX(r0: number, r1: number) {
    let max = 0;
    for (let r = r0; r <= r1; r++) max = Math.max(max, rowNextX[r] ?? 0);
    for (let r = r0; r <= r1; r++) claimXAt(r, max);
    return max;
  }

  const availableColors: number[] = [];
  function getAvailableColor(startRow: number, preferIndex?: number) {
    if (preferIndex !== undefined && (availableColors[preferIndex] ?? -1) < startRow)
      return preferIndex;
    for (let i = 0; i < availableColors.length; i++) {
      if (i === preferIndex) continue;
      if ((availableColors[i] ?? -1) < startRow) return i;
    }
    availableColors.push(-1);
    return availableColors.length - 1;
  }
  function extendColor(ci: number, toRow: number) {
    if ((availableColors[ci] ?? -1) < toRow) availableColors[ci] = toRow;
  }

  const lanes:        (string | undefined)[] = [];
  const laneColorIdx: (number | undefined)[] = [];
  function findFreeLane() {
    const i = lanes.indexOf(undefined);
    return i === -1 ? lanes.length : i;
  }

  function routeEdge(startRow: number, startX: number, endRow: number, endX: number): EdgeSegment[] {
    if (endRow <= startRow) return [];
    if (startX === endX) {
      for (let r = startRow + 1; r < endRow; r++) claimXAt(r, startX);
      return [{ fromRow: startRow, fromX: startX, toRow: endRow, toX: endX }];
    }
    const r0 = startRow + 1, r1 = endRow - 1;
    if (r0 > r1)
      return [{ fromRow: startRow, fromX: startX, toRow: endRow, toX: endX }];

    let tX: number, usedFresh = false;
    if (isXFreeInRange(endX, r0, r1))        tX = endX;
    else if (isXFreeInRange(startX, r0, r1)) tX = startX;
    else { tX = allocateFreshX(r0, r1); usedFresh = true; }

    if (!usedFresh) for (let r = r0; r <= r1; r++) claimXAt(r, tX);

    if (tX === startX)
      return [
        { fromRow: startRow,   fromX: startX, toRow: endRow - 1, toX: tX     },
        { fromRow: endRow - 1, fromX: tX,     toRow: endRow,     toX: endX   },
      ];
    return [
      { fromRow: startRow,     fromX: startX, toRow: startRow + 1, toX: tX   },
      { fromRow: startRow + 1, fromX: tX,     toRow: endRow,       toX: endX },
    ];
  }

  let headLane = -1;
  const nodes: GraphNode[] = [];

  for (let row = 0; row < N; row++) {
    const commit = commits[row]!;
    let myLane = lanes.indexOf(commit.hash);
    if (myLane === -1) { myLane = findFreeLane(); lanes[myLane] = commit.hash; }

    claimXAt(row, myLane);

    for (let i = 0; i < lanes.length; i++)
      if (i !== myLane && lanes[i] === commit.hash) lanes[i] = undefined;

    const refsParsed = parseRefs(commit.refs);
    const isHead = refsParsed.some(
      (r) => r.kind === "head" || (r.kind === "local" && r.text === currentBranch),
    );
    if (isHead && headLane === -1) headLane = myLane;

    if (laneColorIdx[myLane] === undefined) {
      const ci = (isHead || myLane === headLane) ? getAvailableColor(row, 0) : getAvailableColor(row);
      laneColorIdx[myLane] = ci;
    }
    const myColorIdx = laneColorIdx[myLane]!;

    const parentEdges: ParentEdge[] = [];
    const { parents } = commit;

    if (parents.length === 0) {
      extendColor(myColorIdx, row);
      lanes[myLane] = undefined;
      laneColorIdx[myLane] = undefined;
    } else {
      lanes[myLane] = parents[0]!;
      for (let pi = 0; pi < parents.length; pi++) {
        const pHash = parents[pi]!;
        const pRow  = rowByHash.get(pHash) ?? (row + 1);
        let pLane: number, pColorIdx: number;

        if (pi === 0) {
          pLane = myLane; pColorIdx = myColorIdx;
        } else {
          const existing = lanes.indexOf(pHash);
          if (existing !== -1) {
            pLane = existing;
            pColorIdx = laneColorIdx[existing] ?? getAvailableColor(row);
            if (laneColorIdx[existing] === undefined) laneColorIdx[existing] = pColorIdx;
          } else {
            pLane = findFreeLane();
            lanes[pLane] = pHash;
            pColorIdx = getAvailableColor(row);
            laneColorIdx[pLane] = pColorIdx;
          }
        }
        extendColor(pColorIdx, pRow);
        parentEdges.push({
          segments:   routeEdge(row, myLane, pRow, pLane),
          color:      laneColor(pColorIdx),
          isMerge:    parents.length > 1,
          parentHash: pHash,
        });
      }

      const retained = new Set<number>([myLane]);
      for (let pi = 1; pi < parents.length; pi++) {
        const idx = lanes.indexOf(parents[pi]!);
        if (idx !== -1) retained.add(idx);
      }
      for (let i = 0; i < lanes.length; i++) {
        if (!retained.has(i) && parents.includes(lanes[i] ?? "")) lanes[i] = undefined;
      }
    }

    nodes.push({ commit, row, lane: myLane, color: laneColor(myColorIdx), parentEdges, refLabels: refsParsed, isHead });
  }
  return nodes;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function relativeDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60)       return "just now";
  if (s < 3600)     return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)    return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000)  return `${Math.floor(s / 86400)}d ago`;
  if (s < 31536000) return `${Math.floor(s / 2592000)}mo ago`;
  return `${Math.floor(s / 31536000)}y ago`;
}

// ─── SVG graph strip ──────────────────────────────────────────────────────────

/** Convert one EdgeSegment to an SVG path, using per-row y-centres. */
function segmentPath(
  seg: EdgeSegment,
  fromVis: number,
  toVis:   number,
  rowCenters: number[],
): string {
  const x1 = LANE_OFFSET + seg.fromX * LANE_W;
  const y1 = rowCenters[fromVis] ?? (fromVis * ROW_H + ROW_H / 2);
  const x2 = LANE_OFFSET + seg.toX   * LANE_W;
  const y2 = rowCenters[toVis]   ?? (toVis   * ROW_H + ROW_H / 2);

  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;

  const span = Math.abs(y2 - y1);
  const d    = Math.min(span * 0.6, ROW_H * 1.2);
  return `M ${x1} ${y1} C ${x1} ${y1 + d}, ${x2} ${y2 - d}, ${x2} ${y2}`;
}

interface GraphSvgProps {
  nodes:       GraphNode[];
  maxLane:     number;
  rowCenters:  number[];
  svgHeight:   number;
  selectedHash: string | null;
  onSelect:    (hash: string) => void;
}

function GraphSvg({ nodes, maxLane, rowCenters, svgHeight, selectedHash, onSelect }: GraphSvgProps) {
  const svgWidth = LANE_OFFSET + (maxLane + 1) * LANE_W + 8;
  const visIdxByAbsRow = new Map<number, number>();
  nodes.forEach((n, vi) => visIdxByAbsRow.set(n.row, vi));

  return (
    <svg
      className="git-graph-svg"
      width={svgWidth}
      height={svgHeight}
      style={{ display: "block", minWidth: svgWidth }}
    >
      {/* Edges */}
      {nodes.map((node) =>
        node.parentEdges.map((edge, ei) =>
          edge.segments.map((seg, si) => {
            const fromVis = visIdxByAbsRow.get(seg.fromRow);
            if (fromVis === undefined) return null;
            const toVis = visIdxByAbsRow.get(seg.toRow);
            const clippedToVis = toVis ?? nodes.length;
            return (
              <path
                key={`${node.commit.hash}-e${ei}-s${si}`}
                d={segmentPath(seg, fromVis, clippedToVis, rowCenters)}
                stroke={edge.color}
                strokeWidth={2}
                fill="none"
                opacity={0.9}
              />
            );
          }),
        ),
      )}

      {/* Dots */}
      {nodes.map((node, visIdx) => {
        const cx = LANE_OFFSET + node.lane * LANE_W;
        const cy = rowCenters[visIdx] ?? (visIdx * ROW_H + ROW_H / 2);
        const r  = node.isHead ? HEAD_R : DOT_R;
        const isSelected = node.commit.hash === selectedHash;
        return (
          <g key={node.commit.hash} style={{ cursor: "pointer" }} onClick={() => onSelect(node.commit.hash)}>
            {isSelected && <circle cx={cx} cy={cy} r={r + 4} fill={node.color} opacity={0.2} />}
            {node.isHead  && <circle cx={cx} cy={cy} r={r + 3} fill={node.color} opacity={0.25} />}
            <circle cx={cx} cy={cy} r={r} fill={node.color} stroke="var(--app-primary-background)" strokeWidth={1.5} />
          </g>
        );
      })}
    </svg>
  );
}

// ─── branch pill ─────────────────────────────────────────────────────────────

interface RefPillProps {
  label:         RefLabel;
  color:         string;          // lane colour for the icon strip
  isCurrentBranch: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
}

function RefPill({ label, color, isCurrentBranch, onContextMenu }: RefPillProps) {
  if (label.kind === "head") return null; // HEAD arrow handled separately

  const borderStyle = isCurrentBranch
    ? { border: `1px solid ${color}` }
    : { border: "1px solid rgba(180,180,180,0.25)" };

  const icon = label.kind === "tag"
    ? <Tag size={9} color="white" />
    : <GitBranch size={9} color="white" />;

  return (
    <span
      className="ggraph-ref-pill"
      style={borderStyle}
      title={label.kind === "remote" ? `${label.remoteName ?? "origin"}/${label.text}` : label.text}
      onContextMenu={onContextMenu}
    >
      {/* Coloured icon strip */}
      <span className="ggraph-ref-pill-icon" style={{ background: color }}>
        {icon}
      </span>

      {/* Branch name */}
      <span className="ggraph-ref-pill-text">{label.text}</span>

      {/* Remote origin suffix */}
      {label.kind === "remote" && label.remoteName && (
        <>
          <span className="ggraph-ref-pill-divider" />
          <em className="ggraph-ref-pill-remote">{label.remoteName}</em>
        </>
      )}
    </span>
  );
}

// ─── context menu ─────────────────────────────────────────────────────────────

interface CtxMenuItem {
  label:    string;
  danger?:  boolean;
  action:   () => void;
}
type CtxMenuEntry = CtxMenuItem | "divider";

interface ContextMenuProps {
  x:       number;
  y:       number;
  items:   CtxMenuEntry[];
  onClose: () => void;
}

function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    // Slight delay so the same click that opened the menu doesn't close it
    const id = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    return () => { clearTimeout(id); document.removeEventListener("mousedown", handler); };
  }, [onClose]);

  // Clamp to viewport so menu doesn't go off screen
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x, window.innerWidth  - 220),
    top:  Math.min(y, window.innerHeight - 300),
    zIndex: 9999,
  };

  // Render into document.body via portal so position:fixed is always relative
  // to the viewport, regardless of any CSS transforms on ancestor elements.
  return createPortal(
    <div ref={menuRef} className="git-ctx-menu" style={style}>
      {items.map((item, i) =>
        item === "divider"
          ? <div key={i} className="git-ctx-divider" />
          : (
            <button
              key={i}
              className={`git-ctx-item${item.danger ? " git-ctx-item--danger" : ""}`}
              onMouseDown={(e) => { e.stopPropagation(); item.action(); onClose(); }}
            >
              {item.label}
            </button>
          ),
      )}
    </div>,
    document.body,
  );
}

// ─── diff file tree ───────────────────────────────────────────────────────────
// Mirrors the FilesPanel tree approach but adapted for CommitDiffFile[].
// Reuses the .files-tree-* CSS classes from panels-rail.css.

const _FICON = "/file-icons";
const _EXT_ICONS: Record<string, string> = {
  ts: "typescript.svg",  tsx: "react-alt.svg",  js: "javascript.svg",
  mjs: "javascript.svg", cjs: "javascript.svg", jsx: "react.svg",
  css: "css.svg", scss: "sass.svg", sass: "sass.svg", less: "less.svg",
  html: "html.svg", htm: "html.svg", json: "json.svg",
  yml: "yaml.svg", yaml: "yaml.svg", toml: "toml.png", xml: "settings.svg",
  py: "python.svg", rs: "rust.svg", go: "go.svg", rb: "ruby.svg",
  php: "php.svg", java: "java.svg", cs: "csharp.svg", cpp: "cpp.svg",
  cc: "cpp.svg", c: "c.png", h: "c-h.png", hpp: "cpp-h.png",
  swift: "swift.svg", kt: "kotlin.svg", dart: "dart.svg",
  md: "markdown.svg", mdx: "mdx.svg", txt: "notepad.svg", sh: "shell.png",
  sql: "database.svg", graphql: "graphql.svg", prisma: "prisma.svg",
  svg: "svg.svg", png: "image.png", jpg: "image.png", jpeg: "image.png",
};
const _NAME_ICONS: Record<string, string> = {
  "package.json": "npm.svg", "package-lock.json": "npm.svg",
  "dockerfile": "docker.svg", "docker-compose.yml": "docker.svg",
  ".gitignore": "git.svg", ".gitattributes": "git.svg",
  ".eslintrc.js": "eslint.svg", ".eslintrc.json": "eslint.svg",
  "vite.config.ts": "vitejs.svg", "vite.config.js": "vitejs.svg",
  "tailwind.config.ts": "tailwind.svg", "tailwind.config.js": "tailwind.svg",
};
const _FOLDER_ICONS: Record<string, [string, string]> = {
  src: ["src.svg", "src-open.svg"], source: ["src.svg", "src-open.svg"],
  styles: ["styles.svg", "styles-open.svg"], style: ["styles.svg", "styles-open.svg"],
  node_modules: ["node.svg", "node-open.svg"],
  build: ["build.svg", "build-open.svg"], dist: ["build.svg", "build-open.svg"],
  test: ["tests.svg", "tests-open.svg"], tests: ["tests.svg", "tests-open.svg"],
  ".git": ["git.svg", "git-open.svg"], ".github": ["git.svg", "git-open.svg"],
  app: ["app.svg", "app-open.svg"], images: ["images.svg", "images-open.svg"],
};

function _fileIcon(name: string): string {
  const lo = name.toLowerCase();
  if (_NAME_ICONS[lo]) return `${_FICON}/${_NAME_ICONS[lo]}`;
  const ext = lo.split(".").pop() ?? "";
  return _EXT_ICONS[ext] ? `${_FICON}/${_EXT_ICONS[ext]}` : `${_FICON}/file.png`;
}
function _folderIcon(label: string, open: boolean): string {
  const seg = label.split("/")[0]!.toLowerCase();
  const pair = _FOLDER_ICONS[seg];
  if (pair) return `${_FICON}/folders/${open ? pair[1] : pair[0]}`;
  return `${_FICON}/folders/${open ? "default-open.svg" : "default.svg"}`;
}

interface _DirNode  { kind: "dir";  label: string; children: _TreeNode[]; }
interface _FileNode { kind: "file"; name: string;  fullPath: string; added: number; removed: number; }
type _TreeNode = _DirNode | _FileNode;

function _insertEntry(dir: _DirNode, parts: string[], file: CommitDiffFile): void {
  if (parts.length === 1) {
    dir.children.push({ kind: "file", name: parts[0]!, fullPath: file.filename, added: file.added, removed: file.removed });
    return;
  }
  const seg = parts[0]!;
  let child = dir.children.find((c): c is _DirNode => c.kind === "dir" && c.label === seg);
  if (!child) { child = { kind: "dir", label: seg, children: [] }; dir.children.push(child); }
  _insertEntry(child, parts.slice(1), file);
}

function _collapseSingletons(node: _DirNode): _DirNode {
  const kids = node.children.map((c) => c.kind === "dir" ? _collapseSingletons(c) : c);
  if (kids.length === 1 && kids[0]!.kind === "dir") {
    const only = kids[0] as _DirNode;
    return { kind: "dir", label: node.label === "" ? only.label : `${node.label}/${only.label}`, children: only.children };
  }
  return { ...node, children: kids };
}

function _buildDiffTree(files: CommitDiffFile[]): _TreeNode[] {
  const root: _DirNode = { kind: "dir", label: "", children: [] };
  for (const f of files) _insertEntry(root, f.filename.split("/").filter(Boolean), f);
  const sort = (nodes: _TreeNode[]): _TreeNode[] =>
    [...nodes]
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return (a.kind === "dir" ? a.label : a.name).localeCompare(b.kind === "dir" ? b.label : b.name);
      })
      .map((n) => n.kind === "dir" ? { ...n, children: sort(n.children) } : n);
  return sort(_collapseSingletons(root).children);
}

interface _DiffTreeRowProps { selectedFile: string | null; onSelectFile: (f: string) => void; }

function _DiffFileRow({ node, depth, selectedFile, onSelectFile }: _DiffTreeRowProps & { node: _FileNode; depth: number }) {
  const pl = 4 + depth * 16 + 20;
  const active = node.fullPath === selectedFile;
  return (
    <div
      className={`files-tree-file files-tree-file--clickable${active ? " files-tree-file--active" : ""}`}
      style={{ paddingLeft: pl }}
      onClick={() => onSelectFile(node.fullPath)}
      title={node.fullPath}
    >
      <img className="files-tree-icon" src={_fileIcon(node.name)} alt="" draggable={false} />
      <span className="files-tree-name">{node.name}</span>
      <span className="files-stats">
        {node.added   > 0 && <span className="files-stat-added">+{node.added}</span>}
        {node.removed > 0 && <span className="files-stat-removed">-{node.removed}</span>}
      </span>
    </div>
  );
}

function _DiffDirRow({ node, depth, selectedFile, onSelectFile }: _DiffTreeRowProps & { node: _DirNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const pl = 4 + depth * 16;
  return (
    <div className="files-tree-dir-group">
      <div className="files-tree-dir files-tree-dir--clickable" style={{ paddingLeft: pl }} onClick={() => setOpen((v) => !v)}>
        <span className="files-tree-chevron">{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
        <img className="files-tree-icon" src={_folderIcon(node.label, open)} alt="" draggable={false} />
        <span className="files-tree-dir-name">{node.label}</span>
      </div>
      {open && (
        <div className="files-tree-children" style={{ "--indent-guide-left": `${pl + 8}px` } as React.CSSProperties}>
          {node.children.map((child, i) =>
            child.kind === "dir"
              ? <_DiffDirRow  key={i} node={child} depth={depth + 1} selectedFile={selectedFile} onSelectFile={onSelectFile} />
              : <_DiffFileRow key={i} node={child} depth={depth + 1} selectedFile={selectedFile} onSelectFile={onSelectFile} />,
          )}
        </div>
      )}
    </div>
  );
}

// ─── commit diff panel ────────────────────────────────────────────────────────

interface DiffState {
  hash:         string;
  files:        CommitDiffFile[];
  selectedFile: string | null;
  diff:         string | null;
  loadingFiles: boolean;
  loadingDiff:  boolean;
  error:        string | null;
}

function parseDiffLines(raw: string) {
  // Strip the commit header — everything before the first "diff --git" line
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => l.startsWith("diff --git") || l.startsWith("@@"));
  return start === -1 ? lines : lines.slice(start);
}

interface CommitDiffPanelProps {
  diffState: DiffState;
  onSelectFile: (filename: string) => void;
}

function CommitDiffPanel({ diffState, onSelectFile }: CommitDiffPanelProps) {
  const { files, selectedFile, diff, loadingFiles, loadingDiff, error } = diffState;

  const diffLines = useMemo(() => diff ? parseDiffLines(diff) : [], [diff]);
  const tree      = useMemo(() => _buildDiffTree(files), [files]);

  return (
    <div className="ggraph-diff-panel">
      {/* File tree sidebar */}
      <div className="ggraph-diff-files">
        {loadingFiles && <div className="ggraph-diff-loading"><RefreshCw size={11} className="ggraph-spin" /> Loading…</div>}
        {error && <div className="ggraph-diff-error">{error}</div>}
        {!loadingFiles && files.length === 0 && !error && (
          <div className="ggraph-diff-placeholder">No changes in this commit</div>
        )}
        {tree.length > 0 && (
          <div className="files-tree">
            {tree.map((node, i) =>
              node.kind === "dir"
                ? <_DiffDirRow  key={i} node={node} depth={0} selectedFile={selectedFile} onSelectFile={onSelectFile} />
                : <_DiffFileRow key={i} node={node} depth={0} selectedFile={selectedFile} onSelectFile={onSelectFile} />,
            )}
          </div>
        )}
      </div>

      {/* Diff viewer */}
      <div className="ggraph-diff-content">
        {loadingDiff && (
          <div className="ggraph-diff-loading"><RefreshCw size={11} className="ggraph-spin" /> Loading diff…</div>
        )}
        {!loadingDiff && !selectedFile && !loadingFiles && files.length > 0 && (
          <div className="ggraph-diff-placeholder">Select a file to view the diff</div>
        )}
        {!loadingDiff && diff && (
          <pre className="ggraph-diff-pre">
            {diffLines.map((line, i) => {
              let cls = "ggraph-diff-line";
              if (line.startsWith("+++") || line.startsWith("---")) cls += " ggraph-diff-line--meta";
              else if (line.startsWith("+"))  cls += " ggraph-diff-line--add";
              else if (line.startsWith("-"))  cls += " ggraph-diff-line--del";
              else if (line.startsWith("@@")) cls += " ggraph-diff-line--hunk";
              else if (line.startsWith("diff ") || line.startsWith("index ")) cls += " ggraph-diff-line--meta";
              return <div key={i} className={cls}>{line || " "}</div>;
            })}
          </pre>
        )}
      </div>
    </div>
  );
}

// ─── commit row ───────────────────────────────────────────────────────────────

interface CommitRowProps {
  node:          GraphNode;
  isExpanded:    boolean;
  currentBranch: string;
  diffState:     DiffState | null;
  onToggle:      () => void;
  onContextMenu: (e: React.MouseEvent, target: CtxTarget) => void;
  onSelectFile:  (filename: string) => void;
}

type CtxTarget =
  | { type: "commit"; node: GraphNode }
  | { type: "branch"; label: RefLabel; color: string };

function CommitRow({
  node, isExpanded, currentBranch, diffState, onToggle, onContextMenu, onSelectFile,
}: CommitRowProps) {
  const { commit, refLabels } = node;

  const handleRowCtx = (e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu(e, { type: "commit", node });
  };

  const pills = refLabels.filter((r) => r.kind !== "head");

  return (
    <div className={`ggraph-row-wrap${isExpanded ? " ggraph-row-wrap--expanded" : ""}`}>
      {/* Main row */}
      <div
        className={`git-graph-row${isExpanded ? " git-graph-row--selected" : ""}${node.isHead ? " git-graph-row--head" : ""}`}
        style={{ height: ROW_H }}
        onClick={onToggle}
        onContextMenu={handleRowCtx}
      >
        {/* Refs + Subject combined into one flex cell */}
        <span className="ggraph-refs-msg">
          {pills.map((label, i) => (
            <RefPill
              key={i}
              label={label}
              color={node.color}
              isCurrentBranch={label.kind === "local" && label.text === currentBranch}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(e, { type: "branch", label, color: node.color });
              }}
            />
          ))}
          <span className="ggraph-subject" title={commit.subject}>{commit.subject}</span>
        </span>

        {/* Author */}
        <span className="ggraph-author">{commit.authorName}</span>

        {/* Date */}
        <span className="ggraph-date">{relativeDate(commit.authorDate)}</span>
      </div>

      {/* Expanded diff panel */}
      {isExpanded && diffState && (
        <div className="ggraph-diff-wrap" style={{ height: EXPANDED_H }}>
          <CommitDiffPanel diffState={diffState} onSelectFile={onSelectFile} />
        </div>
      )}
    </div>
  );
}

// ─── create-branch modal ──────────────────────────────────────────────────────

interface CreateBranchModalProps {
  hash:     string;
  repoPath: string;
  onDone:   () => void;
  onClose:  () => void;
}

function CreateBranchModal({ hash, repoPath, onDone, onClose }: CreateBranchModalProps) {
  const [name, setName]       = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState<string | null>(null);
  const inputRef              = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleCreate = async () => {
    const n = name.trim();
    if (!n) return;
    setLoading(true); setErr(null);
    try {
      await gitApi.createBranch(repoPath, n, hash);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  };

  return (
    <div className="git-modal-backdrop" onMouseDown={onClose}>
      <div className="git-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="git-modal-title">Create branch from commit</div>
        <div className="git-modal-sub">{hash.slice(0, 12)}</div>
        <input
          ref={inputRef}
          className="git-modal-input"
          type="text"
          placeholder="branch-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); if (e.key === "Escape") onClose(); }}
          disabled={loading}
        />
        {err && <div className="git-modal-error">{err}</div>}
        <div className="git-modal-actions">
          <button className="git-modal-btn git-modal-btn--secondary" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="git-modal-btn git-modal-btn--primary" onClick={() => void handleCreate()} disabled={!name.trim() || loading}>
            {loading ? "Creating…" : "Create Branch"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

interface Props {
  repoPath:   string;
  onClose:    () => void;
  onCheckout: (branch: string) => void;
}

const LIMIT_OPTIONS = [50, 100, 150, 250, 500];

export function GitGraphView({ repoPath, onClose, onCheckout }: Props) {
  const [logResult,   setLogResult]   = useState<GitLogResult | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [diffState,   setDiffState]   = useState<DiffState | null>(null);
  const [limit,       setLimit]       = useState(150);
  const [filter,      setFilter]      = useState("");
  const [treeWidth,   setTreeWidth]   = useState(DEFAULT_TREE_W);
  const [ctxMenu,     setCtxMenu]     = useState<{ x: number; y: number; items: CtxMenuEntry[] } | null>(null);
  const [createBranchHash, setCreateBranchHash] = useState<string | null>(null);
  const [opError,     setOpError]     = useState<string | null>(null);

  const resizingRef    = useRef(false);
  const resizeStartX   = useRef(0);
  const resizeStartW   = useRef(0);
  const scrollRef      = useRef<HTMLDivElement>(null);

  // ── Fetch log ──
  const fetchLog = useCallback(async (lim: number) => {
    setLoading(true); setError(null);
    try {
      setLogResult(await gitApi.getLog(repoPath, lim));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => { void fetchLog(limit); }, [repoPath, fetchLog, limit]);

  // ── Keyboard ──
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (ctxMenu)       { setCtxMenu(null); return; }
        if (createBranchHash) { setCreateBranchHash(null); return; }
        if (expandedHash)  { setExpandedHash(null); return; }
        onClose();
      }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [ctxMenu, createBranchHash, expandedHash, onClose]);

  // ── Graph layout ──
  const nodes = useMemo(() => {
    if (!logResult) return [];
    return buildGraphLayout(logResult.commits, logResult.currentBranch);
  }, [logResult]);

  const visibleNodes = useMemo(() => {
    if (!filter.trim()) return nodes;
    const q = filter.toLowerCase();
    return nodes.filter((n) =>
      n.commit.subject.toLowerCase().includes(q) ||
      n.commit.shortHash.toLowerCase().includes(q) ||
      n.commit.authorName.toLowerCase().includes(q) ||
      n.refLabels.some((r) => r.text.toLowerCase().includes(q)),
    );
  }, [nodes, filter]);

  const maxLane = useMemo(() => {
    let max = 0;
    for (const n of visibleNodes) {
      max = Math.max(max, n.lane);
      for (const e of n.parentEdges)
        for (const s of e.segments)
          max = Math.max(max, s.fromX, s.toX);
    }
    return max;
  }, [visibleNodes]);

  // ── Row y-centres (accounts for expanded rows) ──
  const { rowCenters, svgHeight } = useMemo(() => {
    const centers: number[] = [];
    let acc = 0;
    for (const node of visibleNodes) {
      centers.push(acc + ROW_H / 2);
      acc += ROW_H;
      if (node.commit.hash === expandedHash) acc += EXPANDED_H;
    }
    return { rowCenters: centers, svgHeight: acc };
  }, [visibleNodes, expandedHash]);

  // ── Fetch diff when a commit is expanded ──
  useEffect(() => {
    if (!expandedHash) { setDiffState(null); return; }
    setDiffState({ hash: expandedHash, files: [], selectedFile: null, diff: null, loadingFiles: true, loadingDiff: false, error: null });
    gitApi.getCommitDiff(repoPath, expandedHash)
      .then((files) => {
        setDiffState((prev) => prev?.hash === expandedHash
          ? { ...prev, files, loadingFiles: false, selectedFile: files[0]?.filename ?? null }
          : prev);
        if (files[0]) {
          gitApi.getCommitFileDiff(repoPath, expandedHash, files[0].filename)
            .then((diff) => setDiffState((prev) =>
              prev?.hash === expandedHash ? { ...prev, diff, loadingDiff: false } : prev))
            .catch(() => {});
        }
      })
      .catch((e) => setDiffState((prev) => prev?.hash === expandedHash
        ? { ...prev, loadingFiles: false, error: e instanceof Error ? e.message : String(e) } : prev));
  }, [expandedHash, repoPath]);

  const handleSelectDiffFile = useCallback((filename: string) => {
    if (!expandedHash) return;
    setDiffState((prev) => prev ? { ...prev, selectedFile: filename, diff: null, loadingDiff: true } : prev);
    gitApi.getCommitFileDiff(repoPath, expandedHash, filename)
      .then((diff) => setDiffState((prev) => prev?.selectedFile === filename ? { ...prev, diff, loadingDiff: false } : prev))
      .catch((e) => setDiffState((prev) => prev ? { ...prev, loadingDiff: false, error: e instanceof Error ? e.message : String(e) } : prev));
  }, [expandedHash, repoPath]);

  // ── Resize handle ──
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    resizeStartX.current = e.clientX;
    resizeStartW.current = treeWidth;

    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      setTreeWidth(Math.max(MIN_TREE_W, resizeStartW.current + ev.clientX - resizeStartX.current));
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ── Toggle expand ──
  const handleToggleExpand = (hash: string) => {
    setExpandedHash((prev) => prev === hash ? null : hash);
  };

  // ── Context-menu builder ──
  const currentBranch = logResult?.currentBranch ?? "";

  const openCommitCtx = useCallback((e: React.MouseEvent, node: GraphNode) => {
    const hash = node.commit.hash;
    const localBranch = node.refLabels.find((r) => r.kind === "local")?.text ?? null;

    const items: CtxMenuEntry[] = [
      { label: "Create Branch…", action: () => setCreateBranchHash(hash) },
      ...(localBranch && localBranch !== currentBranch
        ? [{ label: `Checkout "${localBranch}"`, action: () => { onCheckout(localBranch); void fetchLog(limit); } } as CtxMenuItem]
        : localBranch
        ? []
        : [{ label: "Checkout (detached)", action: () => { onCheckout(hash); void fetchLog(limit); } } as CtxMenuItem]),
      "divider",
      {
        label: "Cherry Pick", action: async () => {
          try { await gitApi.cherryPick(repoPath, hash); void fetchLog(limit); }
          catch (err) { setOpError(err instanceof Error ? err.message : String(err)); }
        },
      },
      {
        label: "Revert", action: async () => {
          try { await gitApi.revert(repoPath, hash); void fetchLog(limit); }
          catch (err) { setOpError(err instanceof Error ? err.message : String(err)); }
        },
      },
      "divider",
      {
        label: "Merge into current branch", action: async () => {
          try { await gitApi.merge(repoPath, hash); void fetchLog(limit); }
          catch (err) { setOpError(err instanceof Error ? err.message : String(err)); }
        },
      },
      {
        label: "Rebase current branch onto this commit", action: async () => {
          try { await gitApi.rebase(repoPath, hash); void fetchLog(limit); }
          catch (err) { setOpError(err instanceof Error ? err.message : String(err)); }
        },
      },
      "divider",
      {
        label: "Reset (soft) — keep staged", action: async () => {
          try { await gitApi.reset(repoPath, hash, "soft"); void fetchLog(limit); }
          catch (err) { setOpError(err instanceof Error ? err.message : String(err)); }
        },
      },
      {
        label: "Reset (mixed) — unstage changes", action: async () => {
          try { await gitApi.reset(repoPath, hash, "mixed"); void fetchLog(limit); }
          catch (err) { setOpError(err instanceof Error ? err.message : String(err)); }
        },
      },
      {
        label: "Reset (hard) — discard all changes", danger: true, action: async () => {
          if (!window.confirm("Hard reset will discard all uncommitted changes. Continue?")) return;
          try { await gitApi.reset(repoPath, hash, "hard"); void fetchLog(limit); }
          catch (err) { setOpError(err instanceof Error ? err.message : String(err)); }
        },
      },
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  }, [currentBranch, repoPath, limit, fetchLog, onCheckout]);

  const openBranchCtx = useCallback((e: React.MouseEvent, label: RefLabel) => {
    const items: CtxMenuEntry[] = [
      {
        label: `Checkout "${label.text}"`, action: () => {
          onCheckout(label.text); void fetchLog(limit);
        },
      },
      ...(label.kind === "local" ? [
        "divider" as const,
        {
          label: `Delete local branch "${label.text}"`, danger: true,
          action: async () => {
            if (!window.confirm(`Delete branch "${label.text}"?`)) return;
            try { await gitApi.deleteBranch(repoPath, label.text); void fetchLog(limit); }
            catch (err) { setOpError(err instanceof Error ? err.message : String(err)); }
          },
        } as CtxMenuItem,
      ] : []),
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  }, [repoPath, limit, fetchLog, onCheckout]);

  const handleContextMenu = useCallback((e: React.MouseEvent, target: CtxTarget) => {
    e.preventDefault();
    if (target.type === "commit") openCommitCtx(e, target.node);
    else openBranchCtx(e, target.label);
  }, [openCommitCtx, openBranchCtx]);

  const repoName = repoPath.split("/").filter(Boolean).pop() ?? repoPath;

  return (
    <div className="git-graph-view">
      {/* ── Toolbar ── */}
      <div className="git-graph-toolbar">
        <div className="ggraph-toolbar-title">
          <GitBranch size={13} />
          <span>Git Graph</span>
          <span className="ggraph-repo-name">{repoName}</span>
        </div>
        <div className="ggraph-toolbar-right">
          <input
            className="ggraph-filter-input"
            type="search"
            placeholder="Filter commits…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            className="ggraph-limit-select"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            title="Number of commits to show"
          >
            {LIMIT_OPTIONS.map((l) => <option key={l} value={l}>{l} commits</option>)}
          </select>
          <button
            type="button"
            className={`ggraph-icon-btn${loading ? " ggraph-icon-btn--spinning" : ""}`}
            onClick={() => void fetchLog(limit)}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* ── Op error banner ── */}
      {opError && (
        <div className="ggraph-op-error">
          {opError}
          <button className="ggraph-op-error-close" onClick={() => setOpError(null)}>✕</button>
        </div>
      )}

      {/* ── Column header (fixed above scroll area) ── */}
      <div className="git-graph-col-header">
        {/* Spacer matching tree + resize handle */}
        <div className="git-graph-col-header-tree" style={{ width: treeWidth + RESIZE_W, flexShrink: 0 }} />
        <span className="ggraph-col-subject">Message</span>
        <span className="ggraph-col-author">Author</span>
        <span className="ggraph-col-date">Date</span>
      </div>

      {/* ── Body ── */}
      <div className="git-graph-body">
        {/* Scrollable area */}
        <div className="git-graph-scroll" ref={scrollRef}>
          {/* Tree section */}
          <div
            className="git-graph-tree"
            style={{ width: treeWidth, flexShrink: 0 }}
          >
            {visibleNodes.length > 0 && (
              <GraphSvg
                nodes={visibleNodes}
                maxLane={maxLane}
                rowCenters={rowCenters}
                svgHeight={svgHeight}
                selectedHash={expandedHash}
                onSelect={handleToggleExpand}
              />
            )}
          </div>

          {/* Resize handle */}
          <div
            className="git-graph-resize-handle"
            style={{ width: RESIZE_W }}
            onMouseDown={handleResizeMouseDown}
          />

          {/* Rows */}
          <div className="git-graph-rows">
            {error && <div className="ggraph-error">{error}</div>}
            {loading && visibleNodes.length === 0 && (
              <div className="ggraph-loading"><RefreshCw size={13} className="ggraph-spin" />Loading commit graph…</div>
            )}
            {!loading && visibleNodes.length === 0 && !error && (
              <div className="ggraph-empty"><GitCommitIcon size={24} />No commits found</div>
            )}

            {visibleNodes.map((node) => {
              const isExp = node.commit.hash === expandedHash;
              return (
                <CommitRow
                  key={node.commit.hash}
                  node={node}
                  isExpanded={isExp}
                  currentBranch={currentBranch}
                  diffState={isExp ? diffState : null}
                  onToggle={() => handleToggleExpand(node.commit.hash)}
                  onContextMenu={handleContextMenu}
                  onSelectFile={handleSelectDiffFile}
                />
              );
            })}

            {visibleNodes.length > 0 && (
              <div className="git-graph-footer">
                <GitCommitIcon size={11} />
                {visibleNodes.length} commit{visibleNodes.length !== 1 ? "s" : ""}
                {filter && ` matching "${filter}"`}
                {logResult && logResult.commits.length >= limit && (
                  <span className="ggraph-footer-more"> — showing {limit}. Increase limit to see more.</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Context menu ── */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* ── Create branch modal ── */}
      {createBranchHash && (
        <CreateBranchModal
          hash={createBranchHash}
          repoPath={repoPath}
          onDone={() => { setCreateBranchHash(null); void fetchLog(limit); }}
          onClose={() => setCreateBranchHash(null)}
        />
      )}
    </div>
  );
}
