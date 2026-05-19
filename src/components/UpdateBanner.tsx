import { useState } from "react";
import type { SelfUpdateStatus } from "../lib/api.js";

interface UpdateBannerProps {
  status: SelfUpdateStatus;
  isPulling: boolean;
  pullResult: { success: boolean; output: string } | null;
  onPull: () => void;
  onForcePull: () => void;
  onOpenAiChat: () => void;
  onDismiss: () => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function UpdateBanner({
  status,
  isPulling,
  pullResult,
  onPull,
  onForcePull,
  onOpenAiChat,
  onDismiss,
}: UpdateBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const { commits, isDirty, localDiff } = status;
  const count = commits.length;

  // ── Pull-result state (after a successful or failed pull) ──────────────────
  if (pullResult) {
    return (
      <div className={`update-banner update-banner--${pullResult.success ? "success" : "error"}`}>
        <span className="update-banner__icon">{pullResult.success ? "✓" : "✕"}</span>
        <span className="update-banner__text">
          {pullResult.success
            ? "Update applied — tsx watch and Vite HMR are reloading the changes."
            : `Pull failed: ${pullResult.output.split("\n")[0]}`}
        </span>
        <button className="update-banner__dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
      </div>
    );
  }

  // ── Dirty-repo warning ─────────────────────────────────────────────────────
  if (isDirty) {
    return (
      <div className="update-banner update-banner--dirty">
        <span className="update-banner__icon">⚠</span>
        <div className="update-banner__body">
          <span className="update-banner__text">
            {count > 0
              ? `${count} update${count !== 1 ? "s" : ""} available, but you have local changes.`
              : "Update available, but you have local changes."}
          </span>
          <div className="update-banner__actions">
            <button
              className="update-banner__btn update-banner__btn--primary"
              onClick={onOpenAiChat}
              disabled={isPulling}
              title={localDiff ? "Open an AI chat to intelligently rebase your local changes onto main" : "Open an AI chat to help resolve local changes"}
            >
              Fix with AI
            </button>
            <button
              className="update-banner__btn update-banner__btn--danger"
              onClick={onForcePull}
              disabled={isPulling}
              title="Discard all local changes and pull the latest main"
            >
              {isPulling ? "Pulling…" : "Discard & Pull"}
            </button>
          </div>
        </div>
        <button className="update-banner__dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
      </div>
    );
  }

  // ── Normal update available ────────────────────────────────────────────────
  const newestCommit = commits[0];

  return (
    <div className="update-banner update-banner--update">
      <span className="update-banner__icon">↑</span>
      <div className="update-banner__body">
        <div className="update-banner__summary">
          <span className="update-banner__label">
            {count > 0
              ? `${count} new commit${count !== 1 ? "s" : ""} on main`
              : "New commits on main"}
          </span>
          {newestCommit && (
            <span className="update-banner__preview">
              — {newestCommit.message}
              {newestCommit.date && (
                <span className="update-banner__meta"> · {timeAgo(newestCommit.date)}</span>
              )}
            </span>
          )}
          {count > 1 && (
            <button
              className="update-banner__toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "hide" : `+${count - 1} more`}
            </button>
          )}
        </div>

        {expanded && (
          <ul className="update-banner__commits">
            {commits.map((c) => (
              <li key={c.sha} className="update-banner__commit">
                <code className="update-banner__sha">{c.sha}</code>
                <span className="update-banner__commit-msg">{c.message}</span>
                <span className="update-banner__commit-meta">{c.author}</span>
                {c.url && (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="update-banner__commit-link"
                    onClick={(e) => {
                      e.preventDefault();
                      // Open in system browser if running in Electron
                      const shell = (window as unknown as { electronShell?: { openExternal: (url: string) => void } }).electronShell;
                      if (shell) shell.openExternal(c.url);
                      else window.open(c.url, "_blank");
                    }}
                  >
                    ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="update-banner__actions">
        <button
          className="update-banner__btn update-banner__btn--primary"
          onClick={onPull}
          disabled={isPulling}
        >
          {isPulling ? "Pulling…" : "Update"}
        </button>
      </div>
      <button className="update-banner__dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  );
}
