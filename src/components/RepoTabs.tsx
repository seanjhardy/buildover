import { House, ShoppingBag } from "lucide-react";
import { OpenRepoMenu } from "./OpenRepoMenu.js";
import { StatusIcon } from "./StatusIcon.js";
import type { ChatStatus, RecentRepoInfo, RepoInfo } from "../types.js";

interface Props {
  openRepos: RepoInfo[];
  activeRepoPath: string | null;
  recents: RecentRepoInfo[];
  onHome: () => void;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onOpen: (path: string) => Promise<void>;
  onForgetRecent: (path: string) => void;
  badges?: Record<string, ChatStatus | null>;
  marketActive?: boolean;
  homeActive?: boolean;
  onMarket?: () => void;
}

export function RepoTabs({
  openRepos,
  activeRepoPath,
  recents,
  onHome,
  onSelect,
  onClose,
  onOpen,
  onForgetRecent,
  badges,
  marketActive,
  homeActive,
  onMarket,
}: Props) {
  return (
    <div className="repo-tabs">
      <div className="repo-tabs-list">
        <div className="repo-tabs-nav-group">
          <button
            type="button"
            className={`repo-tab repo-tab--home ${homeActive ? "active" : ""}`}
            onClick={onHome}
            title="Home"
          >
            <House size={13} />
            <span className="repo-tab-name">Home</span>
          </button>
          <button
            type="button"
            className={`repo-tab repo-tab--market ${marketActive ? "active" : ""}`}
            onClick={onMarket}
            title="Plugin Marketplace"
          >
            <ShoppingBag size={13} />
            <span className="repo-tab-name">Market</span>
          </button>
        </div>
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
              <span className="repo-tab-badge">
                {badge && <StatusIcon status={badge} />}
              </span>
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
