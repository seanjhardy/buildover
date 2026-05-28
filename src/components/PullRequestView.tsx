import { useEffect, useRef, useState } from "react";
import {
  ArrowRight, Check, X, AlertTriangle, ChevronDown,
  MessageSquare, FileCode, Settings, Clock, Minus,
  GitMerge,
} from "lucide-react";
import { githubApi, type GitHubPR, type GitHubCheck, type GitHubLabel, type GitHubReview } from "../lib/api.js";

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  repoPath: string;
  prNumber: number | null;
  initialPr?: GitHubPR | null;
  onClose?: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function avatarColor(login: string): string {
  let hash = 0;
  for (const ch of login) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  const palette = ['#238636','#1f6feb','#9c36b5','#da3633','#d29922','#e85b46','#0969da','#2ea043'];
  return palette[Math.abs(hash) % palette.length]!;
}

/** Shows GitHub profile photo with initials fallback */
function UserAvatar({ login, size = 32 }: { login: string; size?: number }) {
  const [err, setErr] = useState(false);
  const style = { width: size, height: size, flexShrink: 0 as const, borderRadius: '50%' };

  if (!err) {
    return (
      <img
        className="pr-user-avatar"
        src={`https://github.com/${login}.png?size=${size * 2}`}
        alt={login}
        title={login}
        style={style}
        onError={() => setErr(true)}
      />
    );
  }
  return (
    <div
      className="pr-user-avatar"
      style={{ ...style, background: avatarColor(login), fontSize: Math.round(size * 0.38) }}
      title={login}
    >
      {login.slice(0, 2).toUpperCase()}
    </div>
  );
}

