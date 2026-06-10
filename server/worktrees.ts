import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PermissionMode } from "../src/types.js";

const execFileAsync = promisify(execFile);

// Per-subagent git worktrees isolate a code-editing subagent's SDK session in
// its own working tree + branch, so its edits never touch the live backend's
// main working tree (or another concurrent subagent's) until merged back.
//
// All git calls here are guarded: a failure returns a safe fallback (null /
// error result) rather than throwing, so a git problem can never crash the
// backend or the session that depends on it.

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export type MergeResult =
  | { status: "merged"; branch: string }
  | { status: "no_changes"; branch: string }
  | { status: "conflict"; branch: string; path: string; detail: string }
  | { status: "error"; detail: string };

function worktreesRoot(repoPath: string): string {
  const name = basename(repoPath) || "repo";
  return join(homedir(), ".buildover", "worktrees", name);
}

function worktreePathFor(repoPath: string, chatId: string): string {
  return join(worktreesRoot(repoPath), chatId);
}

function branchNameFor(chatId: string): string {
  return `subagent/${chatId}`;
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object") {
    const anyE = e as { stderr?: unknown; message?: unknown };
    const stderr = typeof anyE.stderr === "string" ? anyE.stderr.trim() : "";
    if (stderr) return stderr;
    if (typeof anyE.message === "string") return anyE.message;
  }
  return String(e);
}

// The git toplevel of the repository the backend's own source code lives in.
// An agent editing THIS repo in place can hot-reload or crash the running
// backend mid-task, so it is the one repo that warrants worktree isolation.
// In a packaged build the server code doesn't live in a git repo at all, so
// this resolves to null — and no repo needs isolation, because editing the
// buildover checkout no longer affects the running (bundled) backend.
let backendRootPromise: Promise<string | null> | null = null;
function backendRepoRoot(): Promise<string | null> {
  backendRootPromise ??= (async () => {
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--show-toplevel"],
        { cwd: here },
      );
      return await realpath(stdout.trim());
    } catch {
      return null;
    }
  })();
  return backendRootPromise;
}

/**
 * Decides whether a subagent runs in an isolated worktree. Agents work
 * directly in the target repo's main tree — the user wants to test their
 * changes immediately — with two exceptions:
 *  - read-only ("plan") subagents never need isolation, and
 *  - the repo the live backend runs from DOES get isolation, because in-place
 *    edits there can hot-reload/crash the backend that's running the agent.
 */
export async function shouldUseWorktree(
  permissionMode: PermissionMode,
  repoPath: string,
): Promise<boolean> {
  if (permissionMode === "plan") return false;
  const backendRoot = await backendRepoRoot();
  if (!backendRoot) return false;
  try {
    return (await realpath(repoPath)) === backendRoot;
  } catch {
    return false;
  }
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: repoPath,
    });
    return true;
  } catch {
    return false;
  }
}

// True if a worktree is already registered at exactly `path` (survives a
// backend restart — git stores worktree metadata in the main repo's .git dir).
async function worktreeRegistered(
  repoPath: string,
  path: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: repoPath },
    );
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ") && line.slice("worktree ".length).trim() === path) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Idempotently ensures a git worktree exists for the given chat, on a dedicated
 * `subagent/<chatId>` branch forked from the main repo's current HEAD. Returns
 * the worktree path + branch, or null if isolation could not be set up (e.g.
 * the directory isn't a git repo, or a git call failed) — in which case the
 * caller should fall back to the shared main tree.
 *
 * Reuses an already-registered worktree (after a restart) rather than erroring.
 */
export async function ensureWorktree(
  repoPath: string,
  chatId: string,
): Promise<WorktreeInfo | null> {
  const path = worktreePathFor(repoPath, chatId);
  const branch = branchNameFor(chatId);

  if (!(await isGitRepo(repoPath))) {
    console.warn(`[worktree] ${repoPath} is not a git repo — running ${chatId} in the shared tree`);
    return null;
  }

  try {
    // Restart-safe: if the worktree is already registered, reuse it as-is.
    if (await worktreeRegistered(repoPath, path)) {
      return { path, branch };
    }

    await mkdir(worktreesRoot(repoPath), { recursive: true });

    if (await refExists(repoPath, branch)) {
      // Branch survived a prior run (worktree was removed but branch kept).
      // Re-attach a worktree to it instead of recreating the branch.
      await execFileAsync("git", ["worktree", "add", path, branch], { cwd: repoPath });
    } else {
      await execFileAsync("git", ["worktree", "add", path, "-b", branch, "HEAD"], {
        cwd: repoPath,
      });
    }
    return { path, branch };
  } catch (e) {
    console.warn(`[worktree] failed to create worktree for ${chatId}:`, errMsg(e));
    return null;
  }
}

// Dry-run merge using `git merge-tree --write-tree`: performs a real 3-way merge
// of the two branch tips into the object store WITHOUT touching the main
// working tree, index, or HEAD. Returns conflict details if the merge would
// conflict, or null if it is clean (or if conflict detection isn't possible).
async function detectMergeConflict(
  repoPath: string,
  base: string,
  branch: string,
): Promise<string | null> {
  try {
    await execFileAsync("git", ["merge-tree", "--write-tree", base, branch], {
      cwd: repoPath,
    });
    return null; // exit 0 → clean
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 1) {
      // Conflicted merge — stdout carries the conflicted tree + file list.
      const out = (e as { stdout?: string }).stdout ?? "";
      return out.trim() || "merge conflict";
    }
    // Anything else (e.g. an unsupported flag on an older git): we can't tell,
    // so report "clean" here and let the guarded real merge below decide. That
    // merge has its own abort-and-surface safety net.
    return null;
  }
}

