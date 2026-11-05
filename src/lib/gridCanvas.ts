/**
 * gridCanvas.ts — geometry for the Grid page's canvas.
 *
 * Every chat window is one cell of an infinite integer grid. All cells share
 * one size (resizing any window resizes the whole grid), so a window's place
 * is just (c, r) and "snapped together" means "4-adjacent". Windows that touch
 * form one connected shape: shared edges get a hairline, outer corners are
 * rounded and concave (L-shaped) corners get an inner fillet.
 */

export interface Cell {
  c: number;
  r: number;
}

export interface View {
  /** Screen offset of canvas origin, in px. */
  x: number;
  y: number;
  scale: number;
}

export interface CanvasLayout {
  /** Shared cell size, in canvas px. */
  cellW: number;
  cellH: number;
  positions: Record<string, Cell>;
  view: View | null;
}

export const DEFAULT_CELL_W = 600;
export const DEFAULT_CELL_H = 720;
export const MIN_CELL_W = 380;
export const MAX_CELL_W = 1200;
export const MIN_CELL_H = 380;
export const MAX_CELL_H = 1400;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 1.25;
/** At or above this scale a window's transcript and composer take input;
 *  below it the canvas owns every pointer and wheel event. */
export const INTERACTIVE_SCALE = 0.75;
/** Below this scale a window shows its repo colour and title instead of its
 *  (by then unreadable) transcript. */
export const FAR_SCALE = 0.45;
/** From this scale down to FAR_SCALE, the colour and title fade in over the
 *  transcript with the zoom, so the switch at FAR_SCALE can't be seen. */
export const FADE_SCALE = 0.6;

const STORAGE_KEY = "buildover.gridCanvas";

export function loadLayout(): CanvasLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<CanvasLayout>;
      return {
        cellW: clamp(v.cellW ?? DEFAULT_CELL_W, MIN_CELL_W, MAX_CELL_W),
        cellH: clamp(v.cellH ?? DEFAULT_CELL_H, MIN_CELL_H, MAX_CELL_H),
        positions: v.positions ?? {},
        view: v.view ?? null,
      };
    }
  } catch {
    /* ignore */
  }
  return { cellW: DEFAULT_CELL_W, cellH: DEFAULT_CELL_H, positions: {}, view: null };
}

export function saveLayout(layout: CanvasLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export const key = (c: number, r: number) => `${c},${r}`;

/** cell key → chat id. */
export function occupancy(positions: Record<string, Cell>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, p] of Object.entries(positions)) out.set(key(p.c, p.r), id);
  return out;
}

const DIRS: Cell[] = [
  { c: 1, r: 0 },
  { c: -1, r: 0 },
  { c: 0, r: 1 },
  { c: 0, r: -1 },
];