function formatRelativeDate(iso: string): string {
  try {
    const date = new Date(iso);
    const diff = Date.now() - date.getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

function prStateLabel(pr: GitHubPR): string {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.isDraft) return 'draft';
  return 'open';
}

// ─── Check run icon ───────────────────────────────────────────────────────────

function CheckIcon({ check }: { check: GitHubCheck }) {
  const c = check.conclusion;
  const s = check.status;
  if (s === 'IN_PROGRESS' || s === 'QUEUED') return <Clock size={14} className="ci-pending" />;
  if (c === 'SUCCESS') return <Check size={14} className="ci-success" />;
  if (c === 'FAILURE') return <X size={14} className="ci-failure" />;
  if (c === 'SKIPPED' || c === 'NEUTRAL' || c === 'CANCELLED') return <Minus size={14} className="ci-neutral" />;
  return <AlertTriangle size={14} className="ci-pending" />;
}

function rollupIcon(rollup: GitHubPR['statusCheckRollup']) {
  if (rollup === 'SUCCESS') return <Check size={16} className="ci-success" />;
  if (rollup === 'FAILURE') return <X size={16} className="ci-failure" />;
  return <Clock size={16} className="ci-pending" />;
}

// ─── Comment bubble ───────────────────────────────────────────────────────────

function CommentBubble({ author, time, body, isDescription = false }: {
  author: string; time: string; body: string; isDescription?: boolean;
}) {
  return (
    <div className="pr-bubble">
      <div className="pr-bubble-header">
        <span className="pr-bubble-author">{author}</span>
        <span className="pr-bubble-action">{isDescription ? 'created this pull request' : 'commented'}</span>
        <span className="pr-bubble-time">{formatRelativeDate(time)}</span>
      </div>
      <div className="pr-bubble-body">
        {body.trim()
          ? body.split('\n').map((line, i) => <span key={i}>{line}<br /></span>)
          : <span className="pr-bubble-empty">No description provided.</span>}
      </div>
    </div>
  );
}

function ReviewBubble({ review }: { review: GitHubReview }) {
  const stateColor: Record<string, string> = {
    APPROVED: '#40c057', CHANGES_REQUESTED: '#e03131', DISMISSED: 'var(--app-secondary-foreground)',
  };
  const stateLabel: Record<string, string> = {
    APPROVED: 'approved these changes', CHANGES_REQUESTED: 'requested changes',
    DISMISSED: 'dismissed a review', COMMENTED: 'reviewed',
  };
  const color = stateColor[review.state] ?? 'var(--app-secondary-foreground)';
  const label = stateLabel[review.state] ?? 'reviewed';
  return (
    <div className="pr-bubble">
      <div className="pr-bubble-header">
        <span className="pr-bubble-author">{review.author}</span>
        <span className="pr-bubble-action" style={{ color }}>{label}</span>
        <span className="pr-bubble-time">{formatRelativeDate(review.submittedAt)}</span>
      </div>
      {review.body.trim() && (
        <div className="pr-bubble-body">
          {review.body.split('\n').map((line, i) => <span key={i}>{line}<br /></span>)}
        </div>
      )}
    </div>
  );
}

// ─── Timeline row ─────────────────────────────────────────────────────────────
// The row stretches so the connector always fills from avatar-bottom to
// the next row's avatar-top, making a continuous vertical line.

function TimelineRow({ login, children, hasConnector = true, small = false }: {
  login?: string; children: React.ReactNode; hasConnector?: boolean; small?: boolean;
}) {
  return (
    <div className="pr-timeline-row">
      <div className="pr-timeline-left">
        {login
          ? <UserAvatar login={login} size={small ? 24 : 32} />
          : <div className={`pr-timeline-dot${small ? ' pr-timeline-dot--sm' : ''}`} />}
        {hasConnector && <div className="pr-timeline-connector" />}
      </div>
      <div className={`pr-timeline-right${small ? ' pr-timeline-right--sm' : ''}`}>
        {children}
      </div>
    </div>
  );
}

// ─── Checks card ─────────────────────────────────────────────────────────────

function ChecksCard({ pr }: { pr: GitHubPR }) {
  const [expanded, setExpanded] = useState(true);
  const { checks, statusCheckRollup: rollup } = pr;
  const failing = checks.filter(c => c.conclusion === 'FAILURE').length;
  const passing = checks.filter(c => c.conclusion === 'SUCCESS').length;
  const pending = checks.filter(c => c.status !== 'COMPLETED').length;

  const summary = [
    failing > 0 && `${failing} failing`,
    pending > 0 && `${pending} pending`,
    passing > 0 && `${passing} successful`,
  ].filter(Boolean).join(', ');

  return (
    <div className="pr-checks-card2">
      <div className="pr-checks-card2-header" onClick={() => setExpanded(v => !v)}>
        <div className={`pr-checks-rollup pr-checks-rollup--${rollup?.toLowerCase() ?? 'pending'}`}>
          {rollupIcon(rollup)}
        </div>
        <div className="pr-checks-card2-text">
          <div className="pr-checks-card2-title">
            {rollup === 'SUCCESS' ? 'All checks passed' : rollup === 'FAILURE' ? 'Some checks failed' : 'Checks pending'}
          </div>
          <div className="pr-checks-card2-sub">{summary} {summary ? '·' : ''} {checks.length} check{checks.length !== 1 ? 's' : ''}</div>
        </div>
        <ChevronDown size={15} className={`pr-checks-chevron${expanded ? ' open' : ''}`} />
      </div>
      {expanded && (
        <div className="pr-checks-runs">
          {checks.map((check, i) => (
            <div key={i} className="pr-check-run">
              <CheckIcon check={check} />
              <span className="pr-check-run-name">{check.name}</span>
              {check.workflowName && check.workflowName !== check.name && (
                <span className="pr-check-run-wf"> · {check.workflowName}</span>
              )}
              {check.detailsUrl && (
                <a href={check.detailsUrl} target="_blank" rel="noopener noreferrer" className="pr-check-run-link"
                  onClick={e => e.stopPropagation()}>Details</a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Merge section ────────────────────────────────────────────────────────────

type MergeMethod = 'squash' | 'merge' | 'rebase';
const MERGE_OPTIONS: Array<{ method: MergeMethod; label: string; desc: string }> = [
  { method: 'squash', label: 'Squash and merge', desc: 'Combine all commits into one' },
  { method: 'merge', label: 'Create a merge commit', desc: 'All commits from this branch will be added' },
  { method: 'rebase', label: 'Rebase and merge', desc: 'Rebase all commits onto the base branch' },
];

function MergeSection({ pr, repoPath, onMerged }: { pr: GitHubPR; repoPath: string; onMerged: () => void }) {
  const [bypass, setBypass] = useState(false);
  const [method, setMethod] = useState<MergeMethod>('squash');
  const [showDrop, setShowDrop] = useState(false);
  const [merging, setMerging] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showDrop) return;
    const h = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setShowDrop(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showDrop]);

  const conflicting = pr.mergeable === 'CONFLICTING';
  const canMerge = !conflicting && !pr.isDraft;
  const sel = MERGE_OPTIONS.find(o => o.method === method) ?? MERGE_OPTIONS[0]!;

  const doMerge = async () => {
    setMerging(true); setError(null);
    try { await githubApi.mergePR(repoPath, pr.number, method); onMerged(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setMerging(false); }
  };

  const doUpdate = async () => {
    setUpdating(true); setError(null);
    try { await githubApi.updateBranch(repoPath, pr.number); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setUpdating(false); }
  };

  return (
    <div className="pr-merge-area">
      {error && <div className="pr-merge-error">{error}</div>}
      {conflicting && (
        <div className="pr-merge-banner pr-merge-banner--warn">
          <AlertTriangle size={13} />
          <span>This branch has conflicts that must be resolved</span>
          <button className="pr-merge-update-btn" onClick={() => void doUpdate()} disabled={updating}>
            {updating ? 'Updating…' : 'Update branch'}
          </button>
        </div>
      )}
      {pr.isDraft && (
        <div className="pr-merge-banner pr-merge-banner--draft">Draft — not ready for review</div>
      )}
      <div className="pr-merge-actions">
        <label className="pr-bypass-row">
          <input type="checkbox" checked={bypass} onChange={e => setBypass(e.target.checked)} />
          <span>Bypass branch protection rules</span>
        </label>
        <div className="pr-merge-split" ref={dropRef}>
          <button className="pr-merge-btn" disabled={(!canMerge && !bypass) || merging} onClick={() => void doMerge()}>
            {merging ? 'Merging…' : sel.label}
          </button>
          <button className="pr-merge-chevron" disabled={merging} onClick={() => setShowDrop(v => !v)} aria-label="More merge options">
            <ChevronDown size={13} />
          </button>
          {showDrop && (
            <div className="pr-merge-dropdown">
              {MERGE_OPTIONS.map(opt => (
                <button key={opt.method} className={`pr-merge-option${method === opt.method ? ' selected' : ''}`}
                  onClick={() => { setMethod(opt.method); setShowDrop(false); }}>
                  <span className="pr-merge-option-label">{opt.label}</span>
                  <span className="pr-merge-option-desc">{opt.desc}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Diff parser + viewer ─────────────────────────────────────────────────────

interface DiffLine { type: 'context' | 'added' | 'removed' | 'hunk'; content: string; oldNum?: number; newNum?: number; }
interface FileDiff { path: string; lines: DiffLine[]; }

function parseDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let ol = 0; let nl = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { path: '', lines: [] }; files.push(cur);
    } else if (line.startsWith('+++ ') && cur) {
      cur.path = line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('@@ ') && cur) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { ol = parseInt(m[1]!, 10) - 1; nl = parseInt(m[2]!, 10) - 1; }
      cur.lines.push({ type: 'hunk', content: line });
    } else if (cur && cur.path) {
      if (line.startsWith('+')) { nl++; cur.lines.push({ type: 'added', content: line.slice(1), newNum: nl }); }
      else if (line.startsWith('-')) { ol++; cur.lines.push({ type: 'removed', content: line.slice(1), oldNum: ol }); }
      else if (line.startsWith(' ') || line === '') { ol++; nl++; cur.lines.push({ type: 'context', content: line.slice(1), oldNum: ol, newNum: nl }); }
    }
  }
  return files.filter(f => f.path);
}

function DiffViewer({ fileDiff }: { fileDiff: FileDiff }) {
  return (
    <table className="pr-diff-table">
      <tbody>
        {fileDiff.lines.map((line, i) => {
          if (line.type === 'hunk') return (
            <tr key={i} className="pr-diff-hunk"><td colSpan={3} className="pr-diff-hunk-cell">{line.content}</td></tr>
          );
          const pfx = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
          return (
            <tr key={i} className={`pr-diff-line pr-diff-line--${line.type}`}>
              <td className="pr-diff-ln">{line.type !== 'added' ? line.oldNum : ''}</td>
              <td className="pr-diff-ln">{line.type !== 'removed' ? line.newNum : ''}</td>
              <td className="pr-diff-code"><pre>{pfx + line.content}</pre></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Sidebar picker (inline, not absolute — avoids overflow clipping) ─────────

function SidebarPicker({ options, selected, onToggle, onClose, renderOption, title }: {
  options: string[]; selected: string[]; onToggle: (item: string) => void;
  onClose: () => void; renderOption?: (item: string) => React.ReactNode; title: string;
}) {
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  const filtered = options.filter(o => o.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="pr-sidebar-picker" ref={ref}>
      <div className="pr-sidebar-picker-head">{title}</div>
      <input className="pr-sidebar-picker-search" placeholder="Filter…" value={search}
        onChange={e => setSearch(e.target.value)} autoFocus />
      <div className="pr-sidebar-picker-list">
        {filtered.length === 0
          ? <div className="pr-sidebar-picker-empty">No results</div>
          : filtered.map(opt => (
            <button key={opt} className="pr-sidebar-picker-item" onClick={() => onToggle(opt)}>
              <div className={`pr-spcheck${selected.includes(opt) ? ' on' : ''}`}>
                {selected.includes(opt) && <Check size={10} />}
              </div>
              {renderOption ? renderOption(opt) : <span>{opt}</span>}
            </button>
          ))}
      </div>
    </div>
  );
}

function SidebarSection({ title, children, onGear }: {
  title: string; children: React.ReactNode; onGear?: () => void;
}) {
  return (
    <div className="pr-right-section">
      <div className="pr-right-section-hdr">
        <span className="pr-right-section-title">{title}</span>
        {onGear && (
          <button className="pr-right-gear" onClick={onGear} aria-label={`Manage ${title}`}>
            <Settings size={13} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function LabelBadge({ label }: { label: GitHubLabel }) {
  const hex = label.color.startsWith('#') ? label.color : `#${label.color}`;
  return (
    <span className="pr-label-badge" style={{ background: `${hex}22`, color: hex, border: `1px solid ${hex}55` }}>
      {label.name}
    </span>
  );
}

// ─── Files-changed left-sidebar nav ──────────────────────────────────────────

function FilesNav({ files, selected, onSelect, isLoading }: {
  files: GitHubPR['files']; selected: string | null; onSelect: (p: string) => void; isLoading: boolean;
}) {
  return (
    <div className="pr-fnav">
      <div className="pr-fnav-header">
        {isLoading ? 'Loading…' : `${files.length} file${files.length !== 1 ? 's' : ''} changed`}
      </div>
      <div className="pr-fnav-list">
        {files.map(f => {
          const name = f.path.split('/').pop() ?? f.path;
          const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
          return (
            <button
              key={f.path}
              className={`pr-fnav-item${selected === f.path ? ' active' : ''}`}
              onClick={() => onSelect(f.path)}
              title={f.path}
            >
              <span className="pr-fnav-name">{name}</span>
              {dir && <span className="pr-fnav-dir">{dir}</span>}
              <div className="pr-fnav-stats">
                {f.additions > 0 && <span className="pr-fnav-add">+{f.additions}</span>}
                {f.deletions > 0 && <span className="pr-fnav-del">-{f.deletions}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function PullRequestView({ repoPath, prNumber, initialPr }: Props) {
  const [pr, setPr] = useState<GitHubPR | null>(initialPr ?? null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'conversation' | 'files'>('conversation');
  const [commentText, setCommentText] = useState('');
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);

  // Files tab
  const [diff, setDiff] = useState<string | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [parsedDiff, setParsedDiff] = useState<FileDiff[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Sidebar
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [repoLabels, setRepoLabels] = useState<GitHubLabel[]>([]);
  const [openPicker, setOpenPicker] = useState<'reviewers' | 'assignees' | 'labels' | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // ── Fetch PR detail ────────────────────────────────────────────────────────
  useEffect(() => {
    if (prNumber === null) { setPr(null); return; }
    if (initialPr && initialPr.number === prNumber) setPr(initialPr);
    setIsLoading(true);
    setError(null);
    setDiff(null);
    setParsedDiff([]);
    setSelectedFile(null);
    githubApi.getPR(repoPath, prNumber)
      .then(data => { setPr(data); setIsLoading(false); })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        const missing = msg.includes('ENOENT') || msg.toLowerCase().includes('command not found');
        const unauth = msg.toLowerCase().includes('not logged') || msg.toLowerCase().includes('gh auth login');
        setError(missing || unauth
          ? 'GitHub CLI (gh) is not available or not authenticated. Run `gh auth login` to enable PR features.'
          : msg);
        setIsLoading(false);
      });
  }, [repoPath, prNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch diff lazily when Files tab opens ─────────────────────────────────
  useEffect(() => {
    if (activeTab !== 'files' || !prNumber || diff !== null) return;
    setIsLoadingDiff(true);
    githubApi.getPRDiff(repoPath, prNumber)
      .then(d => {
        setDiff(d);
        const parsed = parseDiff(d);
        setParsedDiff(parsed);
        if (parsed.length > 0 && !selectedFile) setSelectedFile(parsed[0]!.path);
        setIsLoadingDiff(false);
      })
      .catch(() => setIsLoadingDiff(false));
  }, [activeTab, prNumber, diff, repoPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch sidebar data once PR loads ──────────────────────────────────────
  useEffect(() => {
    if (!pr) return;
    githubApi.getCollaborators(repoPath).then(setCollaborators).catch(() => {});
    githubApi.getRepoLabels(repoPath).then(setRepoLabels).catch(() => {});
  }, [repoPath, pr?.number]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshPR = () => {
    if (!prNumber) return;
    githubApi.getPR(repoPath, prNumber).then(setPr).catch(() => {});
  };

  const handleSubmitComment = async () => {
    if (!commentText.trim() || !pr) return;
    setIsSubmittingComment(true);
    try {
      await githubApi.addComment(repoPath, pr.number, commentText.trim());
      setCommentText('');
      setPr(await githubApi.getPR(repoPath, pr.number));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setIsSubmittingComment(false); }
  };

  const handleEditPR = async (options: Parameters<typeof githubApi.editPR>[2]) => {
    if (!pr) return;
    setIsSaving(true);
    try {
      await githubApi.editPR(repoPath, pr.number, options);
      refreshPR();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setIsSaving(false); setOpenPicker(null); }
  };

  // ── Empty / loading / error states ────────────────────────────────────────
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
  if (isLoading && !pr) {
    return (
      <div className="pr-view">
        <div className="pr-view-skeleton">
          {[60, 40, 80].map((w, i) => (
            <span key={i} className="skeleton-line" style={{ width: `${w}%`, height: i === 0 ? 16 : 12, display: 'block' }} />
          ))}
        </div>
      </div>
    );
  }
  if (error && !pr) return <div className="pr-view"><div className="pr-view-error">{error}</div></div>;
  if (!pr) return null;

  const stateLabel = prStateLabel(pr);

  // Build sorted timeline items
  type TLItem =
    | { kind: 'comment'; id: string; author: string; body: string; date: string }
    | { kind: 'review'; review: GitHubReview };

  const tlItems: TLItem[] = [
    ...pr.comments.map(c => ({ kind: 'comment' as const, id: c.id, author: c.author, body: c.body, date: c.createdAt })),
    ...pr.reviews
      .filter(r => r.state !== 'COMMENTED' || r.body.trim())
      .map(r => ({ kind: 'review' as const, review: r })),
  ].sort((a, b) => {
    const da = a.kind === 'comment' ? a.date : a.review.submittedAt;
    const db = b.kind === 'comment' ? b.date : b.review.submittedAt;
    return new Date(da).getTime() - new Date(db).getTime();
  });

  const hasAfterDesc = tlItems.length > 0 || pr.checks.length > 0 || pr.state === 'OPEN';

  // For files tab: find diff for selected file
  const activeFileDiff = selectedFile ? (parsedDiff.find(d => d.path === selectedFile) ?? null) : null;

  // Right sidebar — only shown on conversation tab
  const rightSidebar = activeTab === 'conversation' ? (
    <div className="pr-view-right-sidebar">
      {/* Reviewers */}
      <SidebarSection title="Reviewers" onGear={() => setOpenPicker(openPicker === 'reviewers' ? null : 'reviewers')}>
        {openPicker === 'reviewers' && (
          <SidebarPicker
            title="Request a review"
            options={collaborators}
            selected={[...pr.reviewRequests, ...pr.reviews.map(r => r.author)]}
            onToggle={login => void handleEditPR(
              pr.reviewRequests.includes(login) ? { removeReviewers: [login] } : { addReviewers: [login] }
            )}
            onClose={() => setOpenPicker(null)}
            renderOption={login => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <UserAvatar login={login} size={20} />
                <span>{login}</span>
              </div>
            )}
          />
        )}
        {pr.reviewRequests.length === 0 && pr.reviews.length === 0
          ? <span className="pr-right-none">No reviewers</span>
          : (
            <div className="pr-right-list">
              {pr.reviewRequests.map(login => (
                <div key={login} className="pr-right-user">
                  <UserAvatar login={login} size={20} />
                  <span className="pr-right-username">{login}</span>
                  <span className="pr-right-pending">Awaiting</span>
                </div>
              ))}
              {pr.reviews.map(r => (
                <div key={r.id} className="pr-right-user">
                  <UserAvatar login={r.author} size={20} />
                  <span className="pr-right-username">{r.author}</span>
                  {r.state === 'APPROVED' && <Check size={12} className="ci-success" />}
                  {r.state === 'CHANGES_REQUESTED' && <X size={12} className="ci-failure" />}
                </div>
              ))}
            </div>
          )
        }
        {pr.isDraft && pr.state === 'OPEN' && (
          <span className="pr-right-hint">
            Still in progress?{' '}
            <button className="pr-right-link" onClick={() => void handleEditPR({})}>Convert to draft</button>
          </span>
        )}
      </SidebarSection>

      {/* Assignees */}
      <SidebarSection title="Assignees" onGear={() => setOpenPicker(openPicker === 'assignees' ? null : 'assignees')}>
        {openPicker === 'assignees' && (
          <SidebarPicker
            title="Assign users"
            options={collaborators}
            selected={pr.assignees}
            onToggle={login => void handleEditPR(
              pr.assignees.includes(login) ? { removeAssignees: [login] } : { addAssignees: [login] }
            )}
            onClose={() => setOpenPicker(null)}
            renderOption={login => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <UserAvatar login={login} size={20} />
                <span>{login}</span>
              </div>
            )}
          />
        )}
        {pr.assignees.length === 0
          ? (
            <span className="pr-right-none">
              No one—{' '}
              <button className="pr-right-link" onClick={() => void handleEditPR({ addAssignees: [pr.author] })} disabled={isSaving}>
                assign yourself
              </button>
            </span>
          )
          : (
            <div className="pr-right-list">
              {pr.assignees.map(login => (
                <div key={login} className="pr-right-user">
                  <UserAvatar login={login} size={20} />
                  <span className="pr-right-username">{login}</span>
                </div>
              ))}
            </div>
          )
        }
      </SidebarSection>

      {/* Labels */}
      <SidebarSection title="Labels" onGear={() => setOpenPicker(openPicker === 'labels' ? null : 'labels')}>
        {openPicker === 'labels' && (
          <SidebarPicker
            title="Apply labels"
            options={repoLabels.map(l => l.name)}
            selected={pr.labels.map(l => l.name)}
            onToggle={name => void handleEditPR(
              pr.labels.some(l => l.name === name) ? { removeLabels: [name] } : { addLabels: [name] }
            )}
            onClose={() => setOpenPicker(null)}
            renderOption={name => {
              const label = repoLabels.find(l => l.name === name);
              return label ? <LabelBadge label={label} /> : <span>{name}</span>;
            }}
          />
        )}
        {pr.labels.length === 0
          ? <span className="pr-right-none">None yet</span>
          : <div className="pr-right-labels">{pr.labels.map(l => <LabelBadge key={l.name} label={l} />)}</div>
        }
      </SidebarSection>
    </div>
  ) : null;

  return (
    <div className="pr-view">
      {/* ── Header ── */}
      <div className="pr-view-header">
        <div className="pr-header-title-row">
          <h2 className="pr-header-title">
            {pr.title}<span className="pr-header-number"> #{pr.number}</span>
          </h2>
          <span className={`pr-status-badge ${stateLabel}`}>
            {stateLabel.charAt(0).toUpperCase() + stateLabel.slice(1)}
          </span>
        </div>
        <div className="pr-header-meta">
          <GitMerge size={13} style={{ opacity: 0.5 }} />
          <strong>{pr.author}</strong>
          <span>wants to merge into</span>
          <code className="pr-branch-chip">{pr.baseRefName}</code>
          <ArrowRight size={11} style={{ opacity: 0.5 }} />
          <code className="pr-branch-chip">{pr.headRefName}</code>
          {pr.additions > 0 && <span className="pr-stat-add">+{pr.additions}</span>}
          {pr.deletions > 0 && <span className="pr-stat-del">−{pr.deletions}</span>}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="pr-tabs-bar">
        <button className={`pr-tab${activeTab === 'conversation' ? ' active' : ''}`} onClick={() => setActiveTab('conversation')}>
          <MessageSquare size={14} />
          Conversation
          {(pr.comments.length + pr.reviews.filter(r => r.body || r.state !== 'COMMENTED').length) > 0 && (
            <span className="pr-tab-badge">{pr.comments.length + pr.reviews.filter(r => r.body || r.state !== 'COMMENTED').length}</span>
          )}
        </button>
        <button className={`pr-tab${activeTab === 'files' ? ' active' : ''}`} onClick={() => setActiveTab('files')}>
          <FileCode size={14} />
          Files changed
          {pr.files.length > 0 && <span className="pr-tab-badge">{pr.files.length}</span>}
        </button>
        <div className="pr-tabs-stats">
          {pr.additions > 0 && <span className="pr-stat-add">+{pr.additions}</span>}
          {pr.deletions > 0 && <span className="pr-stat-del">−{pr.deletions}</span>}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="pr-view-content">
        <div className="pr-view-main">
          {error && <div className="pr-view-error" style={{ margin: '12px 24px 0' }}>{error}</div>}

          {/* ── CONVERSATION TAB ── */}
          {activeTab === 'conversation' && (
            <div className="pr-timeline">
              {/* Description */}
              <TimelineRow login={pr.author} hasConnector={hasAfterDesc}>
                <CommentBubble author={pr.author} time={pr.createdAt} body={pr.body} isDescription />
              </TimelineRow>

              {/* Comments + reviews interleaved by date */}
              {tlItems.map((item, i) => {
                const isLast = i === tlItems.length - 1;
                const conn = !isLast || pr.checks.length > 0 || pr.state === 'OPEN';
                if (item.kind === 'comment') {
                  return (
                    <TimelineRow key={item.id} login={item.author} hasConnector={conn}>
                      <CommentBubble author={item.author} time={item.date} body={item.body} />
                    </TimelineRow>
                  );
                }
                return (
                  <TimelineRow key={item.review.id} login={item.review.author} hasConnector={conn}>
                    <ReviewBubble review={item.review} />
                  </TimelineRow>
                );
              })}

              {/* Checks */}
              {pr.checks.length > 0 && (
                <TimelineRow hasConnector={pr.state === 'OPEN'} small>
                  <ChecksCard pr={pr} />
                </TimelineRow>
              )}

              {/* Merge section */}
              {pr.state === 'OPEN' && (
                <TimelineRow hasConnector={false} small>
                  <MergeSection pr={pr} repoPath={repoPath} onMerged={refreshPR} />
                </TimelineRow>
              )}

              {/* Comment form */}
              {pr.state === 'OPEN' && (
                <div className="pr-comment-form-area">
                  <UserAvatar login={pr.author} size={32} />
                  <div className="pr-comment-form-box">
                    <textarea
                      className="pr-comment-textarea"
                      placeholder="Leave a comment…"
                      value={commentText}
                      onChange={e => setCommentText(e.target.value)}
                    />
                    <div className="pr-comment-form-footer">
                      <button
                        className="pr-comment-submit-btn"
                        disabled={!commentText.trim() || isSubmittingComment}
                        onClick={() => void handleSubmitComment()}
                      >
                        {isSubmittingComment ? 'Submitting…' : 'Comment'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── FILES CHANGED TAB ── */}
          {activeTab === 'files' && (
            <div className="pr-files-layout">
              {/* Left: file nav */}
              <FilesNav
                files={pr.files}
                selected={selectedFile}
                onSelect={p => setSelectedFile(p)}
                isLoading={isLoadingDiff && pr.files.length === 0}
              />
              {/* Right: diff content */}
              <div className="pr-files-content">
                {!selectedFile ? (
                  <div className="pr-files-empty">Select a file to view its changes</div>
                ) : !activeFileDiff && isLoadingDiff ? (
                  <div className="pr-files-empty">Loading diff…</div>
                ) : !activeFileDiff ? (
                  <div className="pr-files-empty">No diff available for this file</div>
                ) : (
                  <>
                    <div className="pr-files-content-header">
                      <span className="pr-files-content-path">{selectedFile}</span>
                      <div className="pr-fnav-stats" style={{ marginLeft: 'auto' }}>
                        {pr.files.find(f => f.path === selectedFile)?.additions
                          ? <span className="pr-fnav-add">+{pr.files.find(f => f.path === selectedFile)!.additions}</span>
                          : null}
                        {pr.files.find(f => f.path === selectedFile)?.deletions
                          ? <span className="pr-fnav-del">-{pr.files.find(f => f.path === selectedFile)!.deletions}</span>
                          : null}
                      </div>
                    </div>
                    <div className="pr-diff-wrap">
                      <DiffViewer fileDiff={activeFileDiff} />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {rightSidebar}
      </div>
    </div>
  );
}
