import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { Composer } from "./components/Composer.js";
import { EmptyChat, EmptyWorkspace } from "./components/EmptyStates.js";
import { DashboardPanel } from "./components/Dashboard.js";
import { McpPanel } from "./components/McpPanel.js";
import { MessageJumpBar } from "./components/MessageJumpBar.js";
import { MessageList } from "./components/MessageList.js";
import { OrchestratorBar, type OrchestratorWakeTrigger } from "./components/OrchestratorBar.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { QueuedMessages, type QueuedMessage } from "./components/QueuedMessages.js";
import { ChatSidebar } from "./components/ChatSidebar.js";
import { RepoTabs } from "./components/RepoTabs.js";
import { SchedulePanel } from "./components/SchedulePanel.js";
import { TodoPanel } from "./components/TodoPanel.js";
import { UsageBar } from "./components/UsageBar.js";
import { useAgent } from "./hooks/useAgent.js";
import { useAudioRingBuffer } from "./hooks/useAudioRingBuffer.js";
import { useChats } from "./hooks/useChats.js";
import { useTodos } from "./hooks/useTodos.js";
import { useWakeWord } from "./hooks/useWakeWord.js";
import { useWorkspace } from "./hooks/useWorkspace.js";
import { api } from "./lib/api.js";
import {
  MODELS,
  type Attachment,
  type Model,
  type OrchestratorNav,
  type PermissionMode,
} from "./types.js";

const WAKE_WORD_STORAGE_KEY = "buildover.wakeWordEnabled";
const PERMISSION_MODE_STORAGE_KEY = "buildover.permissionMode";

