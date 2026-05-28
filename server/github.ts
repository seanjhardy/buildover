import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitHubCheck {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
  workflowName: string | null;
}

export interface GitHubFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface GitHubReview {
  id: string;
  author: string;
  state: string;
  body: string;
  submittedAt: string;
}

export interface GitHubLabel {
  name: string;
  color: string;
}

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
  checks: GitHubCheck[];
  files: GitHubFile[];
  reviews: GitHubReview[];
  assignees: string[];
  labels: GitHubLabel[];
  reviewRequests: string[];
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
  // Minimal fields for fast list rendering — full data loaded on demand via getGitHubPR
  const fields = 'number,title,state,isDraft,author,headRefName,baseRefName,url,createdAt,updatedAt';
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
  const fields = 'number,title,state,isDraft,author,headRefName,baseRefName,url,body,createdAt,updatedAt,additions,deletions,reviewDecision,statusCheckRollup,mergeable,comments,files,reviews,assignees,labels,reviewRequests';
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

export async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'gh', ['repo', 'view', '--json', 'defaultBranchRef'],
      { cwd: repoPath }
    );
    const data = JSON.parse(stdout) as { defaultBranchRef?: { name?: string } };
    return data.defaultBranchRef?.name ?? 'main';
  } catch {
    return 'main';
  }
}

export async function createPR(
  repoPath: string,
  title: string,
  body: string,
  head: string,
  base: string,
  draft: boolean,
): Promise<number> {
  const args = ['pr', 'create', '--title', title, '--body', body, '--head', head, '--base', base];
  if (draft) args.push('--draft');
  const { stdout } = await execFileAsync('gh', args, { cwd: repoPath });
  // stdout contains the PR URL, e.g. https://github.com/owner/repo/pull/123
  const match = stdout.trim().match(/\/pull\/(\d+)/);
  if (!match) throw new Error('Could not parse PR number from gh output');
  return parseInt(match[1], 10);
}

function formatPR(raw: Record<string, unknown>): GitHubPR {
  // ---- Status check rollup + individual checks ----
  const rollup = raw.statusCheckRollup as Array<Record<string, unknown>> | string | null;
  let checkState: GitHubPR['statusCheckRollup'] = null;
  let checks: GitHubCheck[] = [];

  if (Array.isArray(rollup) && rollup.length > 0) {
    checks = rollup.map((c) => {
      const isStatus = c['__typename'] === 'StatusContext';
      const rawConclusion = isStatus ? c['state'] : c['conclusion'];
      const conclusion = rawConclusion ? String(rawConclusion).toUpperCase() : null;
      return {
        name: String(isStatus ? (c['context'] ?? 'Status check') : (c['name'] ?? 'Unknown')),
        status: String(isStatus ? 'COMPLETED' : (c['status'] ?? 'COMPLETED')).toUpperCase(),
        conclusion,
        startedAt: c['startedAt'] ? String(c['startedAt']) : null,
        completedAt: c['completedAt'] ? String(c['completedAt']) : null,
        detailsUrl: c['detailsUrl'] ? String(c['detailsUrl']) : (c['targetUrl'] ? String(c['targetUrl']) : null),
        workflowName: c['workflowName'] ? String(c['workflowName']) : null,
      };
    });

    const conclusions = checks.map(c => c.conclusion ?? '');
    if (conclusions.every(s => s === 'SUCCESS')) checkState = 'SUCCESS';
    else if (conclusions.some(s => s === 'FAILURE')) checkState = 'FAILURE';
    else checkState = 'PENDING';
  } else if (typeof rollup === 'string') {
    checkState = rollup as GitHubPR['statusCheckRollup'];
  }

  // ---- Comments ----
  const comments = (raw.comments as Array<{id: string, author: {login: string}, body: string, createdAt: string}> | null) ?? [];

  // ---- Files ----
  const files: GitHubFile[] = ((raw.files as Array<{path: string; additions: number; deletions: number}>) ?? [])
    .map(f => ({ path: f.path, additions: f.additions || 0, deletions: f.deletions || 0 }));

  // ---- Reviews ----
  const rawReviews = (raw.reviews as Array<{id?: string; author?: {login?: string}; state?: string; body?: string; submittedAt?: string}>) ?? [];
  const reviews: GitHubReview[] = rawReviews.map((r, i) => ({
    id: String(r.id ?? i),
    author: r.author?.login ?? 'unknown',
    state: String(r.state ?? 'COMMENTED').toUpperCase(),
    body: String(r.body ?? ''),
    submittedAt: String(r.submittedAt ?? ''),
  }));

  // ---- Assignees ----
  const assignees: string[] = ((raw.assignees as Array<{login: string}>) ?? []).map(a => a.login);

  // ---- Labels ----
  const labels: GitHubLabel[] = ((raw.labels as Array<{name: string; color: string}>) ?? [])
    .map(l => ({ name: l.name, color: l.color }));

  // ---- Review requests ----
  const reviewRequests: string[] = ((raw.reviewRequests as Array<{requestedReviewer?: {login?: string}}>) ?? [])
    .map(r => r.requestedReviewer?.login ?? '')
    .filter(Boolean);

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
    checks,
    files,
    reviews,
    assignees,
    labels,
    reviewRequests,
  };
}

export async function getPRDiff(repoPath: string, number: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'gh', ['pr', 'diff', String(number)],
      { cwd: repoPath }
    );
    return stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isNoGithubRepo(msg)) throw new Error('No GitHub repository found for this project.');
    throw err;
  }
}

export async function editPR(
  repoPath: string,
  number: number,
  options: {
    addReviewers?: string[];
    removeReviewers?: string[];
    addAssignees?: string[];
    removeAssignees?: string[];
    addLabels?: string[];
    removeLabels?: string[];
  }
): Promise<void> {
  const args = ['pr', 'edit', String(number)];
  if (options.addReviewers?.length) { args.push('--add-reviewer'); args.push(options.addReviewers.join(',')); }
  if (options.removeReviewers?.length) { args.push('--remove-reviewer'); args.push(options.removeReviewers.join(',')); }
  if (options.addAssignees?.length) { args.push('--add-assignee'); args.push(options.addAssignees.join(',')); }
  if (options.removeAssignees?.length) { args.push('--remove-assignee'); args.push(options.removeAssignees.join(',')); }
  if (options.addLabels?.length) { args.push('--add-label'); args.push(options.addLabels.join(',')); }
  if (options.removeLabels?.length) { args.push('--remove-label'); args.push(options.removeLabels.join(',')); }
  await execFileAsync('gh', args, { cwd: repoPath });
}

export async function getRepoCollaborators(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'gh', ['api', '/repos/{owner}/{repo}/collaborators', '--jq', '[.[].login]'],
      { cwd: repoPath }
    );
    return JSON.parse(stdout) as string[];
  } catch {
    return [];
  }
}

export async function getRepoLabels(repoPath: string): Promise<GitHubLabel[]> {
  try {
    const { stdout } = await execFileAsync(
      'gh', ['label', 'list', '--json', 'name,color'],
      { cwd: repoPath }
    );
    return JSON.parse(stdout) as GitHubLabel[];
  } catch {
    return [];
  }
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
