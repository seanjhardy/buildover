import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import type { RecentRepoInfo } from "../types.js";

interface Props {
  recents: RecentRepoInfo[];
  openPaths: string[];
  onOpen: (path: string) => Promise<void>;
  onForgetRecent: (path: string) => void;
}

export function OpenRepoMenu({
  recents,
  openPaths,
  onOpen,
  onForgetRecent,
}: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (ref.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCoords({ top: rect.bottom + 4, left: rect.left });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  const handleBrowse = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await api.pickFolder();
      if (path) {
        await onOpen(path);
        setOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRecent = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      await onOpen(path);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const filteredRecents = recents.filter((r) => !openPaths.includes(r.path));

  return (
    <div className="open-repo-menu" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="repo-tab open-repo-trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title="Open a repository"
      >
        + Open repo
      </button>
      {open && coords && (
        <div
          ref={popoverRef}
          className="open-repo-popover"
          role="menu"
          style={{ top: coords.top, left: coords.left }}
        >
          <button
            type="button"
            className="open-repo-browse"
            onClick={handleBrowse}
            disabled={busy}
          >
            Browse for folder…
          </button>
          {filteredRecents.length > 0 && (
            <div className="open-repo-section-label">Recent</div>
          )}
          {filteredRecents.map((r) => (
            <div key={r.path} className="open-repo-recent-row">
              <button
                type="button"
                className="open-repo-recent"
                onClick={() => handleRecent(r.path)}
                disabled={busy}
                title={r.path}
              >
                <span className="open-repo-recent-name">{r.name}</span>
                <span className="open-repo-recent-path">{r.path}</span>
              </button>
              <button
                type="button"
                className="open-repo-forget"
                onClick={() => onForgetRecent(r.path)}
                title="Forget this recent"
                aria-label="Forget"
              >
                ×
              </button>
            </div>
          ))}
          {error && <div className="open-repo-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