export default function App() {
  const workspace = useWorkspace();
  const { activeRepo, activeChatId } = workspace;

  const chats = useChats(activeRepo?.path ?? null);
  const agent = useAgent(activeRepo?.path ?? null, activeChatId);
  const todos = useTodos(agent.turns);

  const [model, setModel] = useState<Model>("claude-sonnet-4-6");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    try {
      const stored = localStorage.getItem(PERMISSION_MODE_STORAGE_KEY);
      if (
        stored === "default" ||
        stored === "acceptEdits" ||
        stored === "plan" ||
        stored === "bypassPermissions"
      ) {
        return stored;
      }
    } catch { /* ignore */ }
    return "bypassPermissions";
  });
  const [mcpOpen, setMcpOpen] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  // Per-chat draft text: chatId → current unsent composer text.
  // Populated live by the Composer's onDraftChange callback so the sidebar
  // can show the draft as a subtitle even for non-active chats.
  const [chatDrafts, setChatDrafts] = useState<Record<string, string>>({});

  // Seed chatDrafts from localStorage when the set of chat IDs changes (new
  // repo, new chat created, chat deleted) — NOT on every WS status update.
  // Using a joined ID string as the dep is cheaper than a deep comparison and
  // avoids localStorage reads on every incoming WebSocket event.
  const chatIdsKey = chats.chats.map((c) => c.id).join(",");
  useEffect(() => {
    const drafts: Record<string, string> = {};
    for (const chat of chats.chats) {
      try {
        const stored = localStorage.getItem(`buildover.draft.${chat.id}`);
        if (stored) drafts[chat.id] = stored;
      } catch { /* ignore */ }
    }
    setChatDrafts(drafts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatIdsKey]);
  const [todoNarrow, setTodoNarrow] = useState(false);
  const prevStreamingRef = useRef(false);
  // msgScrollRef points at .message-area (the scroll container).
  // MessageList and MessageJumpBar both use it for scroll operations.
  const msgScrollRef = useRef<HTMLDivElement>(null);
  const chatPaneRef = useRef<HTMLElement>(null);
  // Keep refs to the latest values so the streaming effect never reads stale closures.
  const messageQueueRef = useRef(messageQueue);
  messageQueueRef.current = messageQueue;
  const modelRef = useRef(model);
  modelRef.current = model;
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  const agentRef = useRef(agent);
  agentRef.current = agent;

  // Imperative handle so the wake word hook can activate the orchestrator mic.
  const wakeWordTriggerRef = useRef<OrchestratorWakeTrigger>(null);

  // Collapse the todo side panel to a compact button when the chat pane is narrow.
  useEffect(() => {
    const el = chatPaneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setTodoNarrow(entry.contentRect.width < 700);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Wake word ──────────────────────────────────────────────────────────────
  const [wakeWordEnabled, setWakeWordEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(WAKE_WORD_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  // Always-on ring buffer: captures the last 5s of raw PCM audio so we can
  // feed the pre-detection audio into Groq when the wake word fires.
  const ringBuffer = useAudioRingBuffer({ bufferSeconds: 5 });

  const wakeWord = useWakeWord({
    onDetected: () => {
      // Extract the last 3 seconds of buffered audio (covers the wake phrase
      // + any words spoken immediately after it) and pass it as a seed to the
      // Orchestrator voice segmenter so Groq transcribes from before the
      // trigger point. The buffer is cleared inside extractBlob so the next
      // detection starts fresh.
      const seedBlob = ringBuffer.extractBlob(3);
      wakeWordTriggerRef.current?.activateMic(seedBlob ?? undefined);
    },
  });

  // Persist the enabled preference and start/stop the listener accordingly.
  useEffect(() => {
    try {
      localStorage.setItem(WAKE_WORD_STORAGE_KEY, String(wakeWordEnabled));
    } catch { /* ignore */ }

    if (wakeWordEnabled) {
      void wakeWord.start();
      void ringBuffer.start();
    } else {
      void wakeWord.stop();
      ringBuffer.stop();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeWordEnabled]);

  // After the wake word fires and the mic activates, re-arm the listener once
  // the wake word transitions from "listening" → "idle" (i.e. a detection
  // paused it). We watch for the "idle" transition and restart if still enabled.
  const prevWakeStateRef = useRef(wakeWord.state);
  useEffect(() => {
    const prev = prevWakeStateRef.current;
    prevWakeStateRef.current = wakeWord.state;
    // "listening" → "idle" means the engine paused itself on detection.
    if (wakeWordEnabled && prev === "listening" && wakeWord.state === "idle") {
      void wakeWord.start();
    }
  }, [wakeWord.state, wakeWordEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleWakeWord = () => {
    setWakeWordEnabled((v) => !v);
  };

  // ── Permission mode persistence & per-chat sync ────────────────────────────

  // Persist the user's chosen permission mode so it survives page reloads.
  useEffect(() => {
    try {
      localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, permissionMode);
    } catch { /* ignore */ }
  }, [permissionMode]);

  // When the active chat changes (chat_replay arrives), sync the UI permission
  // mode to match whatever was saved for that specific chat.
  useEffect(() => {
    if (agent.chatPermissionMode != null) {
      setPermissionMode(agent.chatPermissionMode);
    }
  }, [agent.chatPermissionMode]);

  // ── Message queue ──────────────────────────────────────────────────────────

  // Clear queue when switching chats
  useEffect(() => {
    setMessageQueue([]);
  }, [activeChatId]);

  // Belt-and-braces auto-allow: when the user is in bypassPermissions, any
  // permission_request that slips through (for example, one already in flight
  // when the mode was toggled) is silently approved. The server-side guard in
  // canUseTool handles the steady state; this catches the race window.
  // Exception: ExitPlanMode and RequestUserAttention must always show the
  // permission UI — they are user-interaction checkpoints, not dangerous ops.
  const ALWAYS_PROMPT_TOOLS = new Set(["ExitPlanMode", "RequestUserAttention"]);
  useEffect(() => {
    if (permissionMode !== "bypassPermissions") return;
    const pending = agent.pendingPermission;
    if (!pending) return;
    if (ALWAYS_PROMPT_TOOLS.has(pending.toolName)) return;
    agent.respondPermission(pending.requestId, { behavior: "allow" });
  }, [permissionMode, agent.pendingPermission, agent.respondPermission]);

  // When the agent finishes a turn, automatically send the next queued message.
  // We read all mutable values through refs so this effect never captures stale
  // closures – the only thing that should re-trigger it is the streaming flag.
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = agent.isStreaming;
    if (wasStreaming && !agent.isStreaming && messageQueueRef.current.length > 0) {
      const [next, ...rest] = messageQueueRef.current;
      setMessageQueue(rest);
      agentRef.current.send(next.text, {
        model: modelRef.current,
        permissionMode: permissionModeRef.current,
        attachments: next.attachments,
      });
    }
  }, [agent.isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  const addToQueue = (text: string, attachments: Attachment[]) => {
    setMessageQueue((prev) => [
      ...prev,
      {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text,
        attachments,
      },
    ]);
  };

  const removeFromQueue = (id: string) => {
    setMessageQueue((prev) => prev.filter((m) => m.id !== id));
  };

  // Move a queued message to the front and interrupt the current turn. The
  // existing streaming->idle transition effect will then auto-send it.
  const fastForwardQueued = (id: string) => {
    setMessageQueue((prev) => {
      const target = prev.find((m) => m.id === id);
      if (!target) return prev;
      return [target, ...prev.filter((m) => m.id !== id)];
    });
    agent.interrupt();
  };

  const handleCreateChat = useCallback(async () => {
    if (!activeRepo) return;
    const record = await chats.createChat(model, permissionMode);
    workspace.setActiveChat(record.id);
  }, [activeRepo, chats, model, permissionMode, workspace]);

  const handleDeleteChat = useCallback(async (chatId: string) => {
    await chats.deleteChat(chatId);
    if (activeChatId === chatId) workspace.setActiveChat(null);
  }, [chats, activeChatId, workspace]);

  const handleSelectChat = useCallback((id: string) => {
    workspace.setActiveChat(id);
  }, [workspace]);

  const handleToggleFinished = useCallback((id: string, finished: boolean) => {
    void chats.setUserFinished(id, finished);
  }, [chats]);

  // Stable callback so Composer receives the same function reference across
  // renders and the debounced draft notification doesn't re-trigger unnecessarily.
  const handleDraftChange = useCallback(
    (draft: string) => {
      if (!activeChatId) return;
      setChatDrafts((prev) => ({ ...prev, [activeChatId]: draft }));
    },
    [activeChatId],
  );

  const handleForgetRecent = async (path: string) => {
    await api.removeRecent(path);
    void workspace.reloadRecents();
  };

  // The orchestrator navigates the UI via WS-pushed nav actions. Each maps
  // straight onto existing workspace methods. open_repo issues a REST call,
  // so we do it through workspace.openRepo (which also touches recents).
  const handleOrchestratorNav = useCallback(
    async (nav: OrchestratorNav) => {
      switch (nav.action) {
        case "open_repo":
          await workspace.openRepo(nav.path);
          break;
        case "switch_chat":
          // Make sure the repo containing the chat is the active one before
          // setting active chat (active chat is keyed by active repo).
          if (workspace.activeRepo?.path !== nav.repoPath) {
            await workspace.openRepo(nav.repoPath);
          }
          workspace.setActiveChat(nav.chatId);
          break;
        case "create_chat":
          if (workspace.activeRepo?.path !== nav.repoPath) {
            await workspace.openRepo(nav.repoPath);
          }
          // The new chat already exists on disk and the orchestrator will
          // start streaming to it; refresh the sidebar so it appears.
          void chats.reload();
          workspace.setActiveChat(nav.chatId);
          break;
      }
    },
    [workspace, chats],
  );

  const activeChat =
    activeChatId != null
      ? (chats.chats.find((c) => c.id === activeChatId) ?? null)
      : null;

  // Wake word button title
  const wakeWordTitle = !wakeWord.isSupported
    ? "Wake word unavailable (requires Web Audio API)"
    : wakeWord.error
      ? `Wake word error: ${wakeWord.error}`
      : wakeWordEnabled
        ? `Wake word active — say "Hey Jarvis" to start mic (click to disable)`
        : `Enable wake word — say "Hey Jarvis" to start mic`;

  return (
    <div className={`app-shell ${mcpOpen ? "with-panel" : ""}`}>
      <div className="app">
        <header className="app-header">
          <h1>
            <span className="brand-dot" />
            buildover
          </h1>
          <div className="app-header-right">
            <UsageBar />

            {/* Dashboard toggle */}
            <button
              className={`wake-word-btn ${dashboardOpen ? "active" : ""}`}
              onClick={() => { setDashboardOpen((v) => !v); setScheduleOpen(false); }}
              title="Global dashboard — notes & todos"
              aria-pressed={dashboardOpen}
            >
              <span style={{ fontSize: 13 }}>📋</span>
              <span className="wake-word-label">Dashboard</span>
            </button>

            {/* Schedule toggle */}
            <button
              className={`wake-word-btn ${scheduleOpen ? "active" : ""}`}
              onClick={() => { setScheduleOpen((v) => !v); setDashboardOpen(false); }}
              title="Scheduled tasks"
              aria-pressed={scheduleOpen}
            >
              <span style={{ fontSize: 13 }}>⏰</span>
              <span className="wake-word-label">Schedules</span>
            </button>

            {/* Wake word toggle */}
            {wakeWord.isSupported && (
              <button
                className={`wake-word-btn ${wakeWordEnabled ? "active" : ""} ${wakeWord.state === "error" ? "error" : ""}`}
                onClick={toggleWakeWord}
                title={wakeWordTitle}
                aria-label={wakeWordTitle}
                aria-pressed={wakeWordEnabled}
              >
                {wakeWordEnabled ? (
                  <Mic size={13} />
                ) : (
                  <MicOff size={13} />
                )}
                <span className="wake-word-label">
                  {wakeWord.state === "listening"
                    ? "listening…"
                    : wakeWord.state === "starting"
                      ? "starting…"
                      : wakeWordEnabled
                        ? "wake word on"
                        : "wake word"}
                </span>
                {wakeWord.state === "listening" && (
                  <span className="wake-word-pulse" aria-hidden="true" />
                )}
              </button>
            )}

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
              onSelect={handleSelectChat}
              onCreate={handleCreateChat}
              onToggleFinished={handleToggleFinished}
              onDelete={handleDeleteChat}
              repoPath={activeRepo.path}
              chatDrafts={chatDrafts}
            />

            <main className="chat-pane" ref={chatPaneRef}>
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
                  <div className="chat-pane-body">
                    <div className="chat-group">
                      <div className="chat-column">
                        <MessageList
                          turns={agent.turns}
                          isStreaming={agent.isStreaming}
                          cwd={agent.cwd ?? activeRepo.path}
                          scrollRef={msgScrollRef}
                          chatId={activeChatId ?? undefined}
                        />
                        {agent.pendingPermission && (
                          <PermissionPrompt
                            pending={agent.pendingPermission}
                            onRespond={agent.respondPermission}
                          />
                        )}
                        <div style={{ display: agent.pendingPermission ? "none" : undefined }}>
                          <QueuedMessages
                            queue={messageQueue}
                            onRemove={removeFromQueue}
                            onFastForward={fastForwardQueued}
                          />
                          <Composer
                            key={activeChatId ?? "none"}
                            chatId={activeChatId ?? ""}
                            onSend={(text, attachments) =>
                              agent.send(text, {
                                model,
                                permissionMode,
                                attachments,
                              })
                            }
                            onQueueMessage={addToQueue}
                            onInterrupt={agent.interrupt}
                            onDraftChange={handleDraftChange}
                            disabled={
                              agent.isStreaming || agent.connection !== "connected"
                            }
                            isStreaming={agent.isStreaming}
                            model={model}
                            permissionMode={permissionMode}
                            onPermissionModeChange={(m) => {
                              setPermissionMode(m);
                              // Push the change to the in-flight turn so toggling
                              // bypass mid-turn auto-resolves pending prompts and
                              // suppresses future ones.
                              agent.setPermissionMode(m);
                            }}
                            onToggleMcp={() => setMcpOpen((v) => !v)}
                          />
                        </div>
                      </div>
                      {/* right-rail: jump bar + todo (row when wide, column when narrow) */}
                      <div className={`right-rail${todoNarrow ? " right-rail--narrow" : ""}`}>
                        <MessageJumpBar
                          turns={agent.turns}
                          scrollRef={msgScrollRef}
                        />
                        {todos.length > 0 && (
                          <TodoPanel todos={todos} compact={todoNarrow} />
                        )}
                      </div>
                    </div>
                  </div>
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
      {dashboardOpen && (
        <DashboardPanel onClose={() => setDashboardOpen(false)} />
      )}
      {scheduleOpen && (
        <SchedulePanel
          activeRepoPath={activeRepo?.path ?? null}
          onClose={() => setScheduleOpen(false)}
        />
      )}
      <OrchestratorBar
        activeRepoPath={activeRepo?.path ?? null}
        onNavigate={(nav) => void handleOrchestratorNav(nav)}
        wakeWordTriggerRef={wakeWordTriggerRef}
      />
    </div>
  );
}