// Removes a dedicated subagent worktree and deletes its branch. Best-effort:
// failures are logged but never thrown. Only ever operates on the isolated
// subagent worktree/branch — never on the main repo's tree or branch.
async function removeWorktree(
  repoPath: string,
  path: string,
  branch: string,
): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", "--force", path], {
    cwd: repoPath,
  }).catch((e) => console.warn(`[worktree] remove failed for ${path}:`, errMsg(e)));
  await execFileAsync("git", ["branch", "-D", branch], {
    cwd: repoPath,
  }).catch((e) => console.warn(`[worktree] branch delete failed for ${branch}:`, errMsg(e)));
}

/**
 * Merges a finished subagent's worktree branch back into the branch checked out
 * in the main working tree, then cleans up.
 *
 * Behavior:
 *  - Commits any uncommitted edits in the worktree onto its branch.
 *  - If the branch has no commits ahead of main, there is nothing to merge:
 *    cleans up the worktree and reports "no_changes".
 *  - Dry-run merges with `git merge-tree` first. If that conflicts, surfaces
 *    the conflict and leaves BOTH the worktree and branch in place for manual
 *    resolution (never clobbers the main tree).
 *  - On a clean dry-run, performs the real `--no-ff` merge into the main tree.
 *    If that still fails (e.g. it would overwrite uncommitted local changes in
 *    the main tree), aborts the merge to restore the main tree and surfaces the
 *    conflict, leaving the worktree + branch in place.
 *  - On a clean merge, removes the worktree and deletes the branch.
 *
 * Never throws — all failures are returned as a MergeResult.
 */
export async function mergeWorktreeBack(
  repoPath: string,
  chatId: string,
  worktreePath: string,
  branch: string,
): Promise<MergeResult> {
  try {
    // 1. Commit the subagent's pending edits onto its branch (no-op if clean).
    await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
    try {
      await execFileAsync(
        "git",
        ["commit", "-m", `subagent ${chatId} work`],
        { cwd: worktreePath },
      );
    } catch {
      // "nothing to commit" — the branch is already up to date / has no edits.
    }

    // 2. The branch the main working tree currently has checked out.
    const { stdout: mainBranchOut } = await execFileAsync(
      "git",
      ["symbolic-ref", "--short", "HEAD"],
      { cwd: repoPath },
    );
    const mainBranch = mainBranchOut.trim();

    // 3. Does the subagent branch carry any commits beyond main?
    const { stdout: countOut } = await execFileAsync(
      "git",
      ["rev-list", "--count", `${mainBranch}..${branch}`],
      { cwd: repoPath },
    );
    const ahead = parseInt(countOut.trim(), 10) || 0;
    if (ahead === 0) {
      await removeWorktree(repoPath, worktreePath, branch);
      return { status: "no_changes", branch };
    }

    // 4. Dry-run the merge — never touches the main working tree.
    const conflict = await detectMergeConflict(repoPath, mainBranch, branch);
    if (conflict) {
      return { status: "conflict", branch, path: worktreePath, detail: conflict };
    }

    // 5. Real merge into the live main working tree.
    try {
      await execFileAsync(
        "git",
        ["merge", "--no-ff", "-m", `Merge subagent ${chatId} (${branch})`, branch],
        { cwd: repoPath },
      );
    } catch (e) {
      // The merge could not complete cleanly against the live tree (most likely
      // it would overwrite uncommitted local changes). Restore the main tree and
      // surface — do NOT clobber. Leaves the worktree + branch intact.
      await execFileAsync("git", ["merge", "--abort"], { cwd: repoPath }).catch(() => {});
      return {
        status: "conflict",
        branch,
        path: worktreePath,
        detail: errMsg(e),
      };
    }

    // 6. Clean merge — tear down the isolated worktree + branch.
    await removeWorktree(repoPath, worktreePath, branch);
    return { status: "merged", branch };
  } catch (e) {
    return { status: "error", detail: errMsg(e) };
  }
}
