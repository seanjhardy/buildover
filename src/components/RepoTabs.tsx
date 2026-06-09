import { useState } from "react";
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
  onReorder?: (fromPath: string, toPath: string) => void;
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
  onReorder,
  badges,
  marketActive,
  homeActive,
  onMarket,
}: Props) {
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  const handleDragStart = (path: string) => (e: React.DragEvent) => {
    setDraggedPath(path);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (path: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverPath(path);
  };

  const handleDragLeave = () => {
    setDragOverPath(null);
  };

  const handleDrop = (toPath: string) => (e: React.DragEvent) => {
    e.preventDefault();
    if (draggedPath !== null && draggedPath !== toPath && onReorder) {
      onReorder(draggedPath, toPath);
    }
    setDraggedPath(null);
    setDragOverPath(null);
  };

  const handleDragEnd = () => {
    setDraggedPath(null);
    setDragOverPath(null);
  };

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
          const isDragging = draggedPath === repo.path;
          const isDragOver = dragOverPath === repo.path;
          return (
            <button
              key={repo.path}
              type="button"
              draggable
              className={`repo-tab ${
                repo.path === activeRepoPath ? "active" : ""
              } ${isDragging ? "dragging" : ""} ${isDragOver ? "drag-over" : ""}`}
              onClick={() => onSelect(repo.path)}
              onDragStart={handleDragStart(repo.path)}
              onDragOver={handleDragOver(repo.path)}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop(repo.path)}
              onDragEnd={handleDragEnd}
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
