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

export async function gitPull(repoPath: string): Promise<void> {
  await execFileAsync("git", ["pull"], { cwd: repoPath });
}
