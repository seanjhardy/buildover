/**
 * Reads files dropped in from the OS file manager.
 *
 * A drop only exposes bytes, never source paths, so imports upload content
 * rather than asking the server to copy from disk. Dropped folders are walked
 * through the webkit entries API — `DataTransfer.files` alone is flat and would
 * silently drop directory contents.
 */

export interface DroppedFile {
  /** Path relative to the drop target, e.g. "icons/logo.svg" for a folder drop. */
  relPath: string;
  file: File;
}

/** OS metadata that should never be copied into a repo. */
const JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** True when a drag carries OS files rather than an in-app payload. */
export function hasExternalFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}

const fileOf = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/** readEntries returns at most ~100 entries per call, so it must be drained. */
async function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve as (entries: FileSystemEntry[]) => void, reject),
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/**
 * Flattens a drop into uploadable files. Stops at `maxFiles` so dragging in
 * something enormous (a node_modules, a photo library) fails loudly on the
 * caller's side instead of hanging.
 */
export async function readDroppedFiles(
  dataTransfer: DataTransfer,
  maxFiles: number,
): Promise<{ files: DroppedFile[]; truncated: boolean }> {
  // The DataTransfer is emptied the moment the drop handler returns, so every
  // handle has to be taken synchronously — before the first await.
  const roots: FileSystemEntry[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) roots.push(entry);
  }
  const flatFallback = Array.from(dataTransfer.files);

  if (roots.length === 0) {
    const files = flatFallback
      .filter((f) => !JUNK.has(f.name))
      .slice(0, maxFiles)
      .map((file) => ({ relPath: file.name, file }));
    return { files, truncated: flatFallback.length > maxFiles };
  }

  const files: DroppedFile[] = [];
  let truncated = false;

  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (JUNK.has(entry.name)) return;
    if (files.length >= maxFiles) { truncated = true; return; }

    if (entry.isFile) {
      files.push({
        relPath: prefix + entry.name,
        file: await fileOf(entry as FileSystemFileEntry),
      });
      return;
    }
    if (entry.isDirectory) {
      for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
        await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };

  for (const root of roots) await walk(root, "");
  return { files, truncated };
}
