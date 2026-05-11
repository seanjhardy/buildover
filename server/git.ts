import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitStatus {
  currentBranch: string;
  branches: string[];
  ahead: number;
  behind: number;
  isDirty: boolean;
}

export async function getGitStatus(repoPath: string): Promise<GitStatus> {
  // Current branch name
  const { stdout: branchOut } = await execFileAsync(
    "git",
    ["symbolic-ref", "--short", "HEAD"],
    { cwd: repoPath },
  );
  const currentBranch = branchOut.trim();

  // All local branch names
  const { stdout: branchListOut } = await execFileAsync(
    "git",
    ["branch", "--format=%(refname:short)"],
    { cwd: repoPath },
  );
  const branches = branchListOut
    .trim()
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean);

  // Ahead / behind relative to upstream (may fail if no upstream is set)
  let ahead = 0;
  let behind = 0;
  try {
    const { stdout: countsOut } = await execFileAsync(
      "git",
      ["rev-list", "--left-right", "--count", "@{u}...HEAD"],
      { cwd: repoPath },
    );
    const parts = countsOut.trim().split(/\s+/);
    behind = parseInt(parts[0] ?? "0", 10) || 0;
    ahead = parseInt(parts[1] ?? "0", 10) || 0;
  } catch {
    // No upstream configured — silently leave ahead/behind as 0
  }

  // Working-tree dirtiness
  const { stdout: statusOut } = await execFileAsync(
    "git",
    ["status", "--porcelain"],
    { cwd: repoPath },
  );
  const isDirty = statusOut.trim().length > 0;

  return { currentBranch, branches, ahead, behind, isDirty };
}

export async function gitCheckout(
  repoPath: string,
  branch: string,
): Promise<void> {
  await execFileAsync("git", ["checkout", branch], { cwd: repoPath });
}

export async function gitCommit(
  repoPath: string,
  message: string,
): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", message], { cwd: repoPath });
}

export async function gitPush(repoPath: string): Promise<void> {
  await execFileAsync("git", ["push"], { cwd: repoPath });
}

export async function gitForcePush(repoPath: string): Promise<void> {
  await execFileAsync("git", ["push", "--force-with-lease"], { cwd: repoPath });
}

export async function gitPull(repoPath: string): Promise<void> {
  await execFileAsync("git", ["pull"], { cwd: repoPath });
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorDate: string; // ISO-ish date string
  refs: string; // e.g. "HEAD -> main, origin/main"
  parents: string[]; // full parent SHA hashes (empty for root commit)
}

export interface GitLogResult {
  commits: GitCommit[];
  currentBranch: string;
}

/**
 * Fetches the full cross-branch commit graph using `git log --all --parents`.
 * Returns every reachable commit so the frontend can render a proper DAG with
 * parallel lanes, merge curves, and per-branch colouring — like VS Code Git Graph.
 */
export async function gitLog(
  repoPath: string,
  limit = 150,
): Promise<GitLogResult> {
  // Unit-separator (0x1f) is safe inside commit messages — never appears in git output
  const SEP = "\x1f";
  // %P = space-separated parent hashes; %D = ref decoration string
  const format = [`%H`, `%h`, `%s`, `%an`, `%aI`, `%D`, `%P`].join(SEP);

  const { stdout } = await execFileAsync(
    "git",
    ["log", "--all", "--parents", `--format=${format}`, "--decorate=full", `-n`, String(limit)],
    { cwd: repoPath },
  );

  const commits: GitCommit[] = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(SEP);
      const parentsRaw = (parts[6] ?? "").trim();
      return {
        hash: parts[0] ?? "",
        shortHash: parts[1] ?? "",
        subject: parts[2] ?? "",
        authorName: parts[3] ?? "",
        authorDate: parts[4] ?? "",
        refs: parts[5] ?? "",
        parents: parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [],
      };
    });

  // Resolve the currently checked-out branch name
  let currentBranch = "HEAD";
  try {
    const { stdout: b } = await execFileAsync(
      "git",
      ["symbolic-ref", "--short", "HEAD"],
      { cwd: repoPath },
    );
    currentBranch = b.trim();
  } catch {
    // detached HEAD — leave as "HEAD"
  }

  return { commits, currentBranch };
}

export async function gitCreateBranch(
  repoPath: string,
  name: string,
  fromHash?: string,
): Promise<void> {
  const args = fromHash
    ? ["checkout", "-b", name, fromHash]
    : ["checkout", "-b", name];
  await execFileAsync("git", args, { cwd: repoPath });
}

export interface FileDiffStat {
  added: number;
  removed: number;
}

/**
 * Returns line-level diff stats for each requested file relative to HEAD.
 * Combines unstaged and staged (--cached) changes so you see the full picture.
 * Files that are brand-new (untracked) are counted by line number via wc -l.
 * If a file is not in git at all the entry is omitted from the result.
 */
export async function gitDiffStat(
  repoPath: string,
  relPaths: string[],
): Promise<Record<string, FileDiffStat>> {
  if (relPaths.length === 0) return {};

  const stats: Record<string, FileDiffStat> = {};

  // Helper: parse `git diff --numstat` output lines into the stats map.
  // Binary files produce "-" for their counts — treat those as 0 explicitly.
  function parseNumstat(out: string) {
    for (const line of out.trim().split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const added = parts[0] === "-" ? 0 : parseInt(parts[0] ?? "0", 10) || 0;
      const removed = parts[1] === "-" ? 0 : parseInt(parts[1] ?? "0", 10) || 0;
      const file = parts[2]?.trim() ?? "";
      if (!file) continue;
      stats[file] = { added, removed };
    }
  }

  // Primary: compare working tree directly against HEAD — this covers both
  // staged and unstaged changes as a single combined view (no double-counting).
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--numstat", "--", ...relPaths],
      { cwd: repoPath },
    );
    parseNumstat(stdout);
  } catch {
    // No commits yet (initial repo) — fall back to staged-only diff
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--numstat", "--cached", "--", ...relPaths],
        { cwd: repoPath },
      );
      parseNumstat(stdout);
    } catch { /* not a git repo or other error — skip */ }
  }

  // For files that still have no entry, check if they are untracked (new files).
  // Count all their lines as "added".
  const missing = relPaths.filter((p) => !stats[p]);
  for (const rel of missing) {
    try {
      // Check if the file is untracked
      const { stdout: lsOut } = await execFileAsync(
        "git",
        ["ls-files", "--others", "--exclude-standard", "--", rel],
        { cwd: repoPath },
      );
      if (lsOut.trim()) {
        // Untracked — count lines via wc -l
        const { stdout: wcOut } = await execFileAsync(
          "wc",
          ["-l", rel],
          { cwd: repoPath },
        );
        const lineCount = parseInt(wcOut.trim().split(/\s+/)[0] ?? "0", 10) || 0;
        stats[rel] = { added: lineCount, removed: 0 };
      }
    } catch { /* ignore */ }
  }

  return stats;
}
