import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  CloudDownload,
  FolderOpen,
  FolderPlus,
  Globe,
  Lock,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../lib/api.js";
import type {
  CreateProjectResult,
  GitHubAccountInfo,
  GitHubRepoInfo,
  RecentRepoInfo,
  RepoVisibility,
  TemplateInfo,
} from "../types.js";

interface Props {
  recents: RecentRepoInfo[];
  openPaths: string[];
  onClose: () => void;
  onOpen: (path: string) => Promise<void>;
  onForgetRecent: (path: string) => void;
}

type Screen = "home" | "new" | "github";

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** True for text that is a clone URL rather than a search term. */
function looksLikeCloneUrl(text: string): boolean {
  return /:\/\//.test(text) || /^git@/.test(text);
}

function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "");
}

function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <span className="new-project-switch">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="new-project-switch-track" />
    </span>
  );
}

function LocationField({
  value,
  onPick,
  disabled,
}: {
  value: string | null;
  onPick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="new-project-field">
      <div className="new-project-label-row">
        <label className="new-project-label">Location</label>
      </div>
      <div className="new-project-path">
        <span
          className={`new-project-path-value ${value ? "" : "empty"}`}
          title={value ?? undefined}
        >
          {value ?? "No folder chosen"}
        </span>
        <button
          type="button"
          className="new-project-path-button"
          onClick={onPick}
          disabled={disabled}
        >
          {value ? "Change" : "Choose"}
        </button>
      </div>
    </div>
  );
}

