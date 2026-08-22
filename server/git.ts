import { execFile } from "node:child_process";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { isAbsolute, join } from "node:path";

const execFileAsync = promisify(execFile);

export interface GitStatus {
  currentBranch: string;
  branches: string[];
  ahead: number;
  behind: number;
  isDirty: boolean;
  hasUpstream: boolean;
  isDetached: boolean;
}

export async function getGitStatus(repoPath: string): Promise<GitStatus> {
  // Current branch name — may fail in detached HEAD state
  let currentBranch = "HEAD";
  let isDetached = false;
  try {
    const { stdout: branchOut } = await execFileAsync(
      "git",
      ["symbolic-ref", "--short", "HEAD"],
      { cwd: repoPath },
    );
    currentBranch = branchOut.trim();
  } catch {
    // Detached HEAD — try to get the short commit hash instead
    isDetached = true;
    try {
      const { stdout: hashOut } = await execFileAsync(
        "git",
        ["rev-parse", "--short", "HEAD"],
        { cwd: repoPath },
      );
      currentBranch = hashOut.trim();
    } catch {
      // No commits at all (fresh repo) — leave as "HEAD"
    }
  }

  // All local branch names
  let branches: string[] = [];
  try {
    const { stdout: branchListOut } = await execFileAsync(
      "git",
      ["branch", "--format=%(refname:short)"],
      { cwd: repoPath },
    );
    branches = branchListOut
      .trim()
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);
  } catch {
    // Fresh repo with no branches — leave empty
  }

  // Ahead / behind relative to upstream (may fail if no upstream is set or detached)
  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  if (!isDetached) {
    try {
      const { stdout: countsOut } = await execFileAsync(
        "git",
        ["rev-list", "--left-right", "--count", "@{u}...HEAD"],
        { cwd: repoPath },
      );
      const parts = countsOut.trim().split(/\s+/);
      behind = parseInt(parts[0] ?? "0", 10) || 0;
      ahead = parseInt(parts[1] ?? "0", 10) || 0;
      hasUpstream = true;
    } catch {
      // No upstream configured — leave ahead/behind as 0, hasUpstream as false
    }
  }

  // Working-tree dirtiness
  let isDirty = false;
  try {
    const { stdout: statusOut } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd: repoPath },
    );
    isDirty = statusOut.trim().length > 0;
  } catch {
    // Unable to determine dirtiness — leave as false
  }

  return { currentBranch, branches, ahead, behind, isDirty, hasUpstream, isDetached };
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
  await execFileAsync("git", ["push", "-u", "origin", "HEAD"], { cwd: repoPath });
}

export async function gitForcePush(repoPath: string): Promise<void> {
  await execFileAsync("git", ["push", "--force-with-lease", "-u", "origin", "HEAD"], { cwd: repoPath });
}

export async function gitPull(repoPath: string): Promise<void> {
  await execFileAsync("git", ["pull"], { cwd: repoPath });
}

