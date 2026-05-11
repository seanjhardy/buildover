import { useEffect, useMemo, useRef, useState } from "react";
import { gitApi, type FileDiffStat } from "../lib/api.js";
import type { ChatTurn } from "./useAgent.js";

export interface FileEntry {
  /** Absolute path */
  path: string;
  /** Path relative to cwd, e.g. "src/foo.ts" */
  relPath: string;
  /** write = Write tool, edit = Edit tool, delete = rm/unlink via Bash */
  op: "write" | "edit" | "delete";
  added?: number;
  removed?: number;
}

// Strip the cwd prefix from an absolute path so it shows as a project-relative
// path — same logic used in ToolUseBlock.
function toRelPath(absPath: string, cwd: string): string {
  if (!absPath.startsWith(cwd)) return absPath;
  const rest = absPath.slice(cwd.length);
  return rest.startsWith("/") ? rest.slice(1) : rest;
}

/**
 * Scans all assistant turns for Write / Edit tool calls and returns a
 * deduplicated list of FileEntry objects.  Edit takes precedence over Write if
 * the same file appears under both names.  Git diff stats are fetched once and
 * kept fresh with a 600 ms debounce after the file list changes.
 */
export function useFilesChanged(
  turns: ChatTurn[],
  cwd: string,
  repoPath: string,
): FileEntry[] {
  // 1. Derive file list from turns (cheap, synchronous, memoised)
  const rawEntries = useMemo(() => {
    const map = new Map<string, FileEntry>();

    for (const turn of turns) {
      if (turn.kind !== "assistant") continue;
      for (const block of turn.content) {
        if (block.type !== "tool_use") continue;
        const name = block.name;
        if (name !== "Write" && name !== "Edit") continue;
        const input = block.input as Record<string, unknown>;
        const absPath = String(input.file_path ?? "");
        if (!absPath) continue;
        const relPath = toRelPath(absPath, cwd);
        const op: "write" | "edit" = name === "Edit" ? "edit" : "write";
        const existing = map.get(absPath);
        // Edit beats Write (more informative op label)
        if (!existing || (existing.op === "write" && op === "edit")) {
          map.set(absPath, { path: absPath, relPath, op });
        }
      }
    }

    // Second pass: detect deletions via Bash rm/unlink commands (best-effort).
    // Only registers a delete if the path hasn't already been seen as write/edit.
    const deletePattern =
      /(?:^|\s)(?:rm\s+(?:-[rfvRFV]+\s+)*|unlink\s+)((?:\.{0,2}\/)?[\w.\-/]+\.\w+)/gm;
    for (const turn of turns) {
      if (turn.kind !== "assistant") continue;
      for (const block of turn.content) {
        if (block.type !== "tool_use" || block.name !== "Bash") continue;
        const input = block.input as Record<string, unknown>;
        const command = String(input.command ?? "");
        if (!command) continue;
        let match: RegExpExecArray | null;
        deletePattern.lastIndex = 0;
        while ((match = deletePattern.exec(command)) !== null) {
          const rawPath = match[1]!.trim();
          const absPath = rawPath.startsWith("/")
            ? rawPath
            : `${cwd}/${rawPath}`.replace(/\/\/+/g, "/");
          if (!map.has(absPath)) {
            const relPath = toRelPath(absPath, cwd);
            map.set(absPath, { path: absPath, relPath, op: "delete" });
          }
        }
      }
    }

    return Array.from(map.values());
  }, [turns, cwd]);

  // 2. Maintain git diff stats, refreshed whenever the file list changes
  const [stats, setStats] = useState<Record<string, FileDiffStat>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relPathsKey = rawEntries.map((e) => e.relPath).join("|");

  useEffect(() => {
    if (rawEntries.length === 0) {
      setStats({});
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const relPaths = rawEntries.map((e) => e.relPath);
      gitApi
        .getDiffStat(repoPath, relPaths)
        .then(setStats)
        .catch(() => { /* silently ignore — stats are best-effort */ });
    }, 600);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relPathsKey, repoPath]);

  // 3. Merge stats into entries
  return useMemo(
    () =>
      rawEntries.map((e) => {
        const s = stats[e.relPath];
        return s ? { ...e, added: s.added, removed: s.removed } : e;
      }),
    [rawEntries, stats],
  );
}
