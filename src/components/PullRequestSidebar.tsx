import { useEffect, useState } from "react";
import { RefreshCw, ChevronRight, ChevronDown, GitMerge } from "lucide-react";
import { githubApi, type GitHubPR } from "../lib/api.js";

interface Props {
  repoPath: string;
  activePrNumber: number | null;
  onSelectPr: (number: number) => void;
}

function PrStatusDot({ pr }: { pr: GitHubPR }) {
  if (pr.state === 'MERGED') return <span className="pr-status-dot merged" />;
  if (pr.state === 'CLOSED') return <span className="pr-status-dot closed" />;
  if (pr.isDraft) return <span className="pr-status-dot draft" />;
  return <span className="pr-status-dot open" />;
}

export function PullRequestSidebar({ repoPath, activePrNumber, onSelectPr }: Props) {
  const [prs, setPrs] = useState<GitHubPR[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closedExpanded, setClosedExpanded] = useState(false);

  const refresh = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const list = await githubApi.listPRs(repoPath);
      setPrs(list);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('gh') || msg.includes('not found') || msg.includes('command')) {
        setError('GitHub CLI (gh) is not available or not authenticated. Run `gh auth login` to enable pull request features.');
      } else {
        setError(msg);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  const openPrs = prs.filter((p) => p.state === 'OPEN');
  const closedPrs = prs.filter((p) => p.state !== 'OPEN');

  return (
    <div className="pr-sidebar">
      <div className="pr-sidebar-header">
        <span className="pr-sidebar-title">Pull Requests</span>
        <button
          className="sc-icon-btn"
          onClick={() => void refresh()}
          disabled={isLoading}
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={14} className={isLoading ? 'spin' : ''} />
        </button>
      </div>

      <div className="pr-sidebar-body">
        {error && <div className="pr-error">{error}</div>}

        {isLoading && prs.length === 0 && (
          <div className="pr-loading">Loading pull requests...</div>
        )}

        {!isLoading && !error && prs.length === 0 && (
          <div className="pr-empty">No pull requests found</div>
        )}

        {openPrs.length > 0 && (
          <div className="pr-group">
            <div className="pr-group-header" style={{ cursor: 'default' }}>
              Open
              <span className="pr-group-count">{openPrs.length}</span>
            </div>
            {openPrs.map((pr) => (
              <div
                key={pr.number}
                className={`pr-item${activePrNumber === pr.number ? ' active' : ''}`}
                onClick={() => onSelectPr(pr.number)}
              >
                <PrStatusDot pr={pr} />
                <div className="pr-item-body">
                  <div className="pr-item-header-row">
                    <span className="pr-item-number">#{pr.number}</span>
                    <span className="pr-item-title">{pr.title}</span>
                  </div>
                  <div className="pr-item-branch">{pr.headRefName}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {closedPrs.length > 0 && (
          <div className="pr-group">
            <button
              className="pr-group-header"
              onClick={() => setClosedExpanded((v) => !v)}
            >
              {closedExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              Closed / Merged
              <span className="pr-group-count">{closedPrs.length}</span>
            </button>
            {closedExpanded && closedPrs.map((pr) => (
              <div
                key={pr.number}
                className={`pr-item${activePrNumber === pr.number ? ' active' : ''}`}
                onClick={() => onSelectPr(pr.number)}
              >
                <PrStatusDot pr={pr} />
                <div className="pr-item-body">
                  <div className="pr-item-header-row">
                    <span className="pr-item-number">#{pr.number}</span>
                    <span className="pr-item-title">{pr.title}</span>
                  </div>
                  <div className="pr-item-branch">{pr.headRefName}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