export async function gitFetch(repoPath: string): Promise<void> {
  await execFileAsync("git", ["fetch", "--all", "--prune"], { cwd: repoPath });
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
    // --topo-order ensures parents always follow all their children in the
    // output — a hard requirement for the lane-assignment algorithm in the
    // frontend.  Without it git can emit a parent before some of its children
    // when branches diverge, which breaks lane tracking and produces phantom
    // connections.
    ["log", "--all", "--topo-order", "--parents", `--format=${format}`, "--decorate=full", `-n`, String(limit)],
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

  // Absolute paths are outside the repo (toRelPath fell back to the abs path
  // when cwd didn't match). Git errors fatally if any out-of-repo absolute
  // path is included — which causes the entire command to return nothing.
  // Filter them out; they'll simply have no stats entry.
  relPaths = relPaths.filter((p) => !p.startsWith("/"));

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

export async function gitCherryPick(repoPath: string, hash: string): Promise<void> {
  await execFileAsync("git", ["cherry-pick", hash], { cwd: repoPath });
}

export async function gitRevert(repoPath: string, hash: string): Promise<void> {
  await execFileAsync("git", ["revert", "--no-edit", hash], { cwd: repoPath });
}

export async function gitMerge(repoPath: string, ref: string): Promise<void> {
  await execFileAsync("git", ["merge", ref], { cwd: repoPath });
}

export async function gitRebase(repoPath: string, onto: string): Promise<void> {
  await execFileAsync("git", ["rebase", onto], { cwd: repoPath });
}

export async function gitReset(
  repoPath: string,
  hash: string,
  mode: "soft" | "mixed" | "hard" = "mixed",
): Promise<void> {
  await execFileAsync("git", ["reset", `--${mode}`, hash], { cwd: repoPath });
}

export async function gitDeleteBranch(repoPath: string, name: string): Promise<void> {
  await execFileAsync("git", ["branch", "-d", name], { cwd: repoPath });
}

export interface CommitDiffFile {
  filename: string;
  added: number;
  removed: number;
}

/** Returns the list of files changed in a specific commit with +/- stats. */
export async function gitCommitDiffStat(
  repoPath: string,
  hash: string,
): Promise<CommitDiffFile[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["show", "--numstat", "--format=", hash],
    { cwd: repoPath },
  );
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return {
        filename: parts[2] ?? "",
        added:    parts[0] === "-" ? 0 : parseInt(parts[0] ?? "0", 10) || 0,
        removed:  parts[1] === "-" ? 0 : parseInt(parts[1] ?? "0", 10) || 0,
      };
    })
    .filter((f) => f.filename);
}

/**
 * Returns the full working-tree diff suitable for commit message generation.
 * Combines staged + unstaged changes vs HEAD (git diff HEAD). Falls back to
 * the staged-only diff on a fresh repo with no commits yet.
 * Truncated to 16 KB so the prompt stays small.
 */
export async function gitGetWorkingDiff(repoPath: string): Promise<string> {
  // git diff HEAD shows working tree vs HEAD, including both staged & unstaged
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD"],
      { cwd: repoPath, maxBuffer: 512 * 1024 },
    );
    if (stdout.trim()) return stdout.slice(0, 16_000);
  } catch { /* no HEAD yet — fresh repo */ }

  // Fresh repo: staged vs empty (initial commit pending)
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--cached"],
      { cwd: repoPath, maxBuffer: 512 * 1024 },
    );
    if (stdout.trim()) return stdout.slice(0, 16_000);
  } catch { /* ignore */ }

  return "";
}

