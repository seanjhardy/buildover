import { useEffect, useState } from "react";
import { GitPullRequest, ArrowRight } from "lucide-react";
import { gitApi, githubApi, type GitHubPR } from "../lib/api.js";

interface Props {
  repoPath: string;
  onCreated: (pr: GitHubPR) => void;
  onCancel: () => void;
}

function branchToTitle(branch: string): string {
  return branch
    .replace(/^(feature|fix|bugfix|hotfix|chore|feat|docs|refactor|test)\//i, '')
    .replace(/[-_]/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function CreatePrForm({ repoPath, onCreated, onCancel }: Props) {
  const [branches, setBranches] = useState<string[]>([]);
  const [head, setHead] = useState('');
  const [base, setBase] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track if the user has manually edited the title so we stop auto-filling it
  const [titleTouched, setTitleTouched] = useState(false);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const [status, defaultBranch] = await Promise.all([
          gitApi.getStatus(repoPath),
          githubApi.getDefaultBranch(repoPath),
        ]);
        setBranches(status.branches);
        const headBranch = status.currentBranch;
        const baseBranch = defaultBranch;
        setHead(headBranch);
        setBase(baseBranch);
        setTitle(branchToTitle(headBranch));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, [repoPath]);

  const handleHeadChange = (newHead: string) => {
    setHead(newHead);
    if (!titleTouched) {
      setTitle(branchToTitle(newHead));
    }
  };

  const handleSubmit = async () => {
    if (!title.trim() || head === base || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const pr = await githubApi.createPR(repoPath, title.trim(), body, head, base, draft);
      onCreated(pr);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsSubmitting(false);
    }
  };

  const canSubmit = !isLoading && !isSubmitting && title.trim().length > 0 && head !== base;

  return (
    <div className="create-pr-container">
      <div className="create-pr-card">

        {/* Header */}
        <div className="create-pr-header">
          <GitPullRequest size={18} />
          <h2 className="create-pr-heading">Open a pull request</h2>
        </div>

        {/* Branch selectors */}
        <div className="create-pr-branches">
          <div className="create-pr-branch-row">
            <div className="create-pr-branch-group">
              <span className="create-pr-branch-label">base</span>
              <select
                className="create-pr-branch-select"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                disabled={isLoading || isSubmitting}
              >
                {branches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>

            <ArrowRight size={14} className="create-pr-arrow" />

            <div className="create-pr-branch-group">
              <span className="create-pr-branch-label">compare</span>
              <select
                className="create-pr-branch-select"
                value={head}
                onChange={(e) => handleHeadChange(e.target.value)}
                disabled={isLoading || isSubmitting}
              >
                {branches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
          </div>

          {head === base && !isLoading && (
            <p className="create-pr-branch-warning">
              The base and compare branches must be different.
            </p>
          )}
        </div>

        {/* Form body */}
        <div className="create-pr-body">
          <div className="create-pr-field">
            <label className="create-pr-field-label" htmlFor="pr-title">Title</label>
            <input
              id="pr-title"
              className="create-pr-field-input"
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }}
              placeholder="Pull request title"
              disabled={isSubmitting}
              autoFocus
            />
          </div>

          <div className="create-pr-field">
            <label className="create-pr-field-label" htmlFor="pr-body">
              Description
              <span className="create-pr-optional"> — optional</span>
            </label>
            <textarea
              id="pr-body"
              className="create-pr-field-textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Describe your changes…"
              rows={6}
              disabled={isSubmitting}
            />
          </div>

          <label className="create-pr-draft-row">
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
              disabled={isSubmitting}
            />
            <span>Create as draft pull request</span>
          </label>

          {error && <div className="pr-error">{error}</div>}

          <div className="create-pr-actions">
            <button
              className="create-pr-cancel-btn"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              className="create-pr-submit-btn"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
            >
              {isSubmitting
                ? 'Creating…'
                : draft
                  ? 'Create draft pull request'
                  : 'Create pull request'}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
