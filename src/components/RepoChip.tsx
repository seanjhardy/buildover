/** Repo identity colours for the Grid canvas: each repo's windows, tint and
 *  border take a hue derived from its path, so windows from three projects are
 *  distinguishable without reading anything. The hues are muted and avoid the
 *  red/orange band, which is spoken for by attention and cost warnings. */

export interface RepoColor {
  hue: number;
  /** 0 | 1 — the brightness tier that goes with the hue. */
  tone: number;
}

// Twelve hues walking the cool half of the wheel, ~20-25° apart so neighbours
// are still tellable apart. Nothing below 95°: red/orange/amber are spoken for
// by attention, the warmth pill and the cost warnings.
const HUES = [95, 120, 150, 170, 190, 210, 230, 250, 270, 290, 310, 330];
// A second, independent bit of the hash picks a light or dark tone, so two
// repos landing on the same hue still differ.
const TONES = 2;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Avalanche: repo paths share a long directory prefix, and without a final
  // mix the colours clump at one end of the wheel.
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return Math.abs(h);
}

const BUCKETS = HUES.length * TONES;

function bucketColor(slot: number): RepoColor {
  return { hue: HUES[slot % HUES.length], tone: Math.floor(slot / HUES.length) };
}

/** A repo's own colour, keyed on its path (two repos may share a name). */
export function repoColor(repoPath: string): RepoColor {
  return bucketColor(hashString(repoPath) % BUCKETS);
}

/** Colours for a whole set of repos with the collisions taken out: each keeps
 *  its own hashed colour when that swatch is free, and otherwise takes the next
 *  one five hues away. Deterministic for a given set (the paths are sorted
 *  first), so the grid doesn't reshuffle its colours as chats come and go —
 *  only a repo that was actually colliding ever moves. */
export function assignRepoColors(paths: Iterable<string>): Map<string, RepoColor> {
  const taken = new Set<number>();
  const out = new Map<string, RepoColor>();
  // Free, and not sitting right next to an already-used hue in the same tone:
  // neighbouring hues are only ~20° apart and do read as the same colour.
  const roomy = (slot: number) => {
    const hue = slot % HUES.length;
    const tone = Math.floor(slot / HUES.length);
    for (const d of [-1, 0, 1]) {
      const near = (hue + d + HUES.length) % HUES.length;
      if (taken.has(tone * HUES.length + near)) return false;
    }
    return true;
  };
  for (const path of [...new Set(paths)].sort()) {
    const wanted = hashString(path) % BUCKETS;
    // Step 5 is coprime with 24, so this visits every swatch, and one step is
    // a five-hue jump rather than the same hue a shade lighter. Two passes:
    // take a roomy swatch if there is one, otherwise settle for a free one.
    let slot = wanted;
    for (let i = 1; !roomy(slot) && i <= BUCKETS; i++) slot = (wanted + i * 5) % BUCKETS;
    if (!roomy(slot)) {
      slot = wanted;
      for (let i = 1; taken.has(slot) && i <= BUCKETS; i++) slot = (wanted + i * 5) % BUCKETS;
    }
    taken.add(slot);
    out.set(path, bucketColor(slot));
  }
  return out;
}

/** CSS custom properties that carry a repo colour into grid styles. */
export function repoColorVars(color: RepoColor): Record<string, string> {
  return { "--repo-hue": String(color.hue), "--repo-tone": String(color.tone) };
}