/** Returns the raw unified diff for a single file in a specific commit. */
export async function gitCommitFileDiff(
  repoPath: string,
  hash: string,
  file: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["show", "--unified=3", hash, "--", file],
    { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

export interface FileDiffResult {
  /** Sorted new-file line numbers that are additions */
  addedLines: number[];
  /**
   * Removed line groups keyed by the new-file line number they appear *after*.
   * e.g. after: 3 means the deleted lines should be shown between lines 3 and 4.
   * after: 0 means they appear before line 1.
   * Each entry is the text content of one deleted line.
   */
  removedGroups: { after: number; lines: string[] }[];
}

/**
 * Returns per-line diff data for a single file relative to HEAD.
 * - Tracks both added and removed line positions in the new file.
 * - Falls back to staged diff if working-tree diff is empty.
 * - Falls back to treating the whole file as new if the file is untracked.
 * - Returns empty arrays for deleted files or binary files.
 */
export async function gitFileDiff(
  repoPath: string,
  relPath: string,
): Promise<FileDiffResult> {
  // Parse a unified diff into added line numbers and removed line groups.
  // removedGroups: each group has `after` = the new-file line number it follows
  // (0 = before line 1) and `lines` = the actual deleted text (without the leading "-").
  function parseDiff(diffText: string): FileDiffResult {
    const addedSet = new Set<number>();
    // Map from `after` index → accumulated deleted lines
    const removedMap = new Map<number, string[]>();

    let newLine = 0;

    for (const raw of diffText.split("\n")) {
      // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const hunkMatch = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        newLine = parseInt(hunkMatch[1]!, 10) - 1;
        continue;
      }

      if (raw.startsWith("+") && !raw.startsWith("+++")) {
        newLine++;
        addedSet.add(newLine);
      } else if (raw.startsWith("-") && !raw.startsWith("---")) {
        // Collect the text of the deleted line (strip leading "-")
        const text = raw.slice(1);
        const after = newLine; // deleted after this new-file line (0 = before line 1)
        if (!removedMap.has(after)) removedMap.set(after, []);
        removedMap.get(after)!.push(text);
      } else if (!raw.startsWith("\\")) {
        if (!raw.startsWith("diff ") && !raw.startsWith("index ") &&
            !raw.startsWith("--- ") && !raw.startsWith("+++ ")) {
          newLine++;
        }
      }
    }

    const removedGroups = Array.from(removedMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([after, lines]) => ({ after, lines }));

    return {
      addedLines: Array.from(addedSet).sort((a, b) => a - b),
      removedGroups,
    };
  }

  // Try: working-tree vs HEAD
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--", relPath],
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
    );
    if (stdout.trim()) return parseDiff(stdout);
  } catch { /* no HEAD yet */ }

  // Try: staged vs HEAD (new repo with initial commit pending)
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--cached", "--", relPath],
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
    );
    if (stdout.trim()) return parseDiff(stdout);
  } catch { /* ignore */ }

  // Try: untracked file — treat every line as added
  try {
    const { stdout: lsOut } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", relPath],
      { cwd: repoPath },
    );
    if (lsOut.trim()) {
      const absPath = join(repoPath, relPath);
      const content = await readFile(absPath, "utf8").catch(() => "");
      const lineCount = content ? content.split("\n").length : 0;
      return {
        addedLines: Array.from({ length: lineCount }, (_, i) => i + 1),
        removedGroups: [],
      };
    }
  } catch { /* ignore */ }

  return { addedLines: [], removedGroups: [] };
}

/**
 * Derive the target directory name from a git remote URL. Handles the common
 * forms: `https://github.com/org/repo(.git)`, `git@github.com:org/repo(.git)`,
 * and SSH-alias URLs like `worldover:org/repo(.git)`.
 */
export function repoNameFromUrl(url: string): string {
  const cleaned = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const seg = cleaned.split(/[/:]/).filter(Boolean).pop() ?? "";
  return seg || "repo";
}

/**
 * Rewrite an `https://host/owner/repo(.git)` URL to its scp-like SSH form
 * `git@host:owner/repo.git` so that SSH keys are used for authentication.
 * URLs that are already SSH/scp-like (or an ssh-config host alias) are returned
 * unchanged.
 */
function toSshCloneUrl(url: string): string {
  const m = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return url;
  return `git@${m[1]}:${m[2]}.git`;
}

/**
 * List private SSH key files under `~/.ssh` — identified as any file that has a
 * matching `.pub` sibling. Used to try each of the user's keys in turn when
 * cloning, so multi-account setups work without hardcoding which key belongs to
 * which host/org.
 */
async function listSshPrivateKeys(): Promise<string[]> {
  const sshDir = join(homedir(), ".ssh");
  const entries = await readdir(sshDir).catch(() => [] as string[]);
  const names = new Set(entries);
  return entries
    .filter((e) => e.endsWith(".pub"))
    .map((e) => e.slice(0, -4))
    .filter((name) => names.has(name))
    .map((name) => join(sshDir, name));
}

/**
 * Initialise a git repo in `repoPath`, optionally staging everything and making
 * the first commit. Pass `message = null` to init without committing.
 */
