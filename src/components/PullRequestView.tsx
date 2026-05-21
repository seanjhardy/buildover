import { useEffect, useRef, useState } from "react";
import { GitBranch, ArrowRight, Check, X, AlertTriangle, Info, ChevronDown, MessageSquare } from "lucide-react";
import { githubApi, type GitHubPR } from "../lib/api.js";

interface Props {
  repoPath: string;
  prNumber: number | null;
  onClose?: () => void;
}

type CircleType = 'success' | 'error' | 'warning' | 'info';

function StatusCircle({ type }: { type: CircleType }) {
  const colors: Record<CircleType, string> = {
    success: '#238636',
    error: '#da3633',
    warning: '#6e7681',
    info: '#1f6feb',
  };
  const icons: Record<CircleType, React.ReactNode> = {
    success: <Check size={14} color="white" />,
    error: <X size={14} color="white" />,
    warning: <AlertTriangle size={12} color="white" />,
    info: <Info size={14} color="white" />,
  };
  return (
    <div style={{
      width: 24,
      height: 24,
      borderRadius: '50%',
      background: colors[type],
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    }}>
      {icons[type]}
    </div>
  );
}

function prStateLabel(pr: GitHubPR): string {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.isDraft) return 'draft';
  return 'open';
}

function renderDescription(body: string) {
  if (!body.trim()) return <span className="pr-description-empty">No description provided.</span>;
  return body.split('\n').map((line, i) => (
    <span key={i}>{line}<br /></span>
  ));
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

type MergeMethod = 'squash' | 'merge' | 'rebase';

const MERGE_OPTIONS: Array<{ method: MergeMethod; label: string; desc: string }> = [
  { method: 'squash', label: 'Squash and merge', desc: 'Combine all commits into one' },
  { method: 'merge', label: 'Create a merge commit', desc: 'All commits from this branch will be added' },
  { method: 'rebase', label: 'Rebase and merge', desc: 'Rebase all commits onto the base branch' },
];

export function PullRequestView({ repoPath, prNumber }: Props) {
  const [pr, setPr] = useState<GitHubPR | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bypass, setBypass] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>('squash');
  const [showMergeDropdown, setShowMergeDropdown] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isUpdatingBranch, setIsUpdatingBranch] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prNumber === null) {
      setPr(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    githubApi.getPR(repoPath, prNumber)
      .then((data) => {
        setPr(data);
        setIsLoading(false);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('gh') || msg.includes('not found') || msg.includes('command')) {
          setError('GitHub CLI (gh) is not available or not authenticated. Run `gh auth login` to enable pull request features.');
        } else {
          setError(msg);
        }
        setIsLoading(false);
      });
  }, [repoPath, prNumber]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showMergeDropdown) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowMergeDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMergeDropdown]);

  if (prNumber === null) {
    return (
      <div className="pr-view">
        <div className="pr-view-empty">
          <MessageSquare size={40} style={{ opacity: 0.2 }} />
          <span className="pr-view-empty-text">Select a pull request to view details</span>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="pr-view">
        <div className="pr-view-loading">Loading pull request...</div>
      </div>
    );
  }

  if (error && !pr) {
    return (
      <div className="pr-view">
        <div className="pr-view-error">{error}</div>
      </div>
    );
  }

  if (!pr) return null;

  const stateLabel = prStateLabel(pr);

  // Review check
  let reviewCircle: CircleType = 'warning';
  let reviewLabel = 'Review required';
  let reviewSub = 'At least one approving review is required';
  if (pr.reviewDecision === 'APPROVED') {
    reviewCircle = 'success';
    reviewLabel = 'Review approved';
    reviewSub = 'This pull request has been reviewed and approved';
  } else if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    reviewCircle = 'error';
    reviewLabel = 'Changes requested';
    reviewSub = 'Reviewers have requested changes';
  }

  // CI checks
  let ciCircle: CircleType = 'warning';
  let ciLabel = 'Checks pending';
  let ciSub = 'Some checks have not completed yet';
  if (pr.statusCheckRollup === 'SUCCESS') {
    ciCircle = 'success';
    ciLabel = 'All checks passed';
    ciSub = 'All status checks have passed';
  } else if (pr.statusCheckRollup === 'FAILURE') {
    ciCircle = 'error';
    ciLabel = 'Some checks failed';
    ciSub = 'Some required status checks have failed';
  } else if (pr.statusCheckRollup === null) {
    ciCircle = 'info';
    ciLabel = 'No checks';
    ciSub = 'No status checks are required for this repository';
  }

  const isConflicting = pr.mergeable === 'CONFLICTING';
  const canMerge = !isConflicting && pr.state === 'OPEN' && !pr.isDraft;

  const selectedMergeOption = MERGE_OPTIONS.find(o => o.method === mergeMethod) ?? MERGE_OPTIONS[0]!;

  const handleMerge = async () => {
    setIsMerging(true);
    try {
      await githubApi.mergePR(repoPath, pr.number, mergeMethod);
      // Refresh PR after merge
      const updated = await githubApi.getPR(repoPath, pr.number);
      setPr(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsMerging(false);
    }
  };

  const handleUpdateBranch = async () => {
    setIsUpdatingBranch(true);
    try {
      await githubApi.updateBranch(repoPath, pr.number);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsUpdatingBranch(false);
    }
  };

  const handleSubmitComment = async () => {
    if (!commentText.trim()) return;
    setIsSubmittingComment(true);
    try {
      await githubApi.addComment(repoPath, pr.number, commentText.trim());
      setCommentText('');
      // Refresh to get new comment
      const updated = await githubApi.getPR(repoPath, pr.number);
      setPr(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmittingComment(false);
    }
  };

  return (
    <div className="pr-view">
      <div className="pr-view-header">
        <div className="pr-view-title-row">
          <span className="pr-view-title">
            {pr.title}
            <span className="pr-view-number"> #{pr.number}</span>
          </span>
          <span className={`pr-status-badge ${stateLabel}`}>
            {stateLabel.charAt(0).toUpperCase() + stateLabel.slice(1)}
          </span>
        </div>
        <div className="pr-view-branch-row">
          <GitBranch size={13} />
          <span className="pr-branch-name">{pr.headRefName}</span>
          <ArrowRight size={12} />
          <span className="pr-branch-name">{pr.baseRefName}</span>
          {pr.additions > 0 && (
            <span style={{ marginLeft: 8, color: '#40c057', fontSize: 11 }}>+{pr.additions}</span>
          )}
          {pr.deletions > 0 && (
            <span style={{ color: '#e03131', fontSize: 11 }}>-{pr.deletions}</span>
          )}
        </div>
      </div>

      <div className="pr-view-body">
        {error && <div className="pr-view-error">{error}</div>}

        {/* Description */}
        <div className="pr-description">
          {renderDescription(pr.body)}
        </div>

        {/* Merge requirements card */}
        <div className="pr-checks-card">
          <div className="pr-checks-title">Merge requirements</div>

          {pr.reviewDecision !== null && (
            <div className="pr-check-row">
              <StatusCircle type={reviewCircle} />
              <div className="pr-check-text">
                <div className="pr-check-label">{reviewLabel}</div>
                <div className="pr-check-sublabel">{reviewSub}</div>
              </div>
            </div>
          )}

          <div className="pr-check-row">
            <StatusCircle type={ciCircle} />
            <div className="pr-check-text">
              <div className="pr-check-label">{ciLabel}</div>
              <div className="pr-check-sublabel">{ciSub}</div>
            </div>
          </div>

          {isConflicting && (
            <div className="pr-check-row">
              <StatusCircle type="error" />
              <div className="pr-check-text">
                <div className="pr-check-label">This branch has conflicts that must be resolved</div>
                <div className="pr-check-sublabel">Use the command line to resolve conflicts</div>
              </div>
            </div>
          )}

          {pr.mergeable === 'UNKNOWN' && (
            <div className="pr-check-row">
              <StatusCircle type="warning" />
              <div className="pr-check-text">
                <div className="pr-check-label">Mergeability is unknown</div>
                <div className="pr-check-sublabel">Check back later for merge status</div>
              </div>
              <button
                className="pr-check-action"
                onClick={() => void handleUpdateBranch()}
                disabled={isUpdatingBranch}
              >
                {isUpdatingBranch ? 'Updating...' : 'Update branch'}
              </button>
            </div>
          )}

          {pr.mergeable === 'MERGEABLE' && pr.reviewDecision === 'APPROVED' && pr.statusCheckRollup === 'SUCCESS' && (
            <div className="pr-check-row">
              <StatusCircle type="success" />
              <div className="pr-check-text">
                <div className="pr-check-label">This branch has no conflicts with the base branch</div>
                <div className="pr-check-sublabel">Merging can be performed automatically</div>
              </div>
            </div>
          )}
        </div>

        {/* Merge section */}
        {pr.state === 'OPEN' && (
          <div className="pr-merge-section">
            <label className="pr-bypass-row">
              <input
                type="checkbox"
                checked={bypass}
                onChange={(e) => setBypass(e.target.checked)}
              />
              <span className="pr-bypass-label">
                Merge without waiting for requirements to be met (bypass rules)
              </span>
            </label>

            <div className="pr-merge-buttons">
              {(canMerge || bypass) ? (
                <div className="pr-merge-split" style={{ position: 'relative' }} ref={dropdownRef}>
                  <button
                    className="pr-merge-btn"
                    onClick={() => void handleMerge()}
                    disabled={isMerging}
                  >
                    {isMerging ? 'Merging...' : `Enable auto-merge (${selectedMergeOption.method})`}
                  </button>
                  <button
                    className="pr-merge-chevron"
                    aria-label="More merge options"
                    onClick={() => setShowMergeDropdown((v) => !v)}
                  >
                    <ChevronDown size={14} />
                  </button>
                  {showMergeDropdown && (
                    <div className="pr-merge-dropdown">
                      {MERGE_OPTIONS.map((opt) => (
                        <button
                          key={opt.method}
                          className={`pr-merge-option${mergeMethod === opt.method ? ' selected' : ''}`}
                          onClick={() => {
                            setMergeMethod(opt.method);
                            setShowMergeDropdown(false);
                          }}
                        >
                          <span className="pr-merge-option-label">{opt.label}</span>
                          <span className="pr-merge-option-desc">{opt.desc}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="pr-merge-split">
                  <button className="pr-merge-btn" disabled>
                    Merge pull request
                  </button>
                  <button className="pr-merge-chevron" disabled aria-label="More merge options">
                    <ChevronDown size={14} />
                  </button>
                </div>
              )}
              <span className="pr-merge-cmd-line">
                You can also merge this with the command line.
              </span>
            </div>
          </div>
        )}

        {/* Comments section */}
        {(pr.comments.length > 0 || pr.state === 'OPEN') && (
          <div className="pr-comments-section">
            <div className="pr-section-title">
              <MessageSquare size={14} />
              Comments
              {pr.comments.length > 0 && (
                <span className="pr-comments-count">{pr.comments.length}</span>
              )}
            </div>

            {pr.comments.length > 0 && (
              <div className="pr-comments-list">
                {pr.comments.map((comment) => (
                  <div key={comment.id} className="pr-comment">
                    <div className="pr-comment-header">
                      <span className="pr-comment-author">{comment.author}</span>
                      <span className="pr-comment-time">{formatDate(comment.createdAt)}</span>
                    </div>
                    <div className="pr-comment-body">{comment.body}</div>
                  </div>
                ))}
              </div>
            )}

            {pr.state === 'OPEN' && (
              <div className="pr-comment-form">
                <textarea
                  className="pr-comment-textarea"
                  placeholder="Leave a comment..."
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                />
                <div className="pr-comment-submit-row">
                  <button
                    className="pr-comment-submit-btn"
                    onClick={() => void handleSubmitComment()}
                    disabled={!commentText.trim() || isSubmittingComment}
                  >
                    {isSubmittingComment ? 'Submitting...' : 'Comment'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="pr-footer">
          {pr.isDraft && pr.state === 'OPEN' && (
            <button className="pr-footer-link">
              Mark as ready for review
            </button>
          )}
          {!pr.isDraft && pr.state === 'OPEN' && (
            <button className="pr-footer-link">
              Still in progress? Convert to draft
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
