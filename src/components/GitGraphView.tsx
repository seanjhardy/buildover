import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  RefreshCw,
  GitBranch,
  Copy,
  Check,
  X,
  GitCommit as GitCommitIcon,
  Tag,
  Plus,
} from "lucide-react";
import { gitApi, type GitCommit, type GitLogResult } from "../lib/api.js";

// ─── constants ────────────────────────────────────────────────────────────────

const ROW_H = 34;          // px height per commit row
const LANE_W = 16;         // px between lane centres
const DOT_R = 4;           // normal commit dot radius
const HEAD_R = 5;          // HEAD commit dot radius
const LANE_OFFSET = 12;    // left padding before first lane centre

// VS Code Git Graph–inspired palette — first colour (index 0) is always the
// main / HEAD branch colour so it stands out.
const LANE_COLOURS = [
  "#d97757", // orange  (HEAD / main)
  "#5b9bd5", // blue
  "#73c48f", // green
  "#c792ea", // purple
  "#f7c948", // yellow
  "#56b6c2", // cyan
  "#e06c75", // red
  "#d19a66", // tan
];

function laneColor(index: number): string {
  return LANE_COLOURS[index % LANE_COLOURS.length] ?? LANE_COLOURS[0]!;
}

// ─── graph layout ─────────────────────────────────────────────────────────────

export interface GraphNode {
  commit: GitCommit;
  row: number;
  lane: number;         // x lane index
  color: string;
  parentEdges: ParentEdge[];
  refLabels: RefLabel[];
  isHead: boolean;
}

interface ParentEdge {
  toLane: number;       // lane of the parent node
  toRow: number;        // row of the parent node
  color: string;        // colour of this edge line
  isMerge: boolean;     // true when this commit has >1 parent
}

export interface RefLabel {
  text: string;
  kind: "head" | "local" | "remote" | "tag";
}

/**
 * Parse the `git log --decorate=full` decoration string into typed ref labels.
 * Input example: "HEAD -> main, refs/remotes/origin/main, refs/tags/v1.0.0"
 */
function parseRefs(refs: string): RefLabel[] {
  if (!refs.trim()) return [];
  return refs
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .flatMap<RefLabel>((r) => {
      if (r.startsWith("HEAD -> ")) {
        const branch = r.slice("HEAD -> ".length);
        return [
          { text: "HEAD", kind: "head" as const },
          { text: branch, kind: "local" as const },
        ];
      }
      if (r === "HEAD") return [{ text: "HEAD", kind: "head" as const }];
      if (r.startsWith("refs/remotes/")) return [{ text: r.slice("refs/remotes/".length), kind: "remote" as const }];
      if (r.startsWith("refs/heads/"))  return [{ text: r.slice("refs/heads/".length),  kind: "local" as const }];
      if (r.startsWith("refs/tags/"))   return [{ text: r.slice("refs/tags/".length),   kind: "tag" as const }];
      // short-form fallback (git sometimes skips refs/ prefix)
      if (r.startsWith("tag: "))        return [{ text: r.slice("tag: ".length), kind: "tag" as const }];
      return [{ text: r, kind: "local" as const }];
    });
}

/**
 * Core DAG lane-assignment algorithm.
 *
 * Walk commits top-to-bottom (newest first, as returned by git log --all).
 * Maintain an array `lanes` where each slot holds the commit hash it is
 * "tracking towards" (i.e. the next commit in that branch line that hasn't
 * been placed yet).
 *
 * For each commit:
 *   1. Find or claim the lane that is tracking this commit's hash.
 *   2. Assign each parent to a lane (reuse if possible, otherwise fork).
 *   3. Emit edges from this node to each parent's lane/row.
 *   4. Free any lanes that are no longer needed after merges.
 */
