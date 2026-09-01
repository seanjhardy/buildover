/**
 * Mutating file-system operations for the explorer sidebar (create, rename,
 * delete, copy/move, reveal).
 *
 * Every path arriving from the client is relative and resolved against the repo
 * root, then checked for containment — a request can never touch anything
 * outside the repo it names, however the relative path is spelled.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resolves `relPath` inside `repoPath` and rejects anything that escapes the
 * root (`../`, absolute paths, symlink-free string tricks).
 */
export function resolveInRepo(repoPath: string, relPath: string): string {
  const root = resolve(repoPath);
  const full = resolve(root, relPath);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`path escapes the repository: ${relPath}`);
  }
  return full;
}

function assertNotRoot(repoPath: string, full: string): void {
  if (full === resolve(repoPath)) throw new Error("cannot operate on the repository root");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Splits a name into its stem and extension so copies can be numbered before
 * the extension the way Finder and VS Code do it (`a copy 2.ts`, not
 * `a.ts copy 2`). Dotfiles have no extension: `.env` -> [".env", ""].
 */
function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

/**
 * First free name in `dir` derived from `name`: `x.ts`, `x copy.ts`,
 * `x copy 2.ts`… Used by paste-into-same-folder and duplicate.
 */
async function uniqueName(dir: string, name: string): Promise<string> {
  if (!(await exists(join(dir, name)))) return name;
  const [stem, ext] = splitExt(name);
  if (!(await exists(join(dir, `${stem} copy${ext}`)))) return `${stem} copy${ext}`;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} copy ${i}${ext}`;
    if (!(await exists(join(dir, candidate)))) return candidate;
  }
  throw new Error(`could not find a free name for ${name}`);
}

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Creates an empty file or a directory. Intermediate directories are created
 * too, so a name like `lib/utils/date.ts` works in one step.
 */
export async function createEntry(
  repoPath: string,
  relPath: string,
  kind: "file" | "dir",
): Promise<{ relPath: string }> {
  if (!relPath.trim()) throw new Error("name required");
  const full = resolveInRepo(repoPath, relPath);
  assertNotRoot(repoPath, full);
  if (await exists(full)) throw new Error(`"${basename(full)}" already exists`);

  if (kind === "dir") {
    await mkdir(full, { recursive: true });
  } else {
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, "", { encoding: "utf8", flag: "wx" });
  }
  return { relPath: relative(resolve(repoPath), full) };
}

// ── Rename / move ─────────────────────────────────────────────────────────────

export async function renameEntry(
  repoPath: string,
  fromRel: string,
  toRel: string,
): Promise<{ relPath: string }> {
  if (!toRel.trim()) throw new Error("name required");
  const from = resolveInRepo(repoPath, fromRel);
  const to = resolveInRepo(repoPath, toRel);
  assertNotRoot(repoPath, from);
  assertNotRoot(repoPath, to);
  if (from === to) return { relPath: relative(resolve(repoPath), to) };
  if (!(await exists(from))) throw new Error(`"${basename(from)}" no longer exists`);
  // Case-only renames on case-insensitive filesystems report the target as
  // existing because it is the same inode, so let those through.
  if (from.toLowerCase() !== to.toLowerCase() && (await exists(to))) {
    throw new Error(`"${basename(to)}" already exists`);
  }
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return { relPath: relative(resolve(repoPath), to) };
}

// ── Delete ────────────────────────────────────────────────────────────────────

/**
 * Hands paths to the OS trash so a mis-click stays recoverable. Only macOS and
 * Linux (via gio) are wired up; elsewhere the caller is told to fall back to a
 * permanent delete rather than silently doing one.
 */
async function moveToTrash(paths: string[]): Promise<void> {
  if (process.platform === "darwin") {
    // Finder's `delete` is the only scriptable route to the real Trash. Paths
    // are passed as a POSIX file list so no shell quoting is involved.
    const list = paths.map((p) => `POSIX file ${JSON.stringify(p)}`).join(", ");
    await execFileAsync("osascript", [
      "-e",
      `tell application "Finder" to delete {${list}}`,
    ]);
    return;
  }
  if (process.platform === "linux") {
    await execFileAsync("gio", ["trash", ...paths]);
    return;
  }
  throw new Error("TRASH_UNSUPPORTED");
}

export async function deleteEntries(
  repoPath: string,
  relPaths: string[],
  permanent: boolean,
): Promise<{ deleted: string[]; trashed: boolean }> {
  if (relPaths.length === 0) return { deleted: [], trashed: false };
  const full = relPaths.map((p) => {
    const abs = resolveInRepo(repoPath, p);
    assertNotRoot(repoPath, abs);
    return abs;
  });
  const present = (
    await Promise.all(full.map(async (p) => ((await exists(p)) ? p : null)))
  ).filter((p): p is string => p !== null);
  if (present.length === 0) throw new Error("nothing left to delete");

  if (permanent) {
    await Promise.all(present.map((p) => rm(p, { recursive: true, force: true })));
    return { deleted: present.map((p) => relative(resolve(repoPath), p)), trashed: false };
  }

  try {
    await moveToTrash(present);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      msg.includes("TRASH_UNSUPPORTED")
        ? "the trash is not available on this platform — use Delete Permanently"
        : `could not move to trash: ${msg}`,
    );
  }
  return { deleted: present.map((p) => relative(resolve(repoPath), p)), trashed: true };
}

// ── Copy / move (paste, duplicate, drag & drop) ───────────────────────────────

/**
 * Copies or moves entries into `toDirRel`. Name collisions are resolved by
 * numbering the copy rather than overwriting, so a paste can never destroy an
 * existing file.
 */
export async function transferEntries(
  repoPath: string,
  fromRels: string[],
  toDirRel: string,
  mode: "copy" | "move",
): Promise<{ moves: Array<{ from: string; to: string }> }> {
  const root = resolve(repoPath);
  const toDir = resolveInRepo(repoPath, toDirRel);
  const toDirStat = await stat(toDir).catch(() => null);
  if (!toDirStat?.isDirectory()) throw new Error("destination is not a folder");

  // Pairs rather than a bare list: entries can be skipped (already in place,
  // vanished) and callers need to know which source each result came from.
  const moves: Array<{ from: string; to: string }> = [];
  for (const fromRel of fromRels) {
    const from = resolveInRepo(repoPath, fromRel);
    assertNotRoot(repoPath, from);
    if (!(await exists(from))) continue;

    // Moving a folder into itself or its own descendant would detach the tree.
    if (mode === "move" && (toDir === from || toDir.startsWith(from + sep))) {
      throw new Error(`cannot move "${basename(from)}" into itself`);
    }
    if (mode === "move" && dirname(from) === toDir) continue; // already there

    const to = join(toDir, await uniqueName(toDir, basename(from)));
    if (mode === "move") {
      await rename(from, to);
    } else {
      await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    }
    moves.push({ from: relative(root, from), to: relative(root, to) });
  }
  return { moves };
}

// ── Import from outside the repo (Finder drag & drop) ─────────────────────────

/**
 * Writes one dropped file into `toDirRel`. `relName` may contain slashes, which
 * is how a dropped folder arrives — one call per file, with the folder
 * structure encoded in the name — so parent directories are created on demand.
 *
 * Collisions are numbered rather than overwritten, which means dropping a
 * folder onto an existing one of the same name merges the two instead of
 * replacing it. Nothing already on disk is ever destroyed by an import.
 */
export async function importFile(
  repoPath: string,
  toDirRel: string,
  relName: string,
  data: Buffer,
): Promise<{ relPath: string }> {
  if (!relName.trim()) throw new Error("name required");
  const root = resolve(repoPath);
  const toDir = resolveInRepo(repoPath, toDirRel);
  const target = resolveInRepo(repoPath, join(toDirRel, relName));

  // A name like "../sibling/x" stays inside the repo but leaves the folder the
  // user actually dropped onto, so it is checked separately.
  if (target !== toDir && !target.startsWith(toDir + sep)) {
    throw new Error(`"${relName}" escapes the destination folder`);
  }

  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const finalPath = join(parent, await uniqueName(parent, basename(target)));
  await writeFile(finalPath, data);
  return { relPath: relative(root, finalPath) };
}

// ── Reveal in the OS file manager ─────────────────────────────────────────────

export async function revealEntry(repoPath: string, relPath: string): Promise<void> {
  const full = resolveInRepo(repoPath, relPath);
  if (!(await exists(full))) throw new Error("path no longer exists");
  if (process.platform === "darwin") {
    await execFileAsync("open", ["-R", full]);
    return;
  }
  if (process.platform === "linux") {
    await execFileAsync("xdg-open", [dirname(full)]);
    return;
  }
  throw new Error("revealing files is not supported on this platform");
}

/** Opens a path with the OS default application ("Open With Default App"). */
export async function openEntryExternally(repoPath: string, relPath: string): Promise<void> {
  const full = resolveInRepo(repoPath, relPath);
  if (!(await exists(full))) throw new Error("path no longer exists");
  if (process.platform === "darwin") {
    await execFileAsync("open", [full]);
    return;
  }
  if (process.platform === "linux") {
    await execFileAsync("xdg-open", [full]);
    return;
  }
  throw new Error("opening files externally is not supported on this platform");
}
