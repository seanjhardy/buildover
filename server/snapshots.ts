/**
 * File-content snapshot utilities for the revert-to-checkpoint feature.
 *
 * Before each Write/Edit/MultiEdit tool call the server saves the current
 * content of the target file.  When the user clicks "Revert" the saved
 * contents are restored and the snapshot directories are cleaned up.
 *
 * Storage layout:
 *   ~/.buildover/repos/<repoBasename>/snapshots/<chatId>/<checkpointId>/
 *     <slot>.json   →  { originalPath: string; content: string | null }
 *
 * `content = null` means the file did not exist before this turn, so
 * reverting should delete it.  A per-checkpoint set tracks which file paths
 * have already been snapshotted so only the *pre-first-edit* state is kept
 * (first-write-wins within one turn).
 *
 * `checkpointId` values are chronologically sortable (cp_<ts>_<rand>) so
 * "all checkpoints at or after X" can be found with a simple lexicographic
 * comparison on the directory names.
 */

import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { chatsDir } from "./repos.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function snapshotsBaseDir(repoPath: string, chatId: string): string {
  // Sibling of the "chats" directory: repos/<name>/snapshots/<chatId>/
  return join(chatsDir(repoPath), "..", "snapshots", chatId);
}

function checkpointDir(
  repoPath: string,
  chatId: string,
  checkpointId: string,
): string {
  return join(snapshotsBaseDir(repoPath, chatId), checkpointId);
}

/**
 * Derive a stable, filesystem-safe filename from an absolute file path.
 * We use the basename plus a short hash of the full path to avoid collisions
 * when two files in different directories share the same basename.
 */
function slotName(filePath: string): string {
  let h = 0;
  for (let i = 0; i < filePath.length; i++) {
    h = (Math.imul(31, h) + filePath.charCodeAt(i)) | 0;
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  const safe = basename(filePath).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${safe}_${hex}.json`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a new checkpoint id of the form `cp_<iso-timestamp-safe>_<rand>`.
 * The timestamp segment is the ISO-8601 instant with colons and dots replaced
 * so it is filesystem-safe and lexicographically sortable; the random suffix
 * disambiguates checkpoints created within the same millisecond.
 */
export function makeCheckpointId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `cp_${ts}_${rand}`;
}

export interface SnapshotEntry {
  originalPath: string;
  /** File contents before the tool ran; null if the file did not exist. */
  content: string | null;
}

/**
 * Save a snapshot of `filePath` for this checkpoint **if one hasn't been
 * saved yet** (first-write-wins within a single turn).  The caller should
 * await this before the file-modifying tool actually executes.
 */
export async function saveSnapshot(
  repoPath: string,
  chatId: string,
  checkpointId: string,
  filePath: string,
): Promise<void> {
  const dir = checkpointDir(repoPath, chatId, checkpointId);
  await mkdir(dir, { recursive: true });

  const dest = join(dir, slotName(filePath));

  // First-write-wins: don't overwrite an already-saved snapshot for this file.
  const existing = await stat(dest).catch(() => null);
  if (existing) return;

  // Read the current content of the file (null if it doesn't exist yet).
  let content: string | null = null;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    // File doesn't exist — content stays null so revert will delete it.
  }

  const entry: SnapshotEntry = { originalPath: filePath, content };
  await writeFile(dest, JSON.stringify(entry, null, 2) + "\n", "utf8");
}

/**
 * Restore all file snapshots for `checkpointId` **and every checkpoint that
 * was created after it** (i.e. all turns from the target point onward).
 *
 * We apply snapshots newest-first so that, for files touched in multiple
 * subsequent turns, the earliest pre-turn state (which is what the user wants)
 * wins.
 */
export async function restoreFromCheckpoint(
  repoPath: string,
  chatId: string,
  checkpointId: string,
): Promise<void> {
  const base = snapshotsBaseDir(repoPath, chatId);

  // List all checkpoint directories for this chat.
  let dirs: string[] = [];
  try {
    dirs = await readdir(base);
  } catch (err: any) {
    if (err?.code === "ENOENT") return; // no snapshots at all — nothing to do
    throw err;
  }

  // Keep only checkpoints that are >= the target (lexicographic works because
  // the IDs are cp_<iso-timestamp-safe>_<rand> — see makeCheckpointId()).
  const toRestore = dirs
    .filter((d) => d >= checkpointId)
    .sort()
    .reverse(); // newest first so earliest pre-turn state wins

  // Track which file paths we've already restored so the earliest snapshot
  // (from the target checkpoint) wins over later ones.
  const restored = new Set<string>();

  for (const cpId of toRestore) {
    const cpDir = join(base, cpId);
    let slots: string[] = [];
    try {
      slots = await readdir(cpDir);
    } catch {
      continue;
    }

    for (const slot of slots) {
      if (!slot.endsWith(".json")) continue;
      let entry: SnapshotEntry;
      try {
        const raw = await readFile(join(cpDir, slot), "utf8");
        entry = JSON.parse(raw) as SnapshotEntry;
      } catch {
        continue;
      }

      const { originalPath, content } = entry;
      if (restored.has(originalPath)) continue; // earlier snapshot already applied
      restored.add(originalPath);

      if (content === null) {
        // File was created by the agent — delete it on revert.
        await rm(originalPath, { force: true });
      } else {
        // Restore the pre-turn content.
        await mkdir(join(originalPath, ".."), { recursive: true });
        await writeFile(originalPath, content, "utf8");
      }
    }
  }
}

/**
 * Delete snapshot directories for `checkpointId` and all newer checkpoints.
 * Call this after a successful revert to keep disk usage tidy.
 */
export async function pruneSnapshotsFrom(
  repoPath: string,
  chatId: string,
  checkpointId: string,
): Promise<void> {
  const base = snapshotsBaseDir(repoPath, chatId);

  let dirs: string[] = [];
  try {
    dirs = await readdir(base);
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    throw err;
  }

  const toDelete = dirs.filter((d) => d >= checkpointId);
  await Promise.all(
    toDelete.map((d) =>
      rm(join(base, d), { recursive: true, force: true }),
    ),
  );
}
