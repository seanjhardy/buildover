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

/**
 * A single drawable segment of a branch path.
 * Vertical when fromX === toX (straight line), diagonal otherwise (bezier).
 * Rows are ABSOLUTE indices into the full commits array; the renderer remaps
 * them to visible indices after filtering.
 */
interface EdgeSegment {
  fromRow: number;
  fromX:   number;
  toRow:   number;
  toX:     number;
}

/**
 * A routed edge from a commit to one of its parents, described as an ordered
 * list of EdgeSegment values. Using segments instead of a single bezier means
 * lines never visually pass through unrelated commit dots.
 */
interface ParentEdge {
  segments:   EdgeSegment[];
  color:      string;
  isMerge:    boolean;
  parentHash: string;   // for filter-window remapping
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
 * Improved DAG lane-assignment algorithm inspired by the VS Code git-graph
 * extension's per-row slot-claiming approach.
 *
 * Key improvements over the previous algorithm:
 *   1. Per-row column tracking (rowOccupied / rowNextX) — each row knows which
 *      x-columns are in use, enabling proper branch compression.
 *   2. routeEdge() traces EVERY row between a commit and its parent, inserting
 *      intermediate waypoints (EdgeSegments) so lines never visually cross
 *      through unrelated commit dots.
 *   3. Color recycling — colors are freed when their branch ends, not tied to a
 *      lane index permanently.
 *   4. Merged-in lanes are freed eagerly after a merge commit.
 */
export function buildGraphLayout(commits: GitCommit[], currentBranch: string): GraphNode[] {
  if (commits.length === 0) return [];

  const N = commits.length;

  // Pass 0: hash → absolute row index
  const rowByHash = new Map<string, number>();
  commits.forEach((c, i) => rowByHash.set(c.hash, i));

  // ── Per-row slot tracking ────────────────────────────────────────────────
  // rowOccupied[r] = set of x-columns claimed at row r
  // rowNextX[r]    = the next free x-column at row r
  const rowOccupied: (Set<number> | undefined)[] = new Array(N);
  const rowNextX:    (number | undefined)[]       = new Array(N);

  function claimXAt(row: number, x: number): void {
    if (row < 0 || row >= N) return;
    let s = rowOccupied[row];
    if (!s) { s = new Set(); rowOccupied[row] = s; }
    s.add(x);
    const cur = rowNextX[row] ?? 0;
    if (x >= cur) rowNextX[row] = x + 1;
  }

  function isXFreeInRange(x: number, r0: number, r1: number): boolean {
    for (let r = r0; r <= r1; r++) {
      if (rowOccupied[r]?.has(x)) return false;
    }
    return true;
  }

  /** Find the highest rowNextX across [r0,r1], claim that x at every row, return it. */
  function allocateFreshX(r0: number, r1: number): number {
    let max = 0;
    for (let r = r0; r <= r1; r++) max = Math.max(max, rowNextX[r] ?? 0);
    for (let r = r0; r <= r1; r++) claimXAt(r, max);
    return max;
  }

  // ── Color recycling ──────────────────────────────────────────────────────
  // availableColors[i] = last absolute row at which color i is "in use".
  // A color is free for a branch starting at `startRow` when:
  //   (availableColors[i] ?? -1) < startRow
  const availableColors: number[] = [];

  function getAvailableColor(startRow: number, preferIndex?: number): number {
    if (preferIndex !== undefined && (availableColors[preferIndex] ?? -1) < startRow) {
      return preferIndex;
    }
    for (let i = 0; i < availableColors.length; i++) {
      if (i === preferIndex) continue;
      if ((availableColors[i] ?? -1) < startRow) return i;
    }
    availableColors.push(-1);
    return availableColors.length - 1;
  }

  function extendColor(ci: number, toRow: number): void {
    if ((availableColors[ci] ?? -1) < toRow) availableColors[ci] = toRow;
  }

  // ── Lane tracking ────────────────────────────────────────────────────────
  // lanes[i]        = hash the lane is currently tracking toward (undefined = free)
  // laneColorIdx[i] = color palette index assigned to lane i
  const lanes:        (string | undefined)[] = [];
  const laneColorIdx: (number | undefined)[] = [];

  function findFreeLane(): number {
    const i = lanes.indexOf(undefined);
    return i === -1 ? lanes.length : i;
  }

  // ── Edge routing ─────────────────────────────────────────────────────────
  /**
   * Produce a list of EdgeSegments routing from (startRow, startX) to
   * (endRow, endX), claiming intermediate x-slots at each row passed through.
   *
   * - Straight (startX === endX): one vertical segment, claim intermediate rows.
   * - Adjacent rows: one diagonal segment (no intermediate rows to claim).
   * - Multi-row diagonal: pick a "travel column" tX for intermediate rows.
   *     Prefer endX (bend at top), then startX (bend at bottom), else fresh column.
   *   Emit two segments: the diagonal transition + the vertical run.
   */
  function routeEdge(
    startRow: number, startX: number,
    endRow:   number, endX:   number,
  ): EdgeSegment[] {
    if (endRow <= startRow) return [];

    // ── Straight vertical ──
    if (startX === endX) {
      for (let r = startRow + 1; r < endRow; r++) claimXAt(r, startX);
      return [{ fromRow: startRow, fromX: startX, toRow: endRow, toX: endX }];
    }

    // ── Adjacent rows: single diagonal, nothing to claim ──
    const r0 = startRow + 1;
    const r1 = endRow - 1;
    if (r0 > r1) {
      return [{ fromRow: startRow, fromX: startX, toRow: endRow, toX: endX }];
    }

    // ── Multi-row diagonal: pick travel column ──
    let tX: number;
    let usedFreshAlloc = false;
    if (isXFreeInRange(endX, r0, r1)) {
      tX = endX;     // bend at the top, travel straight at endX
    } else if (isXFreeInRange(startX, r0, r1)) {
      tX = startX;   // travel at startX ("locked-first"), bend near the bottom
    } else {
      tX = allocateFreshX(r0, r1);
      usedFreshAlloc = true;
    }

    // Claim tX at all intermediate rows (allocateFreshX already did so if used)
    if (!usedFreshAlloc) {
      for (let r = r0; r <= r1; r++) claimXAt(r, tX);
    }

    if (tX === startX) {
      // Travel at startX, bend near the parent commit ("locked-first" style)
      return [
        { fromRow: startRow,   fromX: startX, toRow: endRow - 1, toX: tX },
        { fromRow: endRow - 1, fromX: tX,     toRow: endRow,     toX: endX },
      ];
    } else {
      // Bend near the child commit, travel straight at tX (= endX or fresh col)
      return [
        { fromRow: startRow,     fromX: startX, toRow: startRow + 1, toX: tX },
        { fromRow: startRow + 1, fromX: tX,     toRow: endRow,       toX: endX },
      ];
    }
  }

  // ── Main loop ────────────────────────────────────────────────────────────
  let headLane = -1;   // lane index of the HEAD/main branch (gets color 0)
  const nodes: GraphNode[] = [];

  for (let row = 0; row < N; row++) {
    const commit = commits[row]!;

    // ── Step A: find or claim a lane for this commit ──
    let myLane = lanes.indexOf(commit.hash);
    if (myLane === -1) {
      myLane = findFreeLane();
      lanes[myLane] = commit.hash;
    }

    // ── Step B: claim the x-slot for the commit dot itself ──
    claimXAt(row, myLane);

    // ── Step C: free duplicate lane entries (another lane also tracking this hash) ──
    for (let i = 0; i < lanes.length; i++) {
      if (i !== myLane && lanes[i] === commit.hash) {
        lanes[i] = undefined;
      }
    }

    // ── Step D: detect HEAD, assign / inherit color index ──
    const refsParsed = parseRefs(commit.refs);
    const isHead = refsParsed.some(
      (r) => r.kind === "head" || (r.kind === "local" && r.text === currentBranch),
    );

    if (isHead && headLane === -1) headLane = myLane;

    if (laneColorIdx[myLane] === undefined) {
      // New lane: assign a recycled color.
      // HEAD/main lane tries to claim color index 0 first.
      const ci = (isHead || myLane === headLane)
        ? getAvailableColor(row, 0)
        : getAvailableColor(row);
      laneColorIdx[myLane] = ci;
    }

    const myColorIdx = laneColorIdx[myLane]!;

    // ── Step E: process parents ──
    const parentEdges: ParentEdge[] = [];
    const { parents } = commit;

    if (parents.length === 0) {
      // Root commit — branch ends here; free color and lane
      extendColor(myColorIdx, row);
      lanes[myLane] = undefined;
      laneColorIdx[myLane] = undefined;
    } else {
      // First parent inherits this lane (keeps the main path straight)
      lanes[myLane] = parents[0]!;

      for (let pi = 0; pi < parents.length; pi++) {
        const pHash = parents[pi]!;
        const pRow  = rowByHash.get(pHash) ?? (row + 1); // fallback if parent outside window

        let pLane: number;
        let pColorIdx: number;

        if (pi === 0) {
          // First parent continues on this lane
          pLane     = myLane;
          pColorIdx = myColorIdx;
        } else {
          // Merge parent: reuse existing lane if one already tracks this hash
          const existing = lanes.indexOf(pHash);
          if (existing !== -1) {
            pLane     = existing;
            pColorIdx = laneColorIdx[existing] ?? getAvailableColor(row);
            if (laneColorIdx[existing] === undefined) laneColorIdx[existing] = pColorIdx;
          } else {
            // Open a new lane for this merge parent
            pLane = findFreeLane();
            lanes[pLane] = pHash;
            pColorIdx = getAvailableColor(row);
            laneColorIdx[pLane] = pColorIdx;
          }
        }

        // Keep color alive through the full span of this edge
        extendColor(pColorIdx, pRow);

        const segments = routeEdge(row, myLane, pRow, pLane);

        parentEdges.push({
          segments,
          color:      laneColor(pColorIdx),
          isMerge:    parents.length > 1,
          parentHash: pHash,
        });
      }

      // ── Step F: eagerly free lanes made redundant by merge convergence ──
      // Any lane (other than myLane and the explicitly assigned parent lanes)
      // that is tracking one of our parents is now redundant.
      const retainedLanes = new Set<number>([myLane]);
      for (let pi = 1; pi < parents.length; pi++) {
        const idx = lanes.indexOf(parents[pi]!);
        if (idx !== -1) retainedLanes.add(idx);
      }
      for (let i = 0; i < lanes.length; i++) {
        if (!retainedLanes.has(i) && parents.includes(lanes[i] ?? "")) {
          lanes[i] = undefined;
          // laneColorIdx[i] is retained via extendColor — it will be recycled
          // naturally once availableColors[ci] < next startRow that needs it.
        }
      }
    }

    nodes.push({
      commit,
      row,
      lane:      myLane,
      color:     laneColor(myColorIdx),
      parentEdges,
      refLabels: refsParsed,
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

/**
 * Convert one EdgeSegment into an SVG path string.
 *
 * @param seg     Segment with absolute row indices and x-columns.
 * @param fromVis Visible (filtered) row index for seg.fromRow.
 * @param toVis   Visible (filtered) row index for seg.toRow.
 */
function segmentPath(seg: EdgeSegment, fromVis: number, toVis: number): string {
  const x1 = LANE_OFFSET + seg.fromX * LANE_W;
  const y1 = fromVis * ROW_H + ROW_H / 2;
  const x2 = LANE_OFFSET + seg.toX   * LANE_W;
  const y2 = toVis   * ROW_H + ROW_H / 2;

  if (x1 === x2) {
    // Vertical segment — straight line
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }

  // Diagonal transition — cubic bezier.
  // Control points at (x1, y1+d) and (x2, y2-d) produce the canonical
  // "branch opening" curve that hugs the start column and sweeps into the
  // end column near the bottom.
  const span = Math.abs(y2 - y1);
  const d    = Math.min(span * 0.8, ROW_H * 0.8);
  return `M ${x1} ${y1} C ${x1} ${y1 + d}, ${x2} ${y2 - d}, ${x2} ${y2}`;
}

function GraphSvg({ nodes, maxLane, selectedHash, onSelect }: GraphSvgProps) {
  const svgWidth  = LANE_OFFSET + (maxLane + 1) * LANE_W + 8;
  const svgHeight = nodes.length * ROW_H;

  // Map absolute row index → visible index in the (potentially filtered) list.
  // Keyed by node.row (absolute), not by hash, because segments store rows.
  const visIdxByAbsRow = new Map<number, number>();
  nodes.forEach((n, vi) => visIdxByAbsRow.set(n.row, vi));

  return (
    <svg
      className="git-graph-svg"
      width={svgWidth}
      height={svgHeight}
      style={{ display: "block", flexShrink: 0 }}
    >
      {/* Edges (drawn first so dots sit on top) */}
      {nodes.map((node) =>
        node.parentEdges.map((edge, ei) =>
          edge.segments.map((seg, si) => {
            // Both endpoints must be in the visible window.
            const fromVis = visIdxByAbsRow.get(seg.fromRow);
            const toVis   = visIdxByAbsRow.get(seg.toRow);

            // If FROM is outside the visible set, skip entirely.
            if (fromVis === undefined) return null;

            // If TO is outside (parent not in visible window), clip to a
            // virtual row just below the last visible row so the edge exits
            // gracefully at the bottom of the SVG.
            const clippedToVis = toVis ?? nodes.length;

            return (
              <path
                key={`${node.commit.hash}-e${ei}-s${si}`}
                d={segmentPath(seg, fromVis, clippedToVis)}
                stroke={edge.color}
                strokeWidth={1.5}
                fill="none"
                opacity={0.75}
              />
            );
          }),
        ),
      )}

      {/* Commit dots */}
      {nodes.map((node, visIdx) => {
        const cx = LANE_OFFSET + node.lane * LANE_W;
        const cy = visIdx * ROW_H + ROW_H / 2;
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

  // maxLane must account for segment x-columns, not just commit dot lanes,
  // since routeEdge may allocate travel columns wider than any commit lane.
  const maxLane = useMemo(() => {
    let max = 0;
    for (const n of visibleNodes) {
      max = Math.max(max, n.lane);
      for (const edge of n.parentEdges) {
        for (const seg of edge.segments) {
          max = Math.max(max, seg.fromX, seg.toX);
        }
      }
    }
    return max;
  }, [visibleNodes]);

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
