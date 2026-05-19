import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, ChevronsUp } from "lucide-react";
import { gitApi, type GitStatus } from "../lib/api.js";

interface Props {
  repoPath: string;
  onOpenGraph?: () => void;
}

const EXPANDED_STORAGE_KEY = "buildover.gitPanel.expanded";

function loadExpandedPreference(): boolean {
  try {
    const stored = localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch { /* ignore */ }
  return true;
}

export function GitPanel({ repoPath, onOpenGraph }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [opLoading, setOpLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(loadExpandedPreference);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [showCommitInput, setShowCommitInput] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const branchPickerRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await gitApi.getStatus(repoPath);
      setStatus(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    }
  }, [repoPath]);

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_STORAGE_KEY, String(expanded));
    } catch { /* ignore */ }
  }, [expanded]);

  // Initial load + polling while expanded
  useEffect(() => {
    if (!expanded) return;
    setLoading(true);
    refreshStatus().finally(() => setLoading(false));
    const id = setInterval(() => void refreshStatus(), 10_000);
    return () => clearInterval(id);
  }, [expanded, refreshStatus]);

  // Reset when repo changes
  useEffect(() => {
    setStatus(null);
    setError(null);
    setShowBranchPicker(false);
    setShowCommitInput(false);
    setCommitMessage("");
  }, [repoPath]);

  // Close branch picker on outside click
  useEffect(() => {
    if (!showBranchPicker) return;
    const handler = (e: MouseEvent) => {
      if (
        branchPickerRef.current &&
        !branchPickerRef.current.contains(e.target as Node)
      ) {
        setShowBranchPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showBranchPicker]);

  const handleCheckout = async (branch: string) => {
    setShowBranchPicker(false);
    setOpLoading("checkout");
    setError(null);
    try {
      await gitApi.checkout(repoPath, branch);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpLoading(null);
    }
  };

  const handleCommit = async () => {
    if (!commitMessage.trim()) return;
    setOpLoading("commit");
    setError(null);
    try {
      await gitApi.commit(repoPath, commitMessage.trim());
      setCommitMessage("");
      setShowCommitInput(false);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpLoading(null);
    }
  };

  const handlePush = async () => {
    setOpLoading("push");
    setError(null);
    try {
      await gitApi.push(repoPath);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpLoading(null);
    }
  };

  const handleForcePush = async () => {
    setOpLoading("push");
    setError(null);
    try {
      await gitApi.forcePush(repoPath);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpLoading(null);
    }
  };

  const handlePull = async () => {
    setOpLoading("pull");
    setError(null);
    try {
      await gitApi.pull(repoPath);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpLoading(null);
    }
  };

  const busy = opLoading !== null;

  return (
    <div className="git-panel">
      <button
        type="button"
        className="git-panel-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="git-panel-caret">{expanded ? "▾" : "▸"}</span>
        <span className="git-panel-label">Git</span>
        {status && (
          <span className="git-branch-badge">{status.currentBranch}</span>
        )}
      </button>

      {expanded && (
        <div className="git-panel-body">
          {loading && !status && (
            <div className="git-status-row git-muted">Loading…</div>
          )}

          {error && (
            <div className="git-error" title={error}>
              {error.length > 80 ? error.slice(0, 80) + "…" : error}
            </div>
          )}

          {status && (
            <>
              {/* Branch switcher + graph button */}
              <div className="git-branch-row-wrap">
                <div className="git-branch-row" ref={branchPickerRef}>
                  <button
                    type="button"
                    className="git-branch-btn"
                    onClick={() => setShowBranchPicker((v) => !v)}
                    disabled={busy}
                  >
                    <span className="git-icon">⎇</span>
                    <span className="git-branch-name">{status.currentBranch}</span>
                    <span className="git-chevron">
                      {opLoading === "checkout" ? "…" : "▾"}
                    </span>
                  </button>

                  {showBranchPicker && (
                    <div className="git-branch-list">
                      {status.branches.map((b) => (
                        <button
                          key={b}
                          type="button"
                          className={`git-branch-item${b === status.currentBranch ? " active" : ""}`}
                          onClick={() => void handleCheckout(b)}
                        >
                          {b === status.currentBranch && (
                            <span className="git-branch-check">✓ </span>
                          )}
                          {b}
                        </button>
                      ))}
                      {status.branches.length === 0 && (
                        <div className="git-branch-item git-muted">
                          No branches found
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Open full-page git graph */}
                <button
                  type="button"
                  className="git-tree-btn"
                  onClick={() => onOpenGraph?.()}
                  title="Open git graph"
                >
                  <GitBranch size={13} />
                </button>
              </div>

              {/* Commit */}
              <div className="git-section">
                {showCommitInput ? (
                  <div className="git-commit-form">
                    <input
                      className="git-commit-input"
                      type="text"
                      placeholder="Commit message…"
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleCommit();
                        if (e.key === "Escape") {
                          setShowCommitInput(false);
                          setCommitMessage("");
                        }
                      }}
                      autoFocus
                      disabled={opLoading === "commit"}
                    />
                    <div className="git-commit-actions">
                      <button
                        type="button"
                        className="git-action-btn git-action-primary"
                        onClick={() => void handleCommit()}
                        disabled={!commitMessage.trim() || opLoading === "commit"}
                      >
                        {opLoading === "commit" ? "Committing…" : "Commit"}
                      </button>
                      <button
                        type="button"
                        className="git-action-btn"
                        onClick={() => {
                          setShowCommitInput(false);
                          setCommitMessage("");
                        }}
                        disabled={opLoading === "commit"}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="git-action-btn"
                    onClick={() => setShowCommitInput(true)}
                    disabled={!status.isDirty || busy}
                    title={status.isDirty ? "Stage all & commit" : "Nothing to commit"}
                  >
                    <span className="git-icon">✓</span>
                    Commit
                    {status.isDirty && (
                      <span className="git-dirty-dot" title="Uncommitted changes" />
                    )}
                  </button>
                )}
              </div>

              {/* Push / Pull */}
              <div className="git-sync-row">
                <button
                  type="button"
                  className="git-action-btn git-sync-btn"
                  onClick={() => void handlePull()}
                  disabled={busy}
                  title="Pull from origin"
                >
                  <span className="git-icon">↓</span>
                  {opLoading === "pull" ? "Pulling…" : "Pull"}
                  {status.behind > 0 && (
                    <span className="git-badge">{status.behind}</span>
                  )}
                </button>
                <div className="git-push-split">
                  <button
                    type="button"
                    className="git-action-btn git-push-main"
                    onClick={() => void handlePush()}
                    disabled={busy}
                    title="Push to origin"
                  >
                    <span className="git-icon">↑</span>
                    {opLoading === "push" ? "Pushing…" : "Push"}
                    {status.ahead > 0 && (
                      <span className="git-badge">{status.ahead}</span>
                    )}
                  </button>
                  <div className="git-force-push-wrap">
                    <button
                      type="button"
                      className="git-action-btn git-force-push-btn"
                      onClick={() => void handleForcePush()}
                      disabled={busy}
                      aria-label="Force push (--force-with-lease)"
                    >
                      <ChevronsUp size={12} />
                    </button>
                    <div className="git-force-push-tooltip">
                      Force push
                      <span className="git-force-push-tooltip-sub">--force-with-lease</span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
