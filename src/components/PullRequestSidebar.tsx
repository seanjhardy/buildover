import { useEffect, useRef, useState } from "react";
import { RefreshCw, ChevronRight, ChevronDown } from "lucide-react";
import { githubApi, type GitHubPR } from "../lib/api.js";

interface Props {
  repoPath: string;
  activePrNumber: number | null;
  /** Called with the full PR object when a PR is selected. */
  onSelectPr: (pr: GitHubPR) => void;
  /** When true the sidebar is hidden (display:none) but stays mounted. */
  hidden?: boolean;
}

function PrStatusDot({ pr }: { pr: GitHubPR }) {
  if (pr.state === 'MERGED') return <span className="pr-status-dot merged" />;
  if (pr.state === 'CLOSED') return <span className="pr-status-dot closed" />;
  if (pr.isDraft) return <span className="pr-status-dot draft" />;
  return <span className="pr-status-dot open" />;
}

/** Skeleton placeholder shown during the very first load. */
function PrSkeletonRows() {
  return (
    <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {[70, 85, 55].map((w, i) => (
        <span key={i} className="skeleton-line" style={{ width: `${w}%`, height: 10, display: 'block' }} />
      ))}
    </div>
  );
}

export function PullRequestSidebar({ repoPath, activePrNumber, onSelectPr, hidden }: Props) {
  const [prs, setPrs] = useState<GitHubPR[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closedExpanded, setClosedExpanded] = useState(false);

  const refresh = async (showSpinner = true) => {
    if (showSpinner) setIsLoading(true);
    setError(null);
    try {
      const list = await githubApi.listPRs(repoPath);
      setPrs(list);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isGhMissing = msg.includes('ENOENT') || msg.toLowerCase().includes('command not found');
      const isGhUnauthed = msg.toLowerCase().includes('not logged') || msg.toLowerCase().includes('not authenticated') || msg.toLowerCase().includes('gh auth login');
      if (isGhMissing || isGhUnauthed) {
        setError('GitHub CLI (gh) is not available or not authenticated. Run `gh auth login` to enable pull request features.');
      } else {
        setError(msg);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Initial load once per repoPath, regardless of visibility.
  const hasLoadedRef = useRef(false);
  useEffect(() => {
    hasLoadedRef.current = false;
  }, [repoPath]);

  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    void refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  // When the sidebar becomes visible after being hidden, do a background
  // refresh so any stale data is updated without a loading flash.
  const wasHiddenRef = useRef(hidden);
  useEffect(() => {
    const becameVisible = wasHiddenRef.current && !hidden;
    wasHiddenRef.current = hidden;
    if (becameVisible && prs.length > 0) {
      void refresh(false); // background refresh, no spinner
    }
  }, [hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const openPrs = prs.filter((p) => p.state === 'OPEN');
  const closedPrs = prs.filter((p) => p.state !== 'OPEN');
  const showSkeleton = isLoading && prs.length === 0;

  return (
    <div className="pr-sidebar" style={hidden ? { display: 'none' } : undefined}>
      <div className="pr-sidebar-header">
        <span className="pr-sidebar-title">Pull Requests</span>
        <button
          className="sc-icon-btn"
          onClick={() => void refresh(true)}
          disabled={isLoading}
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={14} className={isLoading ? 'spin' : ''} />
        </button>
      </div>

      <div className="pr-sidebar-body">
        {error && <div className="pr-error">{error}</div>}

        {showSkeleton && <PrSkeletonRows />}

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
                onClick={() => onSelectPr(pr)}
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
                onClick={() => onSelectPr(pr)}
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