export function NewProjectModal({
  recents,
  openPaths,
  onClose,
  onOpen,
  onForgetRecent,
}: Props) {
  const [screen, setScreen] = useState<Screen>("home");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateProjectResult | null>(null);

  // Shared across the new-project and clone screens: both put a project on disk
  // somewhere, and the last place used is remembered as the default.
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<GitHubAccountInfo[]>([]);
  const [ghUnavailable, setGhUnavailable] = useState(false);
  const [account, setAccount] = useState("");
  const [owners, setOwners] = useState<string[]>([]);
  const [owner, setOwner] = useState("");

  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [initGit, setInitGit] = useState(true);
  const [commit, setCommit] = useState(true);
  const [commitMessage, setCommitMessage] = useState("Initial commit");
  const [createRemote, setCreateRemote] = useState(true);
  const [visibility, setVisibility] = useState<RepoVisibility>("private");
  const [description, setDescription] = useState("");
  const [push, setPush] = useState(true);

  const [repos, setRepos] = useState<GitHubRepoInfo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cloneUrl, setCloneUrl] = useState<string | null>(null);
  const [collapsedOwners, setCollapsedOwners] = useState<Set<string>>(new Set());
  const [activeOwner, setActiveOwner] = useState("");
  const repoListRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef(new Map<string, HTMLDivElement>());

  const refreshTemplates = useCallback(async () => {
    setTemplates(await api.listTemplates());
  }, []);

  useEffect(() => {
    void refreshTemplates().catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
    void api
      .getPrefs()
      .then((p) => setParentDir((cur) => cur ?? p.lastProjectLocation ?? null))
      .catch(() => {});
  }, [refreshTemplates]);

  // The account gh reports as active becomes the default, so the user's primary
  // account is preselected without any of their details living in the codebase.
  useEffect(() => {
    void api
      .listGitHubAccounts()
      .then((list) => {
        setAccounts(list);
        if (list.length === 0) {
          setGhUnavailable(true);
          setCreateRemote(false);
          return;
        }
        setAccount((list.find((a) => a.active) ?? list[0]).login);
      })
      .catch(() => {
        setGhUnavailable(true);
        setCreateRemote(false);
      });
  }, []);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    setOwners([account]);
    setOwner(account);
    void api
      .listGitHubOwners(account)
      .then((list) => {
        if (cancelled || list.length === 0) return;
        setOwners(list);
        setOwner(list[0]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [account]);

  // Fetches as soon as the account is known rather than on reaching the GitHub
  // screen, so the list is already populated by the time it is shown. A cached
  // response paints instantly and is revalidated in the background; a live one
  // is current already, so it costs no second request.
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    setReposLoading(true);
    setReposError(null);
    setRepos([]);
    void (async () => {
      try {
        const first = await api.listGitHubRepos(account);
        if (cancelled) return;
        setRepos(first.repos);
        setReposLoading(false);
        if (!first.cached) return;
        // A failed revalidation is not worth reporting — the cached list is
        // still on screen and still usable.
        const fresh = await api.listGitHubRepos(account, true).catch(() => null);
        if (!cancelled && fresh) setRepos(fresh.repos);
      } catch (err) {
        if (cancelled) return;
        setReposError(err instanceof Error ? err.message : String(err));
        setReposLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const trimmedName = name.trim();
  const nameValid = trimmedName === "" || NAME_PATTERN.test(trimmedName);
  const selected = templateId
    ? (templates.find((t) => t.id === templateId) ?? null)
    : null;
  const templateMissing = Boolean(templateId) && !selected?.exists;
  const canCommit = initGit && commit;
  // A remote can only be attached to a repository, so the whole GitHub section
  // follows the git switch.
  const ghBlocked = ghUnavailable || !initGit;
  const remoteOn = createRemote && !ghBlocked;

  const canCreate =
    !busy &&
    !templateMissing &&
    trimmedName !== "" &&
    nameValid &&
    Boolean(parentDir) &&
    (!remoteOn || (Boolean(account) && Boolean(owner)));

  const urlQuery = looksLikeCloneUrl(query.trim()) ? query.trim() : null;
  const visibleRepos = useMemo(() => {
    if (urlQuery) return [];
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.nameWithOwner.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q),
    );
  }, [repos, query, urlQuery]);

  // While searching every section is forced open, so a match is never hidden
  // behind a collapsed header.
  const searching = query.trim() !== "" && !urlQuery;
  const ownerGroups = useMemo(() => {
    const groups = new Map<string, GitHubRepoInfo[]>();
    for (const repo of visibleRepos) {
      const existing = groups.get(repo.owner);
      if (existing) existing.push(repo);
      else groups.set(repo.owner, [repo]);
    }
    return [...groups].map(([owner, list]) => ({ owner, repos: list }));
  }, [visibleRepos]);

  useEffect(() => {
    setActiveOwner((cur) =>
      ownerGroups.some((g) => g.owner === cur)
        ? cur
        : (ownerGroups[0]?.owner ?? ""),
    );
  }, [ownerGroups]);

  const toggleOwner = (owner: string) =>
    setCollapsedOwners((prev) => {
      const next = new Set(prev);
      if (!next.delete(owner)) next.add(owner);
      return next;
    });

  const jumpToOwner = (owner: string) => {
    setCollapsedOwners((prev) => {
      if (!prev.has(owner)) return prev;
      const next = new Set(prev);
      next.delete(owner);
      return next;
    });
    setActiveOwner(owner);
    // Expanding is a state update, so the scroll has to wait for the re-render.
    requestAnimationFrame(() => {
      const list = repoListRef.current;
      const section = sectionRefs.current.get(owner);
      if (list && section) list.scrollTop = section.offsetTop - list.offsetTop;
    });
  };

  // Keeps the rail in sync with whichever section is under the top of the list.
  const syncActiveOwner = () => {
    const list = repoListRef.current;
    if (!list) return;
    let current = "";
    for (const { owner } of ownerGroups) {
      const section = sectionRefs.current.get(owner);
      if (section && section.offsetTop - list.offsetTop <= list.scrollTop + 8) {
        current = owner;
      }
    }
    setActiveOwner(current || ownerGroups[0]?.owner || "");
  };

  const canClone = !busy && Boolean(cloneUrl) && Boolean(parentDir);
  const filteredRecents = recents.filter((r) => !openPaths.includes(r.path));

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openAndClose = (path: string) =>
    run(async () => {
      setBusy(true);
      try {
        await onOpen(path);
        onClose();
      } finally {
        setBusy(false);
      }
    });

  const handleBrowse = () =>
    run(async () => {
      const path = await api.pickFolder();
      if (path) await openAndClose(path);
    });

  const handlePickLocation = () =>
    run(async () => {
      const path = await api.pickFolder();
      if (path) setParentDir(path);
    });

  const handleAddTemplate = () =>
    run(async () => {
      const path = await api.pickFolder();
      if (!path) return;
      const template = await api.addTemplate(path);
      await refreshTemplates();
      setTemplateId(template.id);
    });

  const handleRemoveTemplate = (id: string) =>
    run(async () => {
      await api.removeTemplate(id);
      if (templateId === id) setTemplateId(null);
      await refreshTemplates();
    });

  const handleCreate = async () => {
    if (!parentDir) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.createProject({
          ...(templateId ? { templateId } : {}),
          name: trimmedName,
          parentDir,
          initGit,
          commit: canCommit,
          commitMessage,
          ...(remoteOn
            ? {
                github: {
                  account,
                  owner,
                  visibility,
                  description: description.trim() || undefined,
                  push: push && canCommit,
                },
              }
            : {}),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleClone = async () => {
    if (!cloneUrl || !parentDir) return;
    setBusy(true);
    setError(null);
    try {
      const repo = await api.cloneRepo(cloneUrl, parentDir);
      await onOpen(repo.path);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const goHome = () => {
    setScreen("home");
    setError(null);
  };

  // ---- Screens ------------------------------------------------------------

  const homeBody = (
    <div className="new-project-home">
      <div className="new-project-cards">
        <button
          type="button"
          className="new-project-card"
          onClick={() => {
            setError(null);
            setScreen("github");
          }}
          disabled={busy}
        >
          <span className="new-project-card-icon">
            <CloudDownload size={20} />
          </span>
          <span className="new-project-card-title">Clone from GitHub</span>
          <span className="new-project-card-sub">
            Pick a repository from your accounts
          </span>
        </button>
        <button
          type="button"
          className="new-project-card"
          onClick={handleBrowse}
          disabled={busy}
        >
          <span className="new-project-card-icon">
            <FolderOpen size={20} />
          </span>
          <span className="new-project-card-title">Open a folder</span>
          <span className="new-project-card-sub">
            Find a project already on this machine
          </span>
        </button>
        <button
          type="button"
          className="new-project-card"
          onClick={() => {
            setError(null);
            setScreen("new");
          }}
          disabled={busy}
        >
          <span className="new-project-card-icon">
            <Sparkles size={20} />
          </span>
          <span className="new-project-card-title">New project</span>
          <span className="new-project-card-sub">
            Start from a template or an empty folder
          </span>
        </button>
      </div>

      <div className="new-project-recents">
        <div className="new-project-group-label">
          <Clock size={12} />
          Recent
        </div>
        {filteredRecents.length === 0 ? (
          <p className="new-project-empty">
            Projects you open will show up here.
          </p>
        ) : (
          <div className="new-project-recent-list">
            {filteredRecents.map((r) => (
              <div key={r.path} className="new-project-recent">
                <button
                  type="button"
                  className="new-project-recent-pick"
                  onClick={() => void openAndClose(r.path)}
                  disabled={busy}
                  title={r.path}
                >
                  <span className="new-project-recent-name">{r.name}</span>
                  <span className="new-project-recent-path">{r.path}</span>
                </button>
                <button
                  type="button"
                  className="new-project-recent-forget"
                  onClick={() => onForgetRecent(r.path)}
                  disabled={busy}
                  aria-label={`Forget ${r.name}`}
                  title="Forget this recent"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const repoRow = (r: GitHubRepoInfo) => (
    <button
      key={r.nameWithOwner}
      type="button"
      className={`new-project-repo ${cloneUrl === r.sshUrl ? "active" : ""}`}
      onClick={() => setCloneUrl(r.sshUrl)}
      disabled={busy}
      title={r.nameWithOwner}
    >
      <span className="new-project-repo-top">
        <span className="new-project-repo-name">
          {r.nameWithOwner.split("/")[1] ?? r.nameWithOwner}
        </span>
        <span className="new-project-repo-badge">
          {r.isPrivate ? "Private" : "Public"}
        </span>
      </span>
      {r.description && (
        <span className="new-project-repo-desc">{r.description}</span>
      )}
    </button>
  );

  const githubBody = (
    <div className="new-project-github">
      <div className="new-project-gh-top">
        <select
          className="new-project-input new-project-account-select"
          aria-label="GitHub account"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          disabled={busy || ghUnavailable}
        >
          {accounts.map((a) => (
            <option key={a.login} value={a.login}>
              {a.login}
              {a.active ? " · default" : ""}
            </option>
          ))}
        </select>
        <div className="new-project-search">
          <Search size={14} />
          <input
            className="new-project-search-input"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCloneUrl(null);
            }}
            placeholder="Search repositories, or paste a clone URL"
            spellCheck={false}
            disabled={busy}
          />
        </div>
      </div>

      <div className="new-project-repo-area">
        <div
          className="new-project-repo-list"
          ref={repoListRef}
          onScroll={syncActiveOwner}
        >
          {urlQuery ? (
            <button
              type="button"
              className={`new-project-repo ${cloneUrl === urlQuery ? "active" : ""}`}
              onClick={() => setCloneUrl(urlQuery)}
              disabled={busy}
            >
              <span className="new-project-repo-top">
                <span className="new-project-repo-name">
                  {repoNameFromUrl(urlQuery) || "Clone from URL"}
                </span>
                <span className="new-project-repo-badge">URL</span>
              </span>
              <span className="new-project-repo-desc">{urlQuery}</span>
            </button>
          ) : reposLoading ? (
            <p className="new-project-empty">Loading repositories…</p>
          ) : reposError ? (
            <p className="new-project-empty error">{reposError}</p>
          ) : ownerGroups.length === 0 ? (
            <p className="new-project-empty">
              {repos.length === 0
                ? `No repositories found for ${account || "this account"}.`
                : "No repositories match your search."}
            </p>
          ) : (
            ownerGroups.map(({ owner: groupOwner, repos: groupRepos }) => {
              const isCollapsed = !searching && collapsedOwners.has(groupOwner);
              return (
                <div
                  key={groupOwner}
                  className="new-project-owner-section"
                  ref={(el) => {
                    if (el) sectionRefs.current.set(groupOwner, el);
                    else sectionRefs.current.delete(groupOwner);
                  }}
                >
                  <button
                    type="button"
                    className="new-project-owner-header"
                    onClick={() => toggleOwner(groupOwner)}
                    disabled={searching}
                  >
                    {isCollapsed ? (
                      <ChevronRight size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                    <span className="new-project-owner-name">{groupOwner}</span>
                    <span className="new-project-owner-count">
                      {groupRepos.length}
                    </span>
                  </button>
                  {!isCollapsed && groupRepos.map(repoRow)}
                </div>
              );
            })
          )}
        </div>

        {ownerGroups.length > 1 && !urlQuery && (
          <div className="new-project-owner-rail">
            {ownerGroups.map(({ owner: groupOwner, repos: groupRepos }) => (
              <button
                key={groupOwner}
                type="button"
                className={`new-project-rail-node ${
                  activeOwner === groupOwner ? "active" : ""
                }`}
                onClick={() => jumpToOwner(groupOwner)}
                data-tip={`${groupOwner} · ${groupRepos.length}`}
                aria-label={`Jump to ${groupOwner}`}
              >
                {groupOwner.slice(0, 1).toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      <LocationField
        value={parentDir}
        onPick={handlePickLocation}
        disabled={busy}
      />
    </div>
  );

  const newBody = (
    <div className="new-project-body">
      <aside className="new-project-sidebar">
        <div className="new-project-sidebar-title">Template</div>
        <div className="new-project-template-list">
          <div
            className={`new-project-template ${templateId === null ? "active" : ""}`}
          >
            <button
              type="button"
              className="new-project-template-pick"
              onClick={() => setTemplateId(null)}
              disabled={busy}
            >
              <span className="new-project-template-name">Empty project</span>
              <span className="new-project-template-path">
                Just the folder, nothing copied
              </span>
            </button>
          </div>
          {templates.map((t) => (
            <div
              key={t.id}
              className={`new-project-template ${
                t.id === templateId ? "active" : ""
              } ${t.exists ? "" : "missing"}`}
            >
              <button
                type="button"
                className="new-project-template-pick"
                onClick={() => setTemplateId(t.id)}
                disabled={busy || !t.exists}
                title={t.exists ? t.path : `Missing: ${t.path}`}
              >
                <span className="new-project-template-name">{t.name}</span>
                <span className="new-project-template-path">
                  {t.exists ? t.path : "Folder no longer exists"}
                </span>
              </button>
              <button
                type="button"
                className="new-project-template-remove"
                onClick={() => handleRemoveTemplate(t.id)}
                disabled={busy}
                aria-label={`Remove ${t.name}`}
                title="Remove template"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="new-project-add-template"
          onClick={handleAddTemplate}
          disabled={busy}
        >
          <Plus size={14} />
          Add template
        </button>
      </aside>

      <div className="new-project-form">
        <div className="new-project-field">
          <div className="new-project-label-row">
            <label className="new-project-label" htmlFor="np-name">
              Project name
            </label>
            <span className="new-project-label-error">
              {nameValid ? "" : "Letters, numbers, dots, dashes, underscores"}
            </span>
          </div>
          <input
            id="np-name"
            className={`new-project-input ${nameValid ? "" : "invalid"}`}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-new-app"
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
        </div>

        <LocationField
          value={parentDir}
          onPick={handlePickLocation}
          disabled={busy}
        />

        <section className="new-project-section">
          <div className="new-project-section-head">
            <div className="new-project-section-text">
              <span className="new-project-section-title">Git repository</span>
              <span className="new-project-section-sub">
                {templateId
                  ? "Start a fresh history — the template's own history is not copied"
                  : "Start a fresh history in the new folder"}
              </span>
            </div>
            <Switch
              checked={initGit}
              onChange={setInitGit}
              disabled={busy}
              label="Initialise a git repository"
            />
          </div>
          <div
            className={`new-project-section-body ${initGit ? "" : "disabled"}`}
          >
            <div className="new-project-inline">
              <label className="new-project-check">
                <input
                  type="checkbox"
                  checked={commit}
                  onChange={(e) => setCommit(e.target.checked)}
                  disabled={busy || !initGit}
                />
                Create an initial commit
              </label>
              <input
                className="new-project-input"
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Initial commit"
                aria-label="Initial commit message"
                disabled={busy || !canCommit}
              />
            </div>
          </div>
        </section>

        <section className="new-project-section">
          <div className="new-project-section-head">
            <div className="new-project-section-text">
              <span className="new-project-section-title">
                GitHub repository
              </span>
              <span className="new-project-section-sub">
                {ghUnavailable
                  ? "No authenticated accounts — run gh auth login to enable"
                  : !initGit
                    ? "Needs a git repository — turn on Git repository first"
                    : "Create the remote and connect it as origin"}
              </span>
            </div>
            <Switch
              checked={remoteOn}
              onChange={setCreateRemote}
              disabled={busy || ghBlocked}
              label="Create a GitHub repository"
            />
          </div>
          <div
            className={`new-project-section-body ${remoteOn ? "" : "disabled"}`}
          >
            <div className="new-project-grid">
              <div className="new-project-field">
                <div className="new-project-label-row">
                  <label className="new-project-label" htmlFor="np-account">
                    Account
                  </label>
                </div>
                <select
                  id="np-account"
                  className="new-project-input"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  disabled={busy || !remoteOn}
                >
                  {accounts.map((a) => (
                    <option key={a.login} value={a.login}>
                      {a.login}
                      {a.active ? " · default" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="new-project-field">
                <div className="new-project-label-row">
                  <label className="new-project-label" htmlFor="np-owner">
                    Owner
                  </label>
                </div>
                <select
                  id="np-owner"
                  className="new-project-input"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  disabled={busy || !remoteOn}
                >
                  {owners.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="new-project-grid">
              <div className="new-project-field">
                <div className="new-project-label-row">
                  <label className="new-project-label">Visibility</label>
                </div>
                <div className="new-project-segment" role="group">
                  {(
                    [
                      { value: "private", icon: Lock, text: "Private" },
                      { value: "public", icon: Globe, text: "Public" },
                    ] as const
                  ).map(({ value, icon: Icon, text }) => (
                    <button
                      key={value}
                      type="button"
                      className={`new-project-segment-option ${
                        visibility === value ? "active" : ""
                      }`}
                      onClick={() => setVisibility(value)}
                      disabled={busy || !remoteOn}
                      aria-pressed={visibility === value}
                    >
                      <Icon size={13} />
                      {text}
                    </button>
                  ))}
                </div>
              </div>

              <div className="new-project-field">
                <div className="new-project-label-row">
                  <label className="new-project-label" htmlFor="np-desc">
                    Description
                  </label>
                  <span className="new-project-label-note">optional</span>
                </div>
                <input
                  id="np-desc"
                  className="new-project-input"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this project does"
                  disabled={busy || !remoteOn}
                />
              </div>
            </div>

            <label className="new-project-check">
              <input
                type="checkbox"
                checked={push && canCommit}
                onChange={(e) => setPush(e.target.checked)}
                disabled={busy || !remoteOn || !canCommit}
              />
              Push the initial commit to origin
            </label>
          </div>
        </section>
      </div>
    </div>
  );

  const resultBody = result && (
    <div className="new-project-result">
      <ul className="new-project-steps">
        {result.steps.map((s, i) => (
          <li
            key={i}
            className={`new-project-step ${s.status === "failed" ? "failed" : ""}`}
          >
            <span className="new-project-step-icon">
              {s.status === "failed" ? (
                <CircleAlert size={14} />
              ) : (
                <Check size={14} />
              )}
            </span>
            <span className="new-project-step-label">{s.label}</span>
            {s.detail && (
              <span className="new-project-step-detail">{s.detail}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  // ---- Chrome -------------------------------------------------------------

  const heading = result
    ? { title: `${result.repo.name} created`, sub: "Review what happened, then open it in the workspace" }
    : screen === "new"
      ? { title: "New project", sub: "Start from a template or an empty folder" }
      : screen === "github"
        ? { title: "Clone from GitHub", sub: "Pick a repository or paste a clone URL" }
        : {
            title: "Projects",
            sub: "Clone from GitHub, browse your machine, or start something new",
          };

  const destPath =
    screen === "new"
      ? parentDir && trimmedName
        ? `${parentDir}/${trimmedName}`
        : null
      : cloneUrl && parentDir
        ? `${parentDir}/${repoNameFromUrl(cloneUrl)}`
        : null;

  const footerNote = result
    ? result.repo.path
    : destPath
      ? `${screen === "github" ? "Clones into" : "Creates"} ${destPath}`
      : screen === "new"
        ? parentDir
          ? "Name your project to continue"
          : "Name your project and choose a location to continue"
        : cloneUrl
          ? "Choose a location to continue"
          : "Choose a repository to continue";

  // The home screen has no footer and sizes to its content; the wizard screens
  // are a fixed height so no control moves as you fill them in.
  const isHome = !result && screen === "home";
  const onBack = isHome || result ? null : goHome;

  return createPortal(
    <div
      className="new-project-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={heading.title}
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className={`new-project-modal ${isHome ? "fit" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="new-project-header">
          {onBack ? (
            <button
              type="button"
              className="new-project-header-icon as-back"
              onClick={onBack}
              disabled={busy}
              aria-label="Back"
              title="Back"
            >
              <ArrowLeft size={16} />
            </button>
          ) : (
            <span className="new-project-header-icon">
              <FolderPlus size={16} />
            </span>
          )}
          <div className="new-project-header-text">
            <h2 className="new-project-title">{heading.title}</h2>
            <p className="new-project-subtitle">{heading.sub}</p>
          </div>
          <button
            type="button"
            className="new-project-close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        {result
          ? resultBody
          : screen === "home"
            ? homeBody
            : screen === "github"
              ? githubBody
              : newBody}

        {!isHome && (
          <footer className="new-project-footer">
            <span
              className={`new-project-note ${error ? "error" : ""}`}
              title={error ?? footerNote}
            >
              {error && <CircleAlert size={13} />}
              {error ?? footerNote}
            </span>
            <div className="new-project-actions">
              <button
                type="button"
                className="new-project-cancel"
                onClick={onClose}
                disabled={busy}
              >
                {result ? "Close" : "Cancel"}
              </button>
              <button
                type="button"
                className="new-project-submit"
                onClick={
                  result
                    ? () => void onOpen(result.repo.path).then(onClose)
                    : screen === "github"
                      ? handleClone
                      : handleCreate
                }
                disabled={
                  result ? false : screen === "github" ? !canClone : !canCreate
                }
              >
                {result
                  ? "Open project"
                  : screen === "github"
                    ? busy
                      ? "Cloning…"
                      : "Clone"
                    : busy
                      ? "Creating…"
                      : "Create project"}
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
