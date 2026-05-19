/**
 * Self-update module: periodically checks GitHub for new commits on `main`
 * and exposes helpers for pulling the latest changes into the running
 * Buildover installation (i.e. the cloned repo the server itself lives in).
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import cron from "node-cron";

const execFileAsync = promisify(execFile);

// Resolve the buildover project root regardless of whether we are running
// from source (server/) or from the compiled bundle (dist-server/).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, "..");

// ── Types ────────────────────────────────────────────────────────────────────

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface SelfUpdateStatus {
  hasUpdate: boolean;
  localSHA: string;
  remoteSHA: string;
  commits: CommitInfo[];
  isDirty: boolean;
  /** Truncated git diff (max 100 KB) when the tree is dirty. */
  localDiff?: string;
  /** Set when the check itself failed (e.g. no network, not a git repo). */
  error?: string;
  checkedAt: string;
}

// ── Internal state ────────────────────────────────────────────────────────────

let cachedStatus: SelfUpdateStatus | null = null;

// ── Git helpers ───────────────────────────────────────────────────────────────

async function getLocalSHA(): Promise<string> {
  const { stdout } = await execFileAsync(
    "git", ["rev-parse", "HEAD"],
    { cwd: APP_ROOT },
  );
  return stdout.trim();
}

async function fetchOriginAndGetRemoteSHA(): Promise<string> {
  try {
    await execFileAsync(
      "git", ["fetch", "origin", "main", "--quiet"],
      { cwd: APP_ROOT },
    );
  } catch {
    // Offline or no remote — fall through and try the cached ref
  }
  const { stdout } = await execFileAsync(
    "git", ["rev-parse", "origin/main"],
    { cwd: APP_ROOT },
  );
  return stdout.trim();
}

async function checkIsDirty(): Promise<boolean> {
  const { stdout } = await execFileAsync(
    "git", ["status", "--porcelain"],
    { cwd: APP_ROOT },
  );
  return stdout.trim().length > 0;
}

async function getLocalDiff(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git", ["diff", "HEAD"],
      { cwd: APP_ROOT, maxBuffer: 4 * 1024 * 1024 },
    );
    // Cap at 100 KB so we don't bloat the API response
    return stdout.slice(0, 100_000);
  } catch {
    return "";
  }
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

interface GitHubRepo { owner: string; repo: string }

async function parseGitHubRemote(): Promise<GitHubRepo | null> {
  try {
    const { stdout } = await execFileAsync(
      "git", ["remote", "get-url", "origin"],
      { cwd: APP_ROOT },
    );
    const url = stdout.trim();
    // Handles:
    //   https://github.com/owner/repo.git
    //   git@github.com:owner/repo.git
    //   personal:owner/repo.git  (custom SSH alias — common for personal repos)
    const ghMatch = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (ghMatch) return { owner: ghMatch[1]!, repo: ghMatch[2]! };
    // Generic fallback: extract owner/repo from the last colon/slash path segment
    const aliasMatch = url.match(/[:/]([^/:]+)\/([^/.]+)(?:\.git)?$/);
    if (aliasMatch) return { owner: aliasMatch[1]!, repo: aliasMatch[2]! };
  } catch { /* no remote configured */ }
  return null;
}

