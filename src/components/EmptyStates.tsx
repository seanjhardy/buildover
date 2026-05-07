import { OpenRepoMenu } from "./OpenRepoMenu.js";
import type { RecentRepoInfo } from "../types.js";

interface EmptyWorkspaceProps {
  recents: RecentRepoInfo[];
  onOpen: (path: string) => Promise<void>;
  onForgetRecent: (path: string) => void;
}

export function EmptyWorkspace({
  recents,
  onOpen,
  onForgetRecent,
}: EmptyWorkspaceProps) {
  return (
    <div className="empty-workspace">
      <div className="empty-workspace-card">
        <h2>Open a repository</h2>
        <p>
          Browse for a folder or pick a recent one to start a chat with Claude
          inside it.
        </p>
        <OpenRepoMenu
          recents={recents}
          openPaths={[]}
          onOpen={onOpen}
          onForgetRecent={onForgetRecent}
        />
      </div>
    </div>
  );
}

interface EmptyChatProps {
  onCreate: () => void;
}

export function EmptyChat({ onCreate }: EmptyChatProps) {
  return (
    <div className="empty-chat">
      <div className="empty-chat-card">
        <h3>No chat selected</h3>
        <p>Pick a chat from the sidebar, or start a new one.</p>
        <button type="button" className="primary-btn" onClick={onCreate}>
          + New chat
        </button>
      </div>
    </div>
  );
}