export function buildGraphLayout(commits: GitCommit[], currentBranch: string): GraphNode[] {
  if (commits.length === 0) return [];

  // Map hash → row index for quick parent-row lookup
  const rowByHash = new Map<string, number>();
  commits.forEach((c, i) => rowByHash.set(c.hash, i));

  // lanes[i] = hash of the commit we expect next in lane i (undefined = free slot)
  const lanes: (string | undefined)[] = [];

  // lane index assigned to each hash that has already been placed
  const laneByHash = new Map<string, number>();

  function findFreeLane(): number {
    const i = lanes.indexOf(undefined);
    return i === -1 ? lanes.length : i;
  }

  // Determine which lane index is "main" so we can give it colour index 0
  let mainLane = -1; // assigned on first commit that touches main/HEAD

  const nodes: GraphNode[] = [];

  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row]!;

    // Find this commit's lane
    let myLane = lanes.indexOf(commit.hash);
    if (myLane === -1) {
      // No existing lane is tracking this commit — it's a branch head: claim a free slot
      myLane = findFreeLane();
      lanes[myLane] = commit.hash;
    }
    laneByHash.set(commit.hash, myLane);

    // Detect HEAD lane to pin colour index 0
    const isHead = parseRefs(commit.refs).some(
      (r) => r.kind === "head" || (r.kind === "local" && r.text === currentBranch),
    );
    if (isHead && mainLane === -1) mainLane = myLane;

    // Assign parents to lanes
    const parentEdges: ParentEdge[] = [];
    const { parents } = commit;

    if (parents.length === 0) {
      // Root commit — free the lane
      lanes[myLane] = undefined;
    } else {
      // First parent: inherit this commit's lane (keeps the main branch straight)
      const firstParent = parents[0]!;
      lanes[myLane] = firstParent;

      for (let pi = 0; pi < parents.length; pi++) {
        const pHash = parents[pi]!;
        const pRow = rowByHash.get(pHash) ?? (row + 1); // fallback if parent not in window

        let pLane: number;
        if (pi === 0) {
          // First parent inherits this lane
          pLane = myLane;
        } else {
          // Merge parent — check if another lane is already tracking it
          const existing = lanes.indexOf(pHash);
          if (existing !== -1) {
            pLane = existing;
          } else {
            // Fork: open a new lane for this parent
            pLane = findFreeLane();
            lanes[pLane] = pHash;
          }
        }

        parentEdges.push({
          toLane: pLane,
          toRow: pRow,
          color: laneColor(pi === 0 ? myLane : pLane),
          isMerge: parents.length > 1,
        });
      }

      // After a merge commit, free any lanes pointing to parents that now
      // share a lane (avoid duplicate tracking)
      for (let i = 0; i < lanes.length; i++) {
        if (i !== myLane && parents.includes(lanes[i] ?? "")) {
          // Another lane is also tracking one of our parents — that's fine,
          // it will converge naturally.  Don't free it; let it merge.
        }
      }
    }

    // Colour: index 0 for HEAD branch, otherwise based on lane index
    const colorIndex = myLane === mainLane ? 0 : myLane >= 1 ? myLane : 0;

    nodes.push({
      commit,
      row,
      lane: myLane,
      color: laneColor(colorIndex),
      parentEdges,
      refLabels: parseRefs(commit.refs),
      isHead,
    });
  }

  return nodes;
}

// ─── relative date ─────────────────────────────────────────────────────────────

function relativeDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60)  return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  if (s < 31536000) return `${Math.floor(s / 2592000)}mo ago`;
  return `${Math.floor(s / 31536000)}y ago`;
}

// ─── SVG graph strip ───────────────────────────────────────────────────────────

interface GraphSvgProps {
  nodes: GraphNode[];
  maxLane: number;
  selectedHash: string | null;
  onSelect: (hash: string) => void;
}

