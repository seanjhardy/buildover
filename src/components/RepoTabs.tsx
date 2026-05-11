import { OpenRepoMenu } from "./OpenRepoMenu.js";
import { StatusIcon } from "./StatusIcon.js";
import type { ChatStatus, RecentRepoInfo, RepoInfo } from "../types.js";

interface Props {
  openRepos: RepoInfo[];
  activeRepoPath: string | null;
  recents: RecentRepoInfo[];
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onOpen: (path: string) => Promise<void>;
  onForgetRecent: (path: string) => void;
  badges?: Record<string, ChatStatus | null>;
}

export function RepoTabs({
  openRepos,
  activeRepoPath,
  recents,
  onSelect,
  onClose,
  onOpen,
  onForgetRecent,
  badges,
}: Props) {
  return (
    <div className="repo-tabs">
      <div className="repo-tabs-list">
        {openRepos.map((repo) => {
          const badge = badges?.[repo.path] ?? null;
          return (
            <button
              key={repo.path}
              type="button"
              className={`repo-tab ${
                repo.path === activeRepoPath ? "active" : ""
              }`}
              onClick={() => onSelect(repo.path)}
              title={repo.path}
            >
              <span className="repo-tab-name">{repo.name}</span>
              {badge && (
                <span className="repo-tab-badge">
                  <StatusIcon status={badge} />
                </span>
              )}
              <span
                className="repo-tab-close"
                role="button"
                aria-label={`Close ${repo.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(repo.path);
                }}
              >
                ×
              </span>
            </button>
          );
        })}
        <OpenRepoMenu
          recents={recents}
          openPaths={openRepos.map((r) => r.path)}
          onOpen={onOpen}
          onForgetRecent={onForgetRecent}
        />
      </div>
    </div>
  );
}
