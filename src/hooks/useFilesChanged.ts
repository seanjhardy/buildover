import { useMemo } from "react";
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

function countLines(s: string): number {
  if (!s) return 0;
  // Count newlines; a trailing newline doesn't add an extra line
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n + (s[s.length - 1] !== "\n" ? 1 : 0);
}

/**
 * Scans all assistant turns for Write / Edit tool calls and returns a
 * deduplicated list of FileEntry objects, with added/removed line counts
 * derived directly from the tool call inputs (old_string / new_string for
 * Edit; full content line count for Write). This works even after the changes
 * have been committed, because we're reading the agent's own records.
 */
export function useFilesChanged(
  turns: ChatTurn[],
  cwd: string,
  // repoPath kept for API compatibility even though we no longer call git here
  _repoPath: string,
): FileEntry[] {
  return useMemo(() => {
    // absPath → { op, added, removed, relPath }
    const map = new Map<string, FileEntry & { added: number; removed: number }>();

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

        if (name === "Write") {
          const content = String(input.content ?? "");
          const added = countLines(content);
          const existing = map.get(absPath);
          if (!existing) {
            map.set(absPath, { path: absPath, relPath, op: "write", added, removed: 0 });
          } else {
            // Accumulate if the file was written multiple times
            existing.added += added;
          }
        } else {
          // Edit — accumulate old_string (removed) and new_string (added) lines
          const oldStr = String(input.old_string ?? "");
          const newStr = String(input.new_string ?? "");
          const addedLines = countLines(newStr);
          const removedLines = countLines(oldStr);
          const existing = map.get(absPath);
          if (!existing) {
            map.set(absPath, {
              path: absPath,
              relPath,
              op: "edit",
              added: addedLines,
              removed: removedLines,
            });
          } else {
            // Edit beats Write as op label; accumulate line counts
            if (existing.op === "write") existing.op = "edit";
            existing.added += addedLines;
            existing.removed += removedLines;
          }
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
            map.set(absPath, { path: absPath, relPath, op: "delete", added: 0, removed: 0 });
          }
        }
      }
    }

    return Array.from(map.values());
  }, [turns, cwd]);
}