export async function gitInitWithCommit(
  repoPath: string,
  message: string | null,
): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoPath });
  if (message === null) return;
  await execFileAsync("git", ["add", "-A"], { cwd: repoPath });
  // --allow-empty so an empty project still gets a first commit to push.
  await execFileAsync("git", ["commit", "--allow-empty", "-m", message], {
    cwd: repoPath,
  });
}

export async function gitSetRemote(
  repoPath: string,
  name: string,
  url: string,
): Promise<void> {
  // A template copy can carry no remotes at all, so `set-url` may fail; add is
  // the normal path and set-url covers a remote that already exists.
  await execFileAsync("git", ["remote", "add", name, url], { cwd: repoPath }).catch(
    () => execFileAsync("git", ["remote", "set-url", name, url], { cwd: repoPath }),
  );
}

/**
 * Push the current branch to origin, setting upstream. Mirrors `cloneRepo`'s
 * SSH handling: for an SSH remote we try each of the user's keys in turn, since
 * with multiple GitHub accounts on one machine the default identity is often not
 * the one that owns the new repo.
 */
export async function gitPushInitial(repoPath: string): Promise<void> {
  const { stdout: remoteUrl } = await execFileAsync(
    "git",
    ["remote", "get-url", "origin"],
    { cwd: repoPath },
  );
  const isSsh = !/^https?:\/\//i.test(remoteUrl.trim());
  const keys = isSsh ? await listSshPrivateKeys() : [];
  const attempts: (string | null)[] = keys.length > 0 ? keys : [null];

  let lastError: unknown;
  for (const key of attempts) {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (key) {
      env.GIT_SSH_COMMAND = `ssh -o IdentitiesOnly=yes -o BatchMode=yes -i "${key}"`;
    }
    try {
      await execFileAsync("git", ["push", "-u", "origin", "HEAD"], {
        cwd: repoPath,
        env,
      });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Clone a git repository into `parentDir`, using the repo name derived from the
 * URL as the destination folder. Returns the absolute destination path.
 *
 * For SSH clones we try each of the user's SSH keys in sequence (forcing a
 * single identity per attempt via `IdentitiesOnly=yes`) until one succeeds.
 * This makes multi-account setups work when the user pastes a normal GitHub URL
 * — GitHub authenticates as whichever account a key belongs to, so a key
 * lacking repo access fails and we move on to the next key.
 *
 * `BatchMode=yes` / `GIT_TERMINAL_PROMPT=0` ensure a key without valid access
 * fails fast instead of hanging on an interactive credential prompt.
 */
export async function cloneRepo(url: string, parentDir: string): Promise<string> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) throw new Error("A repository URL is required");
  if (!parentDir || !isAbsolute(parentDir)) {
    throw new Error("A destination folder is required");
  }
  const parent = await stat(parentDir).catch(() => null);
  if (!parent || !parent.isDirectory()) {
    throw new Error(`Not a directory: ${parentDir}`);
  }

  const dest = join(parentDir, repoNameFromUrl(trimmedUrl));
  const existing = await stat(dest).catch(() => null);
  if (existing) {
    throw new Error(`Destination already exists: ${dest}`);
  }

  const cloneUrl = toSshCloneUrl(trimmedUrl);
  const isSsh = !/^https?:\/\//i.test(cloneUrl);
  // For SSH clones, try each key in turn; otherwise a single plain attempt.
  const keys = isSsh ? await listSshPrivateKeys() : [];
  const attempts: (string | null)[] = keys.length > 0 ? keys : [null];

  let lastError: unknown;
  for (const key of attempts) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    };
    if (key) {
      env.GIT_SSH_COMMAND = `ssh -o IdentitiesOnly=yes -o BatchMode=yes -i "${key}"`;
    }
    try {
      await execFileAsync("git", ["clone", cloneUrl, dest], { env });
      return dest;
    } catch (err) {
      lastError = err;
      // git may leave a partial destination behind on failure; clear it so the
      // next key's attempt starts clean.
      await rm(dest, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
