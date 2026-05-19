import { useState } from "react";
import {
  Sparkles,
  Info,
  Check,
  X,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
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

// Strip conventional commit prefixes so bullets read naturally.
// "feat: add dark mode" → "Add dark mode"
// "fix(chat): broken scroll" → "Fixed broken scroll"
function formatCommitMessage(msg: string): string {
  const conventional = msg.match(/^(feat|fix|chore|refactor|docs|style|test|perf|ci|build)(?:\([^)]*\))?!?:\s*(.+)/i);
  if (conventional) {
    const [, type, body] = conventional;
    const prefix = /^fix/i.test(type) ? "Fixed" : null;
    const cleaned = body.charAt(0).toUpperCase() + body.slice(1);
    return prefix ? `${prefix} ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}` : cleaned;
  }
  return msg.charAt(0).toUpperCase() + msg.slice(1);
}

const MAX_VISIBLE = 4;

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
  const { commits, isDirty } = status;
  const count = commits.length;
  const visibleCommits = expanded ? commits : commits.slice(0, MAX_VISIBLE);
  const hiddenCount = count - MAX_VISIBLE;

  // ── Post-pull result ───────────────────────────────────────────────────────
  if (pullResult) {
    return (
      <div className={`update-card update-card--${pullResult.success ? "success" : "error"}`}>
        <div className="update-card__header">
          <div className="update-card__icon-wrap">
            {pullResult.success
              ? <Check size={12} strokeWidth={2.5} />
              : <X size={12} strokeWidth={2.5} />}
          </div>
          <div className="update-card__header-text">
            <span className="update-card__title">
              {pullResult.success ? "You're all set!" : "Update Failed"}
            </span>
            <span className="update-card__subtitle">
              {pullResult.success
                ? "Buildover is reloading with your new features."
                : pullResult.output.split("\n")[0]}
            </span>
          </div>
          <button className="update-card__dismiss" onClick={onDismiss} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  // ── Dirty-repo warning ─────────────────────────────────────────────────────
  if (isDirty) {
    return (
      <div className="update-card update-card--dirty">
        <div className="update-card__header">
          <div className="update-card__icon-wrap">
            <Info size={12} strokeWidth={2.5} />
          </div>
          <div className="update-card__header-text">
            <span className="update-card__title">Update Ready ✦</span>
            <span className="update-card__subtitle">
              {count > 0
                ? `${count} ${count === 1 ? "improvement" : "improvements"} waiting to land`
                : "Fresh improvements waiting to land"}
            </span>
          </div>
          <button className="update-card__dismiss" onClick={onDismiss} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
        <div className="update-card__body">
          <p className="update-card__desc">
            You have some local changes — no problem! Let AI merge everything together, or discard and start fresh.
          </p>
        </div>
        <div className="update-card__actions">
          <button
            className="update-card__btn update-card__btn--ghost"
            onClick={onForcePull}
            disabled={isPulling}
            title="Discard all local changes and pull the latest main"
          >
            {isPulling ? "Pulling…" : "Discard & Pull"}
          </button>
          <button
            className="update-card__btn update-card__btn--primary"
            onClick={onOpenAiChat}
            disabled={isPulling}
            title="Open an AI chat to intelligently rebase your local changes onto main"
          >
            Fix with AI
          </button>
        </div>
      </div>
    );
  }

  // ── Normal update available ────────────────────────────────────────────────
  return (
    <div className="update-card update-card--update">
      <div className="update-card__header">
        <div className="update-card__icon-wrap">
          <Sparkles size={12} strokeWidth={2} />
        </div>
        <div className="update-card__header-text">
          <span className="update-card__title">What's New</span>
          <span className="update-card__subtitle">
            {count === 1
              ? "A fresh update just landed"
              : `${count} fresh updates just landed`}
          </span>
        </div>
        <button className="update-card__dismiss" onClick={onDismiss} aria-label="Dismiss">
          <X size={13} />
        </button>
      </div>

      {count > 0 && (
        <div className="update-card__body">
          <ul className="update-card__whatsnew">
            {visibleCommits.map((c) => (
              <li key={c.sha} className="update-card__whatsnew-item">
                <span className="update-card__whatsnew-dot" />
                <span className="update-card__whatsnew-text">
                  {formatCommitMessage(c.message)}
                </span>
              </li>
            ))}
          </ul>

          {count > MAX_VISIBLE && (
            <button
              className="update-card__toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded
                ? <><ChevronUp size={11} /> Show less</>
                : <><ChevronDown size={11} /> {hiddenCount} more {hiddenCount === 1 ? "change" : "changes"}</>}
            </button>
          )}
        </div>
      )}

      <div className="update-card__actions">
        <button
          className="update-card__btn update-card__btn--primary"
          onClick={onPull}
          disabled={isPulling}
        >
          {isPulling ? "Updating…" : "Update Now →"}
        </button>
      </div>
    </div>
  );
}