/** The chats joined to `id` through shared edges, including `id` itself. */
export function connectedGroup(id: string, positions: Record<string, Cell>): string[] {
  const occ = occupancy(positions);
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const p = positions[stack.pop()!];
    if (!p) continue;
    for (const d of DIRS) {
      const n = occ.get(key(p.c + d.c, p.r + d.r));
      if (n && !seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return [...seen];
}

/** Where a new chat goes: beside the other chats of its repo (or, given
 *  `near`, beside just those windows), keeping each repo's block compact (a
 *  little wider than tall, to suit a landscape screen) and not touching another
 *  repo's block. A repo's first chat starts a new block one empty column to the
 *  right of everything. */
export function placeNew(
  positions: Record<string, Cell>,
  repoOf: (chatId: string) => string | undefined,
  repo: string,
  near?: string[],
): Cell {
  const occ = occupancy(positions);
  const all = Object.values(positions);
  if (all.length === 0) return { c: 0, r: 0 };
  const mine = (near ?? Object.keys(positions).filter((id) => repoOf(id) === repo))
    .map((id) => positions[id])
    .filter((p): p is Cell => p != null);
  if (mine.length === 0) {
    const maxC = Math.max(...all.map((p) => p.c));
    const minR = Math.min(...all.map((p) => p.r));
    return { c: maxC + 2, r: minR };
  }
  const touchesOther = (cell: Cell) =>
    DIRS.some((d) => {
      const n = occ.get(key(cell.c + d.c, cell.r + d.r));
      return n != null && repoOf(n) !== repo;
    });
  const minC = Math.min(...mine.map((m) => m.c));
  const minR = Math.min(...mine.map((m) => m.r));
  let best: Cell | null = null;
  let bestScore = Infinity;
  for (const p of mine) {
    for (const d of DIRS) {
      const cand = { c: p.c + d.c, r: p.r + d.r };
      if (occ.has(key(cand.c, cand.r))) continue;
      const cs = [...mine.map((m) => m.c), cand.c];
      const rs = [...mine.map((m) => m.r), cand.r];
      const bw = Math.max(...cs) - Math.min(...cs) + 1;
      const bh = Math.max(...rs) - Math.min(...rs) + 1;
      // Ties grow right, then down, rather than up or left.
      const score =
        Math.max(bw, bh * 1.4) * 10 +
        bw * bh +
        (touchesOther(cand) ? 100 : 0) +
        (cand.c < minC || cand.r < minR ? 1 : 0) +
        (cand.r - minR) * 0.1 +
        (cand.c - minC) * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = cand;
      }
    }
  }
  if (best) return best;
  const maxC = Math.max(...all.map((p) => p.c));
  return { c: maxC + 2, r: Math.min(...all.map((p) => p.r)) };
}

/** One block of a repo: its windows that join edge to edge. */
export interface RepoGroup {
  repo: string;
  /** Reading order; the first one names the group. */
  ids: string[];
  /** The free cell beside the block where its next chat goes, or null when
   *  other repos' windows box it in. */
  slot: Cell | null;
  /** Which side of `slot` the block lies on. */
  side: keyof Sides;
}

/** Every repo's windows, split into the blocks they form, each with the cell
 *  its next chat would take. */
export function repoGroups(
  positions: Record<string, Cell>,
  repoOf: (chatId: string) => string | undefined,
): RepoGroup[] {
  const occ = occupancy(positions);
  const reading = Object.keys(positions).sort(
    (a, b) => positions[a].r - positions[b].r || positions[a].c - positions[b].c,
  );
  const order = new Map(reading.map((id, i) => [id, i]));
  const seen = new Set<string>();
  const out: RepoGroup[] = [];
  for (const first of reading) {
    const repo = repoOf(first);
    if (seen.has(first) || repo == null) continue;
    seen.add(first);
    const ids = [first];
    for (let i = 0; i < ids.length; i++) {
      const p = positions[ids[i]];
      for (const d of DIRS) {
        const n = occ.get(key(p.c + d.c, p.r + d.r));
        if (n && !seen.has(n) && repoOf(n) === repo) {
          seen.add(n);
          ids.push(n);
        }
      }
    }
    ids.sort((a, b) => order.get(a)! - order.get(b)!);
    const mine = new Set(ids);
    const slot = placeNew(positions, repoOf, repo, ids);
    const beside = (dc: number, dr: number) => mine.has(occ.get(key(slot.c + dc, slot.r + dr)) ?? "");
    const side = beside(-1, 0) ? "w" : beside(0, -1) ? "n" : beside(1, 0) ? "e" : beside(0, 1) ? "s" : null;
    out.push({ repo, ids, slot: side ? slot : null, side: side ?? "s" });
  }
  return out;
}

/** Which sides of a cell have a neighbour. */
export interface Sides {
  n: boolean;
  e: boolean;
  s: boolean;
  w: boolean;
}

export function sidesOf(p: Cell, occ: Map<string, string>): Sides {
  return {
    n: occ.has(key(p.c, p.r - 1)),
    e: occ.has(key(p.c + 1, p.r)),
    s: occ.has(key(p.c, p.r + 1)),
    w: occ.has(key(p.c - 1, p.r)),
  };
}

/** A concave corner: a grid point where exactly three of the four cells
 *  around it are filled. The fillet sits in the empty cell's corner. */
export interface Fillet {
  /** Grid point (cell-corner coordinates). */
  x: number;
  y: number;
  /** Which way the empty cell lies from the point. */
  dx: 1 | -1;
  dy: 1 | -1;
  /** A chat bordering the corner, whose colour the fillet takes. */
  chatId: string;
}

export function fillets(positions: Record<string, Cell>): Fillet[] {
  const occ = occupancy(positions);
  const points = new Set<string>();
  for (const p of Object.values(positions)) {
    for (const [x, y] of [
      [p.c, p.r],
      [p.c + 1, p.r],
      [p.c, p.r + 1],
      [p.c + 1, p.r + 1],
    ]) {
      points.add(key(x, y));
    }
  }
  const out: Fillet[] = [];
  for (const pt of points) {
    const [x, y] = pt.split(",").map(Number);
    // The four cells around point (x, y): their top-left corners.
    const around: [number, number, 1 | -1, 1 | -1][] = [
      [x - 1, y - 1, -1, -1],
      [x, y - 1, 1, -1],
      [x - 1, y, -1, 1],
      [x, y, 1, 1],
    ];
    const empty = around.filter(([c, r]) => !occ.has(key(c, r)));
    if (empty.length !== 1) continue;
    const [ec, er, dx, dy] = empty[0];
    // Take the colour of the cell beside the empty one horizontally.
    const chatId = occ.get(key(ec - dx, er))!;
    out.push({ x, y, dx, dy, chatId });
  }
  return out;
}

export type Dir = "left" | "right" | "up" | "down";

/** The window nearest `from` in direction `dir`, by cell: distance along the
 *  direction plus a heavier penalty for drifting sideways, so moving right
 *  stays in the row and moving down picks the nearest column. */
export function neighbourIn(
  from: string,
  positions: Record<string, Cell>,
  dir: Dir,
): string | null {
  const a = positions[from];
  if (!a) return null;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [id, b] of Object.entries(positions)) {
    if (id === from) continue;
    const dc = b.c - a.c;
    const dr = b.r - a.r;
    const along = dir === "left" ? -dc : dir === "right" ? dc : dir === "up" ? -dr : dr;
    const across = dir === "left" || dir === "right" ? Math.abs(dr) : Math.abs(dc);
    if (along <= 0) continue;
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/** Bounding box of every cell, in cells. */
export function bounds(positions: Record<string, Cell>) {
  const ps = Object.values(positions);
  if (ps.length === 0) return null;
  return {
    minC: Math.min(...ps.map((p) => p.c)),
    minR: Math.min(...ps.map((p) => p.r)),
    maxC: Math.max(...ps.map((p) => p.c)) + 1,
    maxR: Math.max(...ps.map((p) => p.r)) + 1,
  };
}

/** The windows a selection box touches, even by a corner. The box is in
 *  canvas px. */
export function windowsTouching(
  positions: Record<string, Cell>,
  cellW: number,
  cellH: number,
  box: { left: number; top: number; right: number; bottom: number },
): string[] {
  return Object.keys(positions).filter((id) => {
    const p = positions[id];
    return (
      p.c * cellW < box.right &&
      (p.c + 1) * cellW > box.left &&
      p.r * cellH < box.bottom &&
      (p.r + 1) * cellH > box.top
    );
  });
}

/** Nearest offset to (dc, dr) at which `group` fits without landing on any
 *  other window. */
export function nearestFreeOffset(
  group: string[],
  positions: Record<string, Cell>,
  dc: number,
  dr: number,
): Cell {
  const inGroup = new Set(group);
  const others = new Set<string>();
  for (const [id, p] of Object.entries(positions)) if (!inGroup.has(id)) others.add(key(p.c, p.r));
  const fits = (oc: number, or: number) =>
    group.every((id) => {
      const p = positions[id];
      return !others.has(key(p.c + oc, p.r + or));
    });
  if (fits(dc, dr)) return { c: dc, r: dr };
  for (let radius = 1; radius <= 12; radius++) {
    let best: Cell | null = null;
    let bestD = Infinity;
    for (let oc = dc - radius; oc <= dc + radius; oc++) {
      for (let or = dr - radius; or <= dr + radius; or++) {
        if (Math.max(Math.abs(oc - dc), Math.abs(or - dr)) !== radius) continue;
        if (!fits(oc, or)) continue;
        const d = Math.hypot(oc - dc, or - dr);
        if (d < bestD) {
          bestD = d;
          best = { c: oc, r: or };
        }
      }
    }
    if (best) return best;
  }
  return { c: 0, r: 0 };
}

/** Tidy layout: each repo's windows packed into one compact block (a little
 *  wider than tall), blocks side by side along the top with an empty column
 *  between them. Repos keep their left-to-right order, and windows within a
 *  repo keep their reading order, so things move as little as they can. */
export function arrange(
  positions: Record<string, Cell>,
  repoOf: (chatId: string) => string | undefined,
): Record<string, Cell> {
  const byRepo = new Map<string, [string, Cell][]>();
  for (const [id, p] of Object.entries(positions)) {
    const repo = repoOf(id) ?? "";
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo)!.push([id, p]);
  }
  const reading = (a: Cell, b: Cell) => a.r - b.r || a.c - b.c;
  const blocks = [...byRepo.values()].map((items) => {
    items.sort((a, b) => reading(a[1], b[1]));
    const left = Math.min(...items.map(([, p]) => p.c));
    const top = Math.min(...items.map(([, p]) => p.r));
    return { items, left, top };
  });
  blocks.sort((a, b) => a.left - b.left || a.top - b.top);
  const out: Record<string, Cell> = {};
  let col = 0;
  for (const { items } of blocks) {
    const cols = blockColumns(items.length);
    items.forEach(([id], i) => {
      out[id] = { c: col + (i % cols), r: Math.floor(i / cols) };
    });
    col += Math.min(cols, items.length) + 1;
  }
  return out;
}

/** Columns for a block of n windows, judged the way placeNew judges growth:
 *  smallest max(width, height × 1.4), then least wasted space. */
function blockColumns(n: number): number {
  let best = 1;
  let bestScore = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const score = Math.max(cols, rows * 1.4) * 10 + cols * rows;
    if (score < bestScore) {
      bestScore = score;
      best = cols;
    }
  }
  return best;
}