async function fetchCommitsFromGitHub(
  ghRepo: GitHubRepo,
  localSHA: string,
  remoteSHA: string,
): Promise<CommitInfo[]> {
  const url = `https://api.github.com/repos/${ghRepo.owner}/${ghRepo.repo}/compare/${localSHA}...${remoteSHA}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "buildover-self-update/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const data = (await res.json()) as {
    commits: {
      sha: string;
      commit: { message: string; author: { name: string; date: string } };
      html_url: string;
    }[];
  };
  return data.commits.reverse().map((c) => ({
    sha: c.sha.slice(0, 7),
    message: c.commit.message.split("\n")[0]!,
    author: c.commit.author.name,
    date: c.commit.author.date,
    url: c.html_url,
  }));
}

async function fetchCommitsLocal(
  localSHA: string,
  remoteSHA: string,
): Promise<CommitInfo[]> {
  const SEP = "\x1f";
  const fmt = ["%h", "%s", "%an", "%aI"].join(SEP);
  const { stdout } = await execFileAsync(
    "git",
    ["log", `${localSHA}..${remoteSHA}`, `--format=${fmt}`, "--no-merges"],
    { cwd: APP_ROOT },
  );
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", message = "", author = "", date = ""] = line.split(SEP);
      return { sha, message, author, date, url: "" };
    });
}

async function getCommitsBetween(
  localSHA: string,
  remoteSHA: string,
): Promise<CommitInfo[]> {
  if (localSHA === remoteSHA) return [];
  const ghRepo = await parseGitHubRemote();
  if (ghRepo) {
    try {
      return await fetchCommitsFromGitHub(ghRepo, localSHA, remoteSHA);
    } catch {
      // GitHub API unavailable — fall through to local git log
    }
  }
  return fetchCommitsLocal(localSHA, remoteSHA);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Run a full update check (fetch + compare + commit list). Caches the result. */
export async function checkForUpdates(): Promise<SelfUpdateStatus> {
  try {
    const [localSHA, dirty] = await Promise.all([
      getLocalSHA(),
      checkIsDirty(),
    ]);
    const remoteSHA = await fetchOriginAndGetRemoteSHA();
    const hasUpdate = localSHA !== remoteSHA;
    const [commits, localDiff] = await Promise.all([
      hasUpdate ? getCommitsBetween(localSHA, remoteSHA) : Promise.resolve([]),
      dirty ? getLocalDiff() : Promise.resolve(""),
    ]);
    cachedStatus = {
      hasUpdate,
      localSHA,
      remoteSHA,
      commits,
      isDirty: dirty,
      localDiff: localDiff || undefined,
      checkedAt: new Date().toISOString(),
    };
    return cachedStatus;
  } catch (err) {
    cachedStatus = {
      hasUpdate: false,
      localSHA: "unknown",
      remoteSHA: "unknown",
      commits: [],
      isDirty: false,
      error: err instanceof Error ? err.message : String(err),
      checkedAt: new Date().toISOString(),
    };
    return cachedStatus;
  }
}

/**
 * Run `git pull origin main`.
 * When `force` is true, first resets the working tree and removes untracked
 * files so the pull always succeeds (discards local changes).
 */
export async function pullLatestMain(
  force = false,
): Promise<{ success: boolean; output: string }> {
  try {
    if (force) {
      await execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd: APP_ROOT });
      await execFileAsync("git", ["clean", "-fd"], { cwd: APP_ROOT });
    }
    const { stdout } = await execFileAsync(
      "git", ["pull", "origin", "main"],
      { cwd: APP_ROOT },
    );
    // Invalidate cache so the next REST poll reflects the updated state
    cachedStatus = null;
    return { success: true, output: stdout };
  } catch (err) {
    return {
      success: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Return the most recent cached check result (may be null before first check). */
export function getSelfUpdateStatus(): SelfUpdateStatus | null {
  return cachedStatus;
}

/** The absolute path of the Buildover installation directory. */
export function getSelfAppRoot(): string {
  return APP_ROOT;
}

/**
 * Start the background cron checker.
 * Runs an initial check 10 s after startup, then every 10 minutes.
 */
export function startSelfUpdateChecker(): void {
  setTimeout(() => {
    checkForUpdates().catch((err) =>
      console.warn("[self-update] initial check failed:", err instanceof Error ? err.message : err),
    );
  }, 10_000);

  cron.schedule("*/10 * * * *", () => {
    checkForUpdates().catch((err) =>
      console.warn("[self-update] check failed:", err instanceof Error ? err.message : err),
    );
  });

  console.log("[self-update] Checker started — polls every 10 minutes.");
}