function GraphSvg({ nodes, maxLane, selectedHash, onSelect }: GraphSvgProps) {
  const svgWidth = LANE_OFFSET + (maxLane + 1) * LANE_W + 8;
  const svgHeight = nodes.length * ROW_H;

  // Build SVG path data for each edge: straight vertical or bezier curve
  function edgePath(fromLane: number, fromRow: number, toLane: number, toRow: number): string {
    const x1 = LANE_OFFSET + fromLane * LANE_W;
    const y1 = fromRow * ROW_H + ROW_H / 2;
    const x2 = LANE_OFFSET + toLane * LANE_W;
    const y2 = toRow * ROW_H + ROW_H / 2;

    if (fromLane === toLane) {
      // Same lane — draw a straight vertical line
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    // Different lanes — cubic bezier that curves smoothly
    const cx = x1;
    const cy = y1 + ROW_H * 0.7;
    const dx = x2;
    const dy = y2 - ROW_H * 0.7;
    return `M ${x1} ${y1} C ${cx} ${cy}, ${dx} ${dy}, ${x2} ${y2}`;
  }

  return (
    <svg
      className="git-graph-svg"
      width={svgWidth}
      height={svgHeight}
      style={{ display: "block", flexShrink: 0 }}
    >
      {/* Edges (drawn first so dots sit on top) */}
      {nodes.map((node) =>
        node.parentEdges.map((edge, ei) => (
          <path
            key={`${node.commit.hash}-e${ei}`}
            d={edgePath(node.lane, node.row, edge.toLane, edge.toRow)}
            stroke={edge.color}
            strokeWidth={1.5}
            fill="none"
            opacity={0.75}
          />
        )),
      )}

      {/* Commit dots */}
      {nodes.map((node) => {
        const cx = LANE_OFFSET + node.lane * LANE_W;
        const cy = node.row * ROW_H + ROW_H / 2;
        const r = node.isHead ? HEAD_R : DOT_R;
        const isSelected = node.commit.hash === selectedHash;

        return (
          <g
            key={node.commit.hash}
            style={{ cursor: "pointer" }}
            onClick={() => onSelect(node.commit.hash)}
          >
            {/* Selection / hover ring */}
            {isSelected && (
              <circle cx={cx} cy={cy} r={r + 4} fill={node.color} opacity={0.18} />
            )}
            {/* Glow for HEAD */}
            {node.isHead && (
              <circle cx={cx} cy={cy} r={r + 3} fill={node.color} opacity={0.22} />
            )}
            {/* Main dot */}
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill={node.color}
              stroke="var(--app-primary-background)"
              strokeWidth={1.5}
            />
          </g>
        );
      })}
    </svg>
  );
}

// ─── commit row (info columns) ────────────────────────────────────────────────

interface CommitRowProps {
  node: GraphNode;
  isSelected: boolean;
  onClick: () => void;
}

function CommitRow({ node, isSelected, onClick }: CommitRowProps) {
  const { commit, refLabels } = node;
  return (
    <div
      className={`git-graph-row${isSelected ? " git-graph-row--selected" : ""}${node.isHead ? " git-graph-row--head" : ""}`}
      onClick={onClick}
      style={{ height: ROW_H }}
    >
      <span className="ggraph-hash">{commit.shortHash}</span>

      {refLabels.map((label, i) => (
        <span
          key={i}
          className={`ggraph-badge ggraph-badge--${label.kind}`}
          title={label.text}
        >
          {label.kind === "tag" ? <Tag size={9} /> : <GitBranch size={9} />}
          {label.text}
        </span>
      ))}

      <span className="ggraph-subject" title={commit.subject}>
        {commit.subject}
      </span>

      <span className="ggraph-author">{commit.authorName}</span>
      <span className="ggraph-date">{relativeDate(commit.authorDate)}</span>
    </div>
  );
}

// ─── detail panel ─────────────────────────────────────────────────────────────

interface DetailPanelProps {
  node: GraphNode;
  repoPath: string;
  currentBranch: string;
  onClose: () => void;
  onCheckout: (ref: string) => void;
  onBranchCreated: () => void;
}

function DetailPanel({ node, repoPath, currentBranch, onClose, onCheckout, onBranchCreated }: DetailPanelProps) {
  const { commit, refLabels } = node;
  const [copied, setCopied] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [branchError, setBranchError] = useState<string | null>(null);
  const [branchLoading, setBranchLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  const copyHash = () => {
    void navigator.clipboard.writeText(commit.hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const localBranch = refLabels.find((r) => r.kind === "local")?.text ?? null;
  const canCheckout = localBranch && localBranch !== currentBranch;

  const handleCheckout = async () => {
    const target = localBranch ?? commit.hash;
    setCheckoutLoading(true);
    onCheckout(target);
    // parent will refresh; close is handled by parent
    setCheckoutLoading(false);
  };

  const handleCreateBranch = async () => {
    const name = newBranch.trim();
    if (!name) return;
    setBranchLoading(true);
    setBranchError(null);
    try {
      await gitApi.createBranch(repoPath, name, commit.hash);
      setNewBranch("");
      onBranchCreated();
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : String(err));
    } finally {
      setBranchLoading(false);
    }
  };

  const dateStr = (() => {
    const d = new Date(commit.authorDate);
    return isNaN(d.getTime()) ? commit.authorDate : d.toLocaleString();
  })();

  return (
    <div className="git-graph-detail">
      <div className="ggraph-detail-header">
        <span className="ggraph-detail-title">Commit details</span>
        <button type="button" className="ggraph-icon-btn" onClick={onClose} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="ggraph-detail-body">
        {/* Hash */}
        <div className="ggraph-detail-section">
          <div className="ggraph-detail-label">Hash</div>
          <div className="ggraph-detail-hash-row">
            <code className="ggraph-detail-hash">{commit.hash}</code>
            <button type="button" className="ggraph-icon-btn" onClick={copyHash} title="Copy">
              {copied ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </div>
        </div>

        {/* Subject / message */}
        <div className="ggraph-detail-section">
          <div className="ggraph-detail-label">Message</div>
          <div className="ggraph-detail-message">{commit.subject}</div>
        </div>

        {/* Author + date */}
        <div className="ggraph-detail-section ggraph-detail-meta">
          <div>
            <div className="ggraph-detail-label">Author</div>
            <div className="ggraph-detail-value">{commit.authorName}</div>
          </div>
          <div>
            <div className="ggraph-detail-label">Date</div>
            <div className="ggraph-detail-value">{dateStr}</div>
          </div>
        </div>

        {/* Refs */}
        {refLabels.length > 0 && (
          <div className="ggraph-detail-section">
            <div className="ggraph-detail-label">Refs</div>
            <div className="ggraph-detail-refs">
              {refLabels.map((r, i) => (
                <span key={i} className={`ggraph-badge ggraph-badge--${r.kind}`}>
                  {r.kind === "tag" ? <Tag size={9} /> : <GitBranch size={9} />}
                  {r.text}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Parents */}
        {commit.parents.length > 0 && (
          <div className="ggraph-detail-section">
            <div className="ggraph-detail-label">Parent{commit.parents.length > 1 ? "s" : ""}</div>
            {commit.parents.map((p) => (
              <code key={p} className="ggraph-detail-parent">{p.slice(0, 12)}</code>
            ))}
          </div>
        )}

        {/* Checkout button */}
        {canCheckout && (
          <div className="ggraph-detail-section">
            <button
              type="button"
              className="ggraph-action-btn ggraph-action-primary"
              onClick={() => void handleCheckout()}
              disabled={checkoutLoading}
            >
              <GitBranch size={11} />
              {checkoutLoading ? "Switching…" : `Switch to ${localBranch}`}
            </button>
          </div>
        )}

        {/* Create branch here */}
        <div className="ggraph-detail-section">
          <div className="ggraph-detail-label">Create branch here</div>
          <div className="ggraph-detail-branch-form">
            <input
              className="ggraph-branch-input"
              type="text"
              placeholder="new-branch-name"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreateBranch(); }}
              disabled={branchLoading}
            />
            <button
              type="button"
              className="ggraph-action-btn ggraph-action-primary"
              onClick={() => void handleCreateBranch()}
              disabled={!newBranch.trim() || branchLoading}
            >
              <Plus size={11} />
              {branchLoading ? "Creating…" : "Create"}
            </button>
          </div>
          {branchError && (
            <div className="ggraph-detail-error">{branchError}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── main GitGraphView component ───────────────────────────────────────────────

interface Props {
  repoPath: string;
  onClose: () => void;
  onCheckout: (branch: string) => void;
}

const LIMIT_OPTIONS = [50, 100, 150, 250, 500];

export function GitGraphView({ repoPath, onClose, onCheckout }: Props) {
  const [logResult, setLogResult] = useState<GitLogResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [limit, setLimit] = useState(150);
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchLog = useCallback(async (lim: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await gitApi.getLog(repoPath, lim);
      setLogResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  // Initial load and when repo changes
  useEffect(() => {
    void fetchLog(limit);
  }, [repoPath, fetchLog, limit]);

  // Keyboard: Escape closes detail panel (not the whole view)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedHash) setSelectedHash(null);
        else onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectedHash, onClose]);

  // Build graph layout from commits
  const nodes = useMemo(() => {
    if (!logResult) return [];
    return buildGraphLayout(logResult.commits, logResult.currentBranch);
  }, [logResult]);

  // Filter nodes by branch/subject text
  const visibleNodes = useMemo(() => {
    if (!filter.trim()) return nodes;
    const q = filter.toLowerCase();
    return nodes.filter(
      (n) =>
        n.commit.subject.toLowerCase().includes(q) ||
        n.commit.shortHash.toLowerCase().includes(q) ||
        n.commit.authorName.toLowerCase().includes(q) ||
        n.refLabels.some((r) => r.text.toLowerCase().includes(q)),
    );
  }, [nodes, filter]);

  const maxLane = useMemo(
    () => visibleNodes.reduce((m, n) => Math.max(m, n.lane), 0),
    [visibleNodes],
  );

  const svgWidth = LANE_OFFSET + (maxLane + 1) * LANE_W + 8;

  const selectedNode = selectedHash
    ? (visibleNodes.find((n) => n.commit.hash === selectedHash) ?? null)
    : null;

  const handleSelectCommit = (hash: string) => {
    setSelectedHash((prev) => (prev === hash ? null : hash));
  };

  const handleCheckout = (ref: string) => {
    onCheckout(ref);
    setSelectedHash(null);
  };

  const handleBranchCreated = () => {
    void fetchLog(limit);
    setSelectedHash(null);
  };

  const repoName = repoPath.split("/").filter(Boolean).pop() ?? repoPath;

  return (
    <div className="git-graph-view">
      {/* ── Toolbar ── */}
      <div className="git-graph-toolbar">
        <button type="button" className="ggraph-back-btn" onClick={onClose}>
          <ArrowLeft size={13} />
          Chat
        </button>

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
            onChange={(e) => {
              const val = Number(e.target.value);
              setLimit(val);
            }}
            title="Number of commits to show"
          >
            {LIMIT_OPTIONS.map((l) => (
              <option key={l} value={l}>{l} commits</option>
            ))}
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

      {/* ── Body ── */}
      <div className="git-graph-body">
        {/* Graph + rows area */}
        <div className="git-graph-main" ref={scrollRef}>
          {error && (
            <div className="ggraph-error">{error}</div>
          )}
          {loading && visibleNodes.length === 0 && (
            <div className="ggraph-loading">
              <RefreshCw size={13} className="ggraph-spin" />
              Loading commit graph…
            </div>
          )}
          {!loading && visibleNodes.length === 0 && !error && (
            <div className="ggraph-empty">
              <GitCommitIcon size={24} />
              No commits found
            </div>
          )}

          {visibleNodes.length > 0 && (
            <div className="git-graph-canvas">
              {/* SVG lane graph — fixed width, full height */}
              <GraphSvg
                nodes={visibleNodes}
                maxLane={maxLane}
                selectedHash={selectedHash}
                onSelect={handleSelectCommit}
              />

              {/* Commit info rows — aligned row-for-row with the SVG */}
              <div
                className="git-graph-rows"
                style={{ marginLeft: svgWidth }}
              >
                {/* Column headers */}
                <div className="git-graph-cols-header">
                  <span className="ggraph-col-hash">Hash</span>
                  <span className="ggraph-col-refs">Refs</span>
                  <span className="ggraph-col-subject">Message</span>
                  <span className="ggraph-col-author">Author</span>
                  <span className="ggraph-col-date">Date</span>
                </div>
                {visibleNodes.map((node) => (
                  <CommitRow
                    key={node.commit.hash}
                    node={node}
                    isSelected={node.commit.hash === selectedHash}
                    onClick={() => handleSelectCommit(node.commit.hash)}
                  />
                ))}

                {/* Footer count */}
                <div className="git-graph-footer">
                  <GitCommitIcon size={11} />
                  {visibleNodes.length} commit{visibleNodes.length !== 1 ? "s" : ""}
                  {filter && ` matching "${filter}"`}
                  {logResult && logResult.commits.length >= limit && (
                    <span className="ggraph-footer-more">
                      {" "}— showing {limit}. Increase limit to see more.
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Detail panel (slides in when a commit is selected) */}
        {selectedNode && (
          <DetailPanel
            node={selectedNode}
            repoPath={repoPath}
            currentBranch={logResult?.currentBranch ?? ""}
            onClose={() => setSelectedHash(null)}
            onCheckout={handleCheckout}
            onBranchCreated={handleBranchCreated}
          />
        )}
      </div>
    </div>
  );
}
