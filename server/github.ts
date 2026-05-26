import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitHubPR {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  reviewDecision: string | null;
  statusCheckRollup: 'SUCCESS' | 'FAILURE' | 'PENDING' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  comments: GitHubComment[];
}

export interface GitHubComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

/** Returns true when gh can't find a GitHub counterpart for the local repo. */
function isNoGithubRepo(msg: string): boolean {
  return (
    msg.includes('Could not resolve to a Repository') ||
    msg.includes('no GitHub remote') ||
    msg.includes('no git remote')
  );
}

export async function listGitHubPRs(repoPath: string): Promise<GitHubPR[]> {
  const fields = 'number,title,state,isDraft,author,headRefName,baseRefName,url,body,createdAt,updatedAt,additions,deletions,reviewDecision,statusCheckRollup,mergeable';
  try {
    const { stdout } = await execFileAsync(
      'gh', ['pr', 'list', '--state', 'all', '--limit', '50', '--json', fields],
      { cwd: repoPath }
    );
    const raw = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return raw.map(formatPR);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Repo has no corresponding GitHub repository — treat as no PRs rather than an error
    if (isNoGithubRepo(msg)) return [];
    throw err;
  }
}

export async function getGitHubPR(repoPath: string, number: number): Promise<GitHubPR> {
  const fields = 'number,title,state,isDraft,author,headRefName,baseRefName,url,body,createdAt,updatedAt,additions,deletions,reviewDecision,statusCheckRollup,mergeable,comments';
  try {
    const { stdout } = await execFileAsync(
      'gh', ['pr', 'view', String(number), '--json', fields],
      { cwd: repoPath }
    );
    const raw = JSON.parse(stdout) as Record<string, unknown>;
    return formatPR(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isNoGithubRepo(msg)) throw new Error('No GitHub repository found for this project.');
    throw err;
  }
}

export async function mergePR(repoPath: string, number: number, method: 'merge' | 'squash' | 'rebase'): Promise<void> {
  const flag = method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge';
  await execFileAsync('gh', ['pr', 'merge', String(number), flag, '--auto'], { cwd: repoPath });
}

export async function addPRComment(repoPath: string, number: number, body: string): Promise<void> {
  await execFileAsync('gh', ['pr', 'comment', String(number), '--body', body], { cwd: repoPath });
}

export async function updatePRBranch(repoPath: string, number: number): Promise<void> {
  await execFileAsync('gh', ['pr', 'update-branch', String(number)], { cwd: repoPath });
}

function formatPR(raw: Record<string, unknown>): GitHubPR {
  const rollup = raw.statusCheckRollup as Array<{conclusion?: string; state?: string}> | string | null;
  let checkState: GitHubPR['statusCheckRollup'] = null;
  if (Array.isArray(rollup) && rollup.length > 0) {
    if (rollup.every(c => (c.conclusion || c.state) === 'SUCCESS')) checkState = 'SUCCESS';
    else if (rollup.some(c => (c.conclusion || c.state) === 'FAILURE')) checkState = 'FAILURE';
    else checkState = 'PENDING';
  } else if (typeof rollup === 'string') {
    checkState = rollup as GitHubPR['statusCheckRollup'];
  }

  const comments = (raw.comments as Array<{id: string, author: {login: string}, body: string, createdAt: string}> | null) ?? [];

  return {
    number: raw.number as number,
    title: raw.title as string,
    state: raw.state as GitHubPR['state'],
    isDraft: raw.isDraft as boolean,
    author: (raw.author as {login: string})?.login ?? 'unknown',
    headRefName: raw.headRefName as string,
    baseRefName: raw.baseRefName as string,
    url: raw.url as string,
    body: (raw.body as string) ?? '',
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
    additions: (raw.additions as number) ?? 0,
    deletions: (raw.deletions as number) ?? 0,
    reviewDecision: (raw.reviewDecision as string | null) ?? null,
    statusCheckRollup: checkState,
    mergeable: (raw.mergeable as GitHubPR['mergeable']) ?? 'UNKNOWN',
    comments: comments.map(c => ({
      id: String(c.id),
      author: c.author?.login ?? 'unknown',
      body: c.body,
      createdAt: c.createdAt,
    })),
  };
}

// Get changed files from git status --porcelain
export interface ChangedFile {
  path: string;
  staged: boolean;
  unstaged: boolean;
  statusCode: string;
}

export async function getStatusFiles(repoPath: string): Promise<ChangedFile[]> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoPath });
  const files: ChangedFile[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const path = line.slice(3).trim();
    files.push({
      path,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ' || x === '?',
      statusCode: x + y,
    });
  }
  return files;
}
