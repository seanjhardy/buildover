import { useState } from "react";
import { NewProjectModal } from "./NewProjectModal.js";
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

  return (
    <div className="open-repo-menu">
      <button
        type="button"
        className="repo-tab open-repo-trigger"
        onClick={() => setOpen(true)}
        title="Clone, open or create a project"
      >
        + New project
      </button>
      {open && (
        <NewProjectModal
          recents={recents}
          openPaths={openPaths}
          onClose={() => setOpen(false)}
          onOpen={onOpen}
          onForgetRecent={onForgetRecent}
        />
      )}
    </div>
  );
}
