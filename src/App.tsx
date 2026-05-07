import { useState } from "react";
import { Composer } from "./components/Composer.js";
import { EmptyChat, EmptyWorkspace } from "./components/EmptyStates.js";
import { McpPanel } from "./components/McpPanel.js";
import { MessageList } from "./components/MessageList.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { ChatSidebar } from "./components/ChatSidebar.js";
import { RepoTabs } from "./components/RepoTabs.js";
import { UsageBar } from "./components/UsageBar.js";
import { useAgent } from "./hooks/useAgent.js";
import { useChats } from "./hooks/useChats.js";
import { useWorkspace } from "./hooks/useWorkspace.js";
import { api } from "./lib/api.js";
import { MODELS, type Model, type PermissionMode } from "./types.js";

export default function App() {
  const workspace = useWorkspace();
  const { activeRepo, activeChatId } = workspace;

  const chats = useChats(activeRepo?.path ?? null);
  const agent = useAgent(activeRepo?.path ?? null, activeChatId);

  const [model, setModel] = useState<Model>("claude-sonnet-4-6");
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>("default");
  const [mcpOpen, setMcpOpen] = useState(false);

  const handleCreateChat = async () => {
    if (!activeRepo) return;
    const record = await chats.createChat(model, permissionMode);
    workspace.setActiveChat(record.id);
  };

  const handleDeleteChat = async (chatId: string) => {
    await chats.deleteChat(chatId);
    if (activeChatId === chatId) workspace.setActiveChat(null);
  };

  const handleForgetRecent = async (path: string) => {
    await api.removeRecent(path);
    void workspace.reloadRecents();
  };

  const activeChat =
    activeChatId != null
      ? (chats.chats.find((c) => c.id === activeChatId) ?? null)
      : null;

  return (
    <div className={`app-shell ${mcpOpen ? "with-panel" : ""}`}>
      <div className="app">
        <header className="app-header">
          <h1>
            <span className="brand-dot" />
            buildover
          </h1>
          <div className="app-header-right">
            <div className="header-model">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value as Model)}
                disabled={agent.isStreaming}
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            {agent.sessionId && (
              <div className="header-session">
                session {agent.sessionId.slice(0, 8)}
              </div>
            )}
            <div
              className={`connection-pill ${
                agent.connection === "connected"
                  ? "connected"
                  : agent.connection === "error"
                    ? "error"
                    : ""
              }`}
            >
              <span className="dot" />
              {agent.connection}
            </div>
          </div>
        </header>

        <RepoTabs
          openRepos={workspace.openRepos}
          activeRepoPath={activeRepo?.path ?? null}
          recents={workspace.recents}
          onSelect={workspace.setActiveRepo}
          onClose={workspace.closeRepo}
          onOpen={async (path) => {
            await workspace.openRepo(path);
          }}
          onForgetRecent={handleForgetRecent}
        />

        {!activeRepo ? (
          <EmptyWorkspace
            recents={workspace.recents}
            onOpen={async (path) => {
              await workspace.openRepo(path);
            }}
            onForgetRecent={handleForgetRecent}
          />
        ) : (
          <div className="workspace">
            <ChatSidebar
              chats={chats.chats}
              activeChatId={activeChatId}
              onSelect={(id) => workspace.setActiveChat(id)}
              onCreate={handleCreateChat}
              onToggleFinished={(id, finished) =>
                chats.setUserFinished(id, finished)
              }
              onDelete={handleDeleteChat}
            />

            <main className="chat-pane">
              {!activeChat ? (
                <EmptyChat onCreate={handleCreateChat} />
              ) : (
                <>
                  <div className="chat-pane-header">
                    <div className="chat-pane-title">{activeChat.title}</div>
                    <div className="chat-pane-meta">
                      {activeRepo.path}
                    </div>
                  </div>
                  <MessageList
                    turns={agent.turns}
                    isStreaming={agent.isStreaming}
                  />
                  {agent.pendingPermission ? (
                    <PermissionPrompt
                      pending={agent.pendingPermission}
                      onRespond={agent.respondPermission}
                    />
                  ) : (
                    <Composer
                      onSend={(text, attachments) =>
                        agent.send(text, {
                          model,
                          permissionMode,
                          attachments,
                        })
                      }
                      onInterrupt={agent.interrupt}
                      disabled={
                        agent.isStreaming || agent.connection !== "connected"
                      }
                      isStreaming={agent.isStreaming}
                      model={model}
                      permissionMode={permissionMode}
                      onPermissionModeChange={setPermissionMode}
                      onToggleMcp={() => setMcpOpen((v) => !v)}
                    />
                  )}
                  <UsageBar />
                </>
              )}
            </main>
          </div>
        )}
      </div>
      {mcpOpen && (
        <McpPanel
          tools={agent.tools}
          mcpServers={agent.mcpServers}
          cwd={agent.cwd}
          onClose={() => setMcpOpen(false)}
        />
      )}
    </div>
  );
}
