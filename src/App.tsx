import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "./hooks/useTheme.js";
import { useRunConfig } from "./hooks/useRunConfig.js";
import { PreviewPane } from "./components/PreviewPane.js";
import type { TerminalPanelHandle } from "./components/TerminalPanel.js";
import { Mic, MicOff } from "lucide-react";
import { Composer } from "./components/Composer.js";
import { EmptyChat, EmptyWorkspace } from "./components/EmptyStates.js";
import { DashboardPanel } from "./components/Dashboard.js";
import { McpPanel } from "./components/McpPanel.js";
import { MessageJumpBar } from "./components/MessageJumpBar.js";
import { MessageList, type JumpBarHandle } from "./components/MessageList.js";
import { OrchestratorBar, type OrchestratorWakeTrigger } from "./components/OrchestratorBar.js";
import { AttentionPrompt, PermissionPrompt } from "./components/PermissionPrompt.js";
import { QueuedMessages, type QueuedMessage } from "./components/QueuedMessages.js";
import { ChatSidebar } from "./components/ChatSidebar.js";
import { PreviewChatSidebar } from "./components/PreviewChatSidebar.js";
import { GitGraphView, type GitGraphViewHandle } from "./components/GitGraphView.js";
import { ActivityBar, type WorkspaceView } from "./components/ActivityBar.js";
import { SourceControlSidebar } from "./components/SourceControlSidebar.js";
import { PullRequestSidebar } from "./components/PullRequestSidebar.js";
import { PullRequestView } from "./components/PullRequestView.js";
import { CreatePrForm } from "./components/CreatePrForm.js";
import { RepoTabs } from "./components/RepoTabs.js";
import { MarketPanel } from "./components/MarketPanel.js";
import { SchedulePanel } from "./components/SchedulePanel.js";
import { TodoPanel } from "./components/TodoPanel.js";
import { FilesPanel } from "./components/FilesPanel.js";
import { FileViewer } from "./components/FileViewer.js";
import { UsageBar } from "./components/UsageBar.js";
import { useAgent } from "./hooks/useAgent.js";
import { useAllRepoChats } from "./hooks/useAllRepoChats.js";
import { useAudioRingBuffer } from "./hooks/useAudioRingBuffer.js";
import { useChats } from "./hooks/useChats.js";
import { useNotifications } from "./hooks/useNotifications.js";
import { useRepoTabBadges } from "./hooks/useRepoTabBadges.js";
import { useTodos } from "./hooks/useTodos.js";
import { useFilesChanged } from "./hooks/useFilesChanged.js";
import { useWakeWord } from "./hooks/useWakeWord.js";
import { useWorkspace } from "./hooks/useWorkspace.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { UpdateBanner } from "./components/UpdateBanner.js";
import { agentSocket } from "./lib/agentSocket.js";
import { api, gitApi, githubApi, selfUpdateApi } from "./lib/api.js";
import type { GitHubPR, ChangedFile } from "./lib/api.js";
import { useSelfUpdate } from "./hooks/useSelfUpdate.js";
import type { FileEntry } from "./hooks/useFilesChanged.js";
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
  useTheme(); // Initialize theme from localStorage on mount
  const { activeRepo, activeChatId } = workspace;

  // Track chat statuses for all open repos so inactive tabs can show badges.
  // Must come before useChats so we can pass the pre-fetched list as initial
  // state — this eliminates the loading flash when switching between repos.
  const openRepoPaths = workspace.openRepos.map((r) => r.path);
  const allRepoChats = useAllRepoChats(openRepoPaths);
  const { badges: repoTabBadges, markSeen: markRepoTabSeen } =
    useRepoTabBadges(openRepoPaths, activeRepo?.path ?? null, allRepoChats);

  // Seed useChats with whatever useAllRepoChats already has for this repo so
  // switching to a repo that has been prefetched shows its chats immediately.
  const prefetchedChats = activeRepo ? (allRepoChats[activeRepo.path] ?? null) : null;
  const chats = useChats(activeRepo?.path ?? null, prefetchedChats);
  const agent = useAgent(activeRepo?.path ?? null, activeChatId);
  const todos = useTodos(agent.turns);
  const filesChanged = useFilesChanged(
    agent.turns,
    agent.cwd ?? activeRepo?.path ?? "",
    activeRepo?.path ?? "",
  );

  // Dock badge + native macOS notifications for agent status changes.
  useNotifications(allRepoChats);

  // Self-update checker — polls /api/self/status every 10 minutes.
  const selfUpdate = useSelfUpdate();

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
  const [activeView, setActiveView] = useState<WorkspaceView>('chat');
  const [activePrNumber, setActivePrNumber] = useState<number | null>(null);
  // The lightweight PR object from the sidebar list — used to seed PullRequestView
  // immediately so it renders without a loading screen while the detail fetch runs.
  const [activePr, setActivePr] = useState<GitHubPR | null>(null);
  const [creatingPr, setCreatingPr] = useState(false);
  // Bumping this triggers a background refresh of the PR sidebar list.
  const [prRefreshKey, setPrRefreshKey] = useState(0);
  // Reset selected PR when the active repo changes so we don't try to load a
  // PR number from a previous repo against the new one.
  useEffect(() => { setActivePrNumber(null); setActivePr(null); setCreatingPr(false); }, [activeRepo?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  // Clear source-control file preview when the active repo changes
  useEffect(() => { setScPreviewFile(null); }, [activeRepo?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const [prBadge, setPrBadge] = useState(0);
  const [scBadge, setScBadge] = useState(0);

  // Poll git status for sc badge count (changed files + ahead/behind)
  useEffect(() => {
    if (!activeRepo) { setScBadge(0); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const [status, files] = await Promise.all([
          gitApi.getStatus(activeRepo.path),
          gitApi.getStatusFiles(activeRepo.path).catch(() => []),
        ]);
        if (!cancelled) {
          setScBadge((status.ahead ?? 0) + (status.behind ?? 0) + files.length);
        }
      } catch { /* ignore */ }
    };
    void poll();
    const interval = setInterval(() => void poll(), 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeRepo?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll open PR count for pr badge
  useEffect(() => {
    if (!activeRepo) { setPrBadge(0); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const prs = await githubApi.listPRs(activeRepo.path);
        if (!cancelled) {
          setPrBadge(prs.filter((p) => p.state === 'OPEN').length);
        }
      } catch { /* gh not available or not authenticated — suppress badge */ }
    };
    void poll();
    const interval = setInterval(() => void poll(), 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeRepo?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const [mcpOpen, setMcpOpen] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // Per-repo git graph open state — preserves view when switching repos
  const [gitGraphOpenByRepo, setGitGraphOpenByRepo] = useState<Record<string, boolean>>({});
  const gitGraphOpen = activeRepo ? (gitGraphOpenByRepo[activeRepo.path] ?? false) : false;
  const setGitGraphOpen = useCallback((open: boolean) => {
    const path = activeRepo?.path;
    if (!path) return;
    setGitGraphOpenByRepo((prev) => ({ ...prev, [path]: open }));
  }, [activeRepo?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const [marketOpen, setMarketOpen] = useState(false);
  const [homeOpen, setHomeOpen] = useState(false);
  const [previewActive, setPreviewActive] = useState(false);
  // Pin the URL at the moment the user opens preview so the iframe survives
  // repo-tab switches (runConfig changes per-repo, but the live app doesn't).
  const [pinnedPreviewUrl, setPinnedPreviewUrl] = useState<string | null>(null);
  const openPreview = () => {
    if (runConfig.config?.previewUrl && runConfig.isPortListening) {
      setPinnedPreviewUrl(runConfig.config.previewUrl);
      setPreviewActive(true);
    }
  };
  const closePreview = () => {
    setPreviewActive(false);
    setPinnedPreviewUrl(null);
  };
  const [runSetupActive, setRunSetupActive] = useState(false);
  // Tracks which repo the in-progress setup is targeting, so the spinner only
  // clears when the user is viewing THAT repo and its config has loaded.
  const runSetupTargetRef = useRef<string | null>(null);
  const terminalRefs = useRef<Map<string, TerminalPanelHandle>>(new Map());
  const gitGraphRef = useRef<GitGraphViewHandle>(null);
  const runConfig = useRunConfig(activeRepo?.path ?? null);
  // Clear the spinner only when we're back on the target repo and its config arrived
  useEffect(() => {
    if (
      runSetupActive &&
      runConfig.config &&
      activeRepo?.path === runSetupTargetRef.current
    ) {
      setRunSetupActive(false);
      runSetupTargetRef.current = null;
    }
  }, [runSetupActive, runConfig.config, activeRepo?.path]);
  // File viewer: null = hidden, FileEntry = open
  const [openFile, setOpenFile] = useState<FileEntry | null>(null);
  // Source-control inline file preview (replaces git graph when set)
  const [scPreviewFile, setScPreviewFile] = useState<ChangedFile | null>(null);
  // Per-chat message queues: chatId → queued messages for that chat.
  // Stored as a map so navigating away from a chat doesn't lose its queue.
  const [messageQueues, setMessageQueues] = useState<Record<string, QueuedMessage[]>>({});
  // Derive the active chat's queue from the map.
  const messageQueue = activeChatId ? (messageQueues[activeChatId] ?? []) : [];
  // Scoped setter that always writes into the active chat's slot.
  const setMessageQueue = useCallback(
    (updater: QueuedMessage[] | ((prev: QueuedMessage[]) => QueuedMessage[])) => {
      if (!activeChatId) return;
      setMessageQueues((prev) => {
        const current = prev[activeChatId] ?? [];
        const next = typeof updater === "function" ? updater(current) : updater;
        return { ...prev, [activeChatId]: next };
      });
    },
    [activeChatId],
  );
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
  // Collapse the right-rail todo panel when the window is too narrow.
  // Using window.innerWidth is reliable at all times (no DOM layout needed).
  // The right-rail panels start getting squeezed below ~1100px window width.
  const [todoNarrow, setTodoNarrow] = useState(() => window.innerWidth < 1100);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem('buildover-sidebar-width');
    return stored ? parseInt(stored, 10) : 280;
  });
  const [sidebarResizing, setSidebarResizing] = useState(false);

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    setSidebarResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.max(180, Math.min(520, startWidth + (ev.clientX - startX)));
      setSidebarWidth(newWidth);
      localStorage.setItem('buildover-sidebar-width', String(newWidth));
    };

    const onMouseUp = () => {
      setSidebarResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);
  useEffect(() => {
    const onResize = () => setTodoNarrow(window.innerWidth < 1100);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const prevStreamingRef = useRef(false);
  // msgScrollRef points at .message-area (the scroll container).
  // MessageList and MessageJumpBar both use it for scroll operations.
  const msgScrollRef = useRef<HTMLDivElement>(null);
  // jumpBarRef is written by MessageList and read by MessageJumpBar so the
  // jump bar can use the VirtualizerHandle API instead of DOM queries.
  const jumpBarRef = useRef<JumpBarHandle | null>(null);
  const chatPaneRef = useRef<HTMLElement>(null);
  const rightRailRef = useRef<HTMLDivElement>(null);
  // Keep refs to the latest values so the streaming effect never reads stale closures.
  const messageQueueRef = useRef(messageQueue);
  messageQueueRef.current = messageQueue;
  // Full queues map ref — used by the background auto-send effect so it always
  // reads the current queue for any chat without re-registering socket listeners.
  const messageQueuesRef = useRef(messageQueues);
  messageQueuesRef.current = messageQueues;
  // Active chat id ref — used by the background effect to skip the active chat
  // (which is already handled by the streaming effect below) to avoid double-sends.
  const activeChatIdRef = useRef(activeChatId);
  activeChatIdRef.current = activeChatId;
  // Active repo path ref — needed when sending messages for background chats.
  const activeRepoPathRef = useRef(activeRepo?.path ?? null);
  activeRepoPathRef.current = activeRepo?.path ?? null;
  const modelRef = useRef(model);
  modelRef.current = model;
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  const agentRef = useRef(agent);
  agentRef.current = agent;

  // Imperative handle so the wake word hook can activate the orchestrator mic.
  const wakeWordTriggerRef = useRef<OrchestratorWakeTrigger>(null);


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

  // Belt-and-braces auto-allow: when the user is in bypassPermissions, any
  // permission_request that slips through (for example, one already in flight
  // when the mode was toggled) is silently approved. The server-side guard in
  // canUseTool handles the steady state; this catches the race window.
  // Exception: ExitPlanMode, RequestUserAttention, and AskUserQuestion must
  // always show the permission UI — they are user-interaction checkpoints,
  // not dangerous ops.
  const ALWAYS_PROMPT_TOOLS = new Set(["ExitPlanMode", "RequestUserAttention", "AskUserQuestion"]);
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

  // Background auto-send: fire queued messages for chats that are NOT currently
  // active. The effect above handles the active chat; this one covers the case
  // where the user navigated away while messages were queued. We subscribe
  // directly to agentSocket so we receive events for any chat, not just the
  // active one. The effect re-runs whenever messageQueues changes so listeners
  // are registered/unregistered as chats gain or lose queued messages.
  useEffect(() => {
    // chatId → cleanup fn for the background listener on that chat.
    const cleanups = new Map<string, () => void>();

    // Register listeners for chats with a non-empty queue, and drop listeners
    // for chats whose queue has been drained.
    const syncListeners = () => {
      const queues = messageQueuesRef.current;

      // Drop listeners for chats that no longer have queued messages.
      for (const [chatId, cleanup] of cleanups) {
        if (!queues[chatId]?.length) {
          cleanup();
          cleanups.delete(chatId);
        }
      }

      // Add listeners for chats that now have queued messages.
      for (const [chatId, queue] of Object.entries(queues)) {
        if (!queue.length) continue;
        if (cleanups.has(chatId)) continue;

        const prevWasStreaming = { value: false };
        const unsub = agentSocket.onChatEvent(chatId, (event) => {
          // The active chat is already handled by the streaming effect above;
          // skip it here to avoid sending the same message twice.
          if (chatId === activeChatIdRef.current) return;

          if (event.type === "turn_start") {
            prevWasStreaming.value = true;
          }
          const turnFinished =
            event.type === "turn_end" ||
            (event.type === "chat_status" &&
              event.status !== "running" &&
              prevWasStreaming.value);
          if (!turnFinished) return;

          prevWasStreaming.value = false;
          const currentQueue = messageQueuesRef.current[chatId] ?? [];
          if (!currentQueue.length) return;
          const [next, ...rest] = currentQueue;
          // Dequeue the message optimistically before the send.
          setMessageQueues((prev) => ({ ...prev, [chatId]: rest }));
          const repoPath = activeRepoPathRef.current;
          if (!repoPath) return;
          agentSocket.send({
            type: "user_message",
            chatId,
            repoPath,
            text: next.text,
            model: modelRef.current,
            permissionMode: permissionModeRef.current,
            attachments: next.attachments,
          });
        });
        cleanups.set(chatId, unsub);
      }
    };

    syncListeners();

    return () => {
      for (const cleanup of cleanups.values()) cleanup();
    };
  }, [messageQueues]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setOpenFile(null);
    const record = await chats.createChat(model, permissionMode);
    workspace.setActiveChat(record.id);
  }, [activeRepo, chats, model, permissionMode, workspace]);

  const handleRunCommand = useCallback((command: string) => {
    if (!activeRepo) return;
    const handle = terminalRefs.current.get(activeRepo.path);
    handle?.runCommand(command);
  }, [activeRepo]);

  const handleSetupRun = useCallback(async () => {
    if (!activeRepo) return;
    const targetRepoPath = activeRepo.path;
    setRunSetupActive(true);
    runSetupTargetRef.current = targetRepoPath;

    // The chat must run in buildover's own repo so the agent has full context
    // about the codebase (WriteRunConfig tool, postMessage protocol, etc.).
    // The target project path is passed explicitly in the prompt so the agent
    // can read its files using absolute paths.
    let buildoverPath = targetRepoPath; // fallback if self/info fails
    try {
      const info = await selfUpdateApi.getInfo();
      buildoverPath = info.appRoot;
    } catch { /* keep fallback */ }

    // Open buildover as a repo tab and switch to it
    if (buildoverPath !== targetRepoPath) {
      await workspace.openRepo(buildoverPath);
    }

    // Create the chat in buildover's repo with full permissions
    const record = await api.createChat(buildoverPath, model, "bypassPermissions");
    workspace.setActiveChat(record.id);

    // Wait for useAgent to subscribe to the new chatId before sending
    setTimeout(() => {
      agentSocket.send({
        type: "user_message",
        chatId: record.id,
        repoPath: buildoverPath,
        text: `Create a run panel for the project at \`${targetRepoPath}\`.

Explore the project however you like to discover its runnable commands and dev server port, then call \`WriteRunConfig\` with \`repoPath: "${targetRepoPath}"\`.

The \`panelHtml\` should be a self-contained HTML page rendered in a small iframe (~200px tall, dark background #1e1e1e). Design it however you think looks best — aim for something minimal and polished. Icon-only buttons work great; avoid clutter. Each button must fire: \`window.parent.postMessage({type:'run-command',command:'...'}, '*')\`

Important rules for commands:
- When invoking a \`.sh\` script, always use the source operator: \`. ./script.sh\` — never \`./script.sh\`. Direct execution requires the executable bit and will fail with "permission denied" if the script lacks \`+x\`.
- Prefer sourcing the project's own run scripts (e.g. \`. ./run.sh\`) over reconstructing the underlying command (e.g. \`cargo run --release\`) — the script may set env vars or flags that the raw command misses.`,
        model,
        permissionMode: "bypassPermissions",
      });
    }, 600);

  }, [activeRepo, workspace, model]);

  const handleDeleteChat = useCallback(async (chatId: string) => {
    await chats.deleteChat(chatId);
    if (activeChatId === chatId) {
      // Pick the top remaining chat using the same priority order as the sidebar:
      // status group order first (awaiting_input > running > error > agent_done > idle > finished),
      // then most recently updated within each group.
      const GROUP_ORDER = ["awaiting_input", "running", "error", "agent_done", "idle", "finished"];
      const remaining = chats.chats.filter((c) => c.id !== chatId);
      const nextChat =
        remaining
          .slice()
          .sort((a, b) => {
            const ai = GROUP_ORDER.indexOf(a.status);
            const bi = GROUP_ORDER.indexOf(b.status);
            if (ai !== bi) return ai - bi;
            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
          })[0] ?? null;
      workspace.setActiveChat(nextChat?.id ?? null);
    }
    // Drop any queued messages for the deleted chat so they don't linger in state.
    setMessageQueues((prev) => {
      if (!prev[chatId]) return prev;
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
  }, [chats, activeChatId, workspace]);

  const handleSelectChat = useCallback((id: string) => {
    setOpenFile(null);
    setGitGraphOpen(false); // clicking a chat always exits the git graph
    workspace.setActiveChat(id);
  }, [workspace, setGitGraphOpen]);

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

  // Open the buildover repo itself in a new AI chat, pre-seeded with a prompt
  // to rebase local changes onto origin/main. Used by the update banner when
  // the working tree is dirty and the user clicks "Fix with AI".
  const handleOpenRebaseChat = useCallback(async () => {
    try {
      const [infoRes, localDiff] = await Promise.all([
        selfUpdateApi.getInfo(),
        selfUpdate.status?.localDiff ?? "",
      ]);
      const appRoot = infoRes.appRoot;

      // Open (or switch to) the buildover repo
      await workspace.openRepo(appRoot);
      setHomeOpen(false);
      setMarketOpen(false);

      // Create a fresh chat in the buildover repo
      const chat = await api.createChat(appRoot, model, permissionMode);
      workspace.setActiveChat(chat.id);

      // Subscribe then auto-send the rebase prompt after a short delay
      // so the useAgent hook has time to set up its subscription.
      agentSocket.send({ type: "subscribe", chatId: chat.id, repoPath: appRoot, withReplay: true });
      const diff = typeof localDiff === "string" ? localDiff : "";
      const prompt = [
        "I need to update Buildover to the latest `main` branch, but I have local changes that need to be rebased on top of it.",
        "",
        diff
          ? `Here are my current local changes:\n\`\`\`diff\n${diff.slice(0, 8_000)}\n\`\`\``
          : "Please check `git diff HEAD` for the current local changes.",
        "",
        "Please:",
        "1. Run `git status` and `git log --oneline -5` to understand the current state.",
        "2. Use `git stash`, `git pull origin main`, then `git stash pop` to rebase my changes — or `git fetch origin && git rebase origin/main` if that's cleaner.",
        "3. Resolve any conflicts intelligently, preserving intentional local changes.",
        "4. Confirm everything is clean with `git status` at the end.",
      ].join("\n");

      setTimeout(() => {
        agentSocket.send({
          type: "user_message",
          chatId: chat.id,
          repoPath: appRoot,
          text: prompt,
          model,
          permissionMode,
        });
      }, 400);
    } catch (err) {
      console.error("[UpdateBanner] Failed to open rebase chat:", err);
    }
  }, [selfUpdate.status?.localDiff, workspace, model, permissionMode]);

  // (git graph open state is now per-repo, no reset needed on repo change)


  const handleGitCheckout = useCallback(
    async (branch: string) => {
      if (!activeRepo) return;
      try {
        await gitApi.checkout(activeRepo.path, branch);
      } catch {
        // errors will be visible in the graph view itself
      }
    },
    [activeRepo],
  );

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

  const hasSidePanels = filesChanged.length > 0 || todos.length > 0;

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
      {selfUpdate.showBanner && selfUpdate.status && (
        <UpdateBanner
          status={selfUpdate.status}
          isPulling={selfUpdate.isPulling}
          pullResult={selfUpdate.pullResult}
          onPull={selfUpdate.pull}
          onForcePull={selfUpdate.forcePull}
          onOpenAiChat={handleOpenRebaseChat}
          onDismiss={selfUpdate.dismiss}
        />
      )}
      <div className="app">
        <header className="app-header">
          <h1>
            <span className="brand-dot" />
            buildover
          </h1>
          <div className="app-header-right">
            <UsageBar />

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
            <button
              className={`connection-pill ${
                agent.connection === "connected"
                  ? "connected"
                  : agent.connection === "error"
                    ? "error"
                    : ""
              }`}
              onClick={
                agent.connection !== "connected"
                  ? () => agentSocket.reconnectNow()
                  : undefined
              }
              disabled={agent.connection === "connected"}
              title={
                agent.connection !== "connected" ? "Click to reconnect" : undefined
              }
            >
              <span className="dot" />
              {agent.connection}
            </button>
          </div>
        </header>

        <RepoTabs
          openRepos={workspace.openRepos}
          activeRepoPath={
            marketOpen || homeOpen ? null : (workspace.activeRepo?.path ?? null)
          }
          recents={workspace.recents}
          onHome={() => {
            setMarketOpen(false);
            setHomeOpen(true);
          }}
          onSelect={(path) => {
            setMarketOpen(false);
            setHomeOpen(false);
            markRepoTabSeen(path);
            // startTransition keeps the current repo's UI visible while React
            // computes the new state in the background, preventing the blank
            // flash that happened when synchronous teardown preceded the fetch.
            startTransition(() => {
              workspace.setActiveRepo(path);
              setActiveView('chat');
            });
          }}
          onClose={workspace.closeRepo}
          onOpen={async (path) => {
            setMarketOpen(false);
            setHomeOpen(false);
            await workspace.openRepo(path);
          }}
          onForgetRecent={handleForgetRecent}
          badges={repoTabBadges}
          marketActive={marketOpen}
          homeActive={homeOpen}
          onMarket={() => {
            setHomeOpen(false);
            setMarketOpen((v) => !v);
          }}
        />

        {marketOpen ? (
          <MarketPanel onClose={() => setMarketOpen(false)} />
        ) : (homeOpen || !activeRepo) ? (
          <EmptyWorkspace
            recents={workspace.recents}
            onOpen={async (path) => {
              setHomeOpen(false);
              await workspace.openRepo(path);
            }}
            onForgetRecent={handleForgetRecent}
          />
        ) : null}

        {/* Workspace is always mounted while a repo is open so terminal PTY
            sessions survive navigating to the home page. We hide it with
            display:none instead of unmounting it when home/market is active. */}
        {activeRepo && (
          <div
            className={`workspace${openFile ? " workspace--file-open" : ""}`}
            style={{
              display: (marketOpen || homeOpen) ? "none" : undefined,
              '--sidebar-width': `${sidebarWidth}px`,
            } as React.CSSProperties}
          >
            {/* File viewer slides in from the right, absolutely positioned */}
            {openFile && (
              <FileViewer
                entry={openFile}
                repoPath={activeRepo.path}
                onClose={() => setOpenFile(null)}
              />
            )}

            {/* Activity bar — always visible, leftmost column */}
            <ActivityBar
              activeView={activeView}
              onViewChange={setActiveView}
              scBadge={scBadge}
              prBadge={prBadge}
            />

            {/* Sidebars — SC and PR stay mounted so their state (file lists,
                PR lists, scroll position) survives view switches and re-showing
                them is instant. Chat sidebar is lightweight (data from props)
                so conditional rendering is fine there. */}
            {activeView === 'chat' && (
              previewActive && pinnedPreviewUrl ? (
                <PreviewChatSidebar
                  chats={chats.chats}
                  activeChatId={activeChatId}
                  onSelectChat={handleSelectChat}
                  onCreateChat={handleCreateChat}
                  onToggleFinished={handleToggleFinished}
                  onDeleteChat={handleDeleteChat}
                  chatDrafts={chatDrafts}
                  repoPath={activeRepo.path}
                  onClosePreview={closePreview}
                  agent={agent}
                  onDraftChange={handleDraftChange}
                  model={model}
                  permissionMode={permissionMode}
                  onPermissionModeChange={(m) => {
                    setPermissionMode(m);
                    agent.setPermissionMode(m);
                  }}
                  onToggleMcp={() => setMcpOpen((v) => !v)}
                />
              ) : (
                <ChatSidebar
                  chats={chats.chats}
                  activeChatId={gitGraphOpen ? null : activeChatId}
                  onSelect={handleSelectChat}
                  onCreate={handleCreateChat}
                  onToggleFinished={handleToggleFinished}
                  onDelete={handleDeleteChat}
                  repoPath={activeRepo.path}
                  chatDrafts={chatDrafts}
                  onOpenGraph={() => setGitGraphOpen(true)}
                  runPanelProps={{
                    config: runConfig.config,
                    panelHtml: runConfig.panelHtml,
                    isPortListening: runConfig.isPortListening,
                    isSettingUp: runSetupActive,
                    onSetupRun: () => void handleSetupRun(),
                    onRunCommand: handleRunCommand,
                    onKillPort: runConfig.killPort,
                    onOpenPreview: openPreview,
                  }}
                />
              )
            )}
            <SourceControlSidebar
              repoPath={activeRepo.path}
              hidden={activeView !== 'source-control'}
              onFilePreview={(file) => setScPreviewFile(prev =>
                file === null ? null : prev?.path === file.path ? null : file
              )}
              previewFilePath={scPreviewFile?.path ?? null}
              onGitOperation={() => gitGraphRef.current?.refresh()}
            />
            <PullRequestSidebar
              repoPath={activeRepo.path}
              activePrNumber={activePrNumber}
              onSelectPr={(pr) => { setCreatingPr(false); setActivePrNumber(pr.number); setActivePr(pr); }}
              onCreatePr={() => { setCreatingPr(true); setActivePrNumber(null); setActivePr(null); }}
              forceRefresh={prRefreshKey}
              hidden={activeView !== 'pr'}
            />

            {/* Gradient fade — only shown in chat view */}
            {activeView === 'chat' && <div className="chat-sidebar-fade" />}

            {/* Drag handle to resize the sidebar */}
            <div
              className={`sidebar-resize-handle${sidebarResizing ? ' sidebar-resize-handle--dragging' : ''}`}
              onMouseDown={handleSidebarResizeStart}
            />

            {/* workspace-panels: wraps only the main area so it slides left
                when the file viewer opens, while the sidebar stays put.
                When a file is open, clicking the exposed strip closes it. */}
            <div
              className="workspace-panels"
              onClick={openFile ? () => setOpenFile(null) : undefined}
            >
            {activeView === 'source-control' ? (
              /* Source control view: show file preview or GitGraphView */
              <main className="chat-pane" ref={chatPaneRef}>
                <div className="chat-pane-content">
                  {scPreviewFile ? (
                    <FileViewer
                      inline
                      entry={{
                        path: `${activeRepo.path}/${scPreviewFile.path}`,
                        relPath: scPreviewFile.path,
                        op: (() => {
                          const code = scPreviewFile.statusCode;
                          const x = code[0] ?? ' ';
                          const y = code[1] ?? ' ';
                          if (code === '??' || x === 'A') return 'write' as const;
                          if (x === 'D' || y === 'D') return 'delete' as const;
                          return 'edit' as const;
                        })(),
                      }}
                      repoPath={activeRepo.path}
                      onClose={() => setScPreviewFile(null)}
                    />
                  ) : (
                    <GitGraphView
                      ref={gitGraphRef}
                      repoPath={activeRepo.path}
                      onClose={() => setActiveView('chat')}
                      onCheckout={(branch) => void handleGitCheckout(branch)}
                    />
                  )}
                </div>
                {workspace.openRepos.map((repo) => (
                  <TerminalPanel
                    key={repo.path}
                    ref={(handle) => {
                      if (handle) terminalRefs.current.set(repo.path, handle);
                      else terminalRefs.current.delete(repo.path);
                    }}
                    repoPath={repo.path}
                    defaultCwd={repo.path}
                    hidden={repo.path !== activeRepo.path}
                  />
                ))}
              </main>
            ) : activeView === 'pr' ? (
              /* Pull request view */
              <main className="chat-pane" ref={chatPaneRef}>
                <div className="chat-pane-content">
                  {creatingPr ? (
                    <CreatePrForm
                      repoPath={activeRepo.path}
                      onCreated={(pr) => {
                        setPrRefreshKey((k) => k + 1);
                        setCreatingPr(false);
                        setActivePrNumber(pr.number);
                        setActivePr(pr);
                      }}
                      onCancel={() => setCreatingPr(false)}
                    />
                  ) : (
                    <PullRequestView
                      repoPath={activeRepo.path}
                      prNumber={activePrNumber}
                      initialPr={activePr}
                      onClose={() => { setActivePrNumber(null); setActivePr(null); }}
                    />
                  )}
                </div>
                {workspace.openRepos.map((repo) => (
                  <TerminalPanel
                    key={repo.path}
                    ref={(handle) => {
                      if (handle) terminalRefs.current.set(repo.path, handle);
                      else terminalRefs.current.delete(repo.path);
                    }}
                    repoPath={repo.path}
                    defaultCwd={repo.path}
                    hidden={repo.path !== activeRepo.path}
                  />
                ))}
              </main>
            ) : previewActive && pinnedPreviewUrl ? (
              /* Preview mode: full-width preview pane, chat is in the sidebar */
              <main className="chat-pane" ref={chatPaneRef}>
                <div className="chat-pane-content">
                  <PreviewPane
                    url={pinnedPreviewUrl}
                    onClose={closePreview}
                  />
                </div>
                {workspace.openRepos.map((repo) => (
                  <TerminalPanel
                    key={repo.path}
                    ref={(handle) => {
                      if (handle) terminalRefs.current.set(repo.path, handle);
                      else terminalRefs.current.delete(repo.path);
                    }}
                    repoPath={repo.path}
                    defaultCwd={repo.path}
                    hidden={repo.path !== activeRepo.path}
                  />
                ))}
              </main>
            ) : (
              /* Chat view — original layout */
              <main className="chat-pane" ref={chatPaneRef}>
                {/* chat-pane-content: everything above the terminal panel */}
                <div className="chat-pane-content">
                  {gitGraphOpen ? (
                    <GitGraphView
                      ref={gitGraphRef}
                      repoPath={activeRepo.path}
                      onClose={() => setGitGraphOpen(false)}
                      onCheckout={(branch) => void handleGitCheckout(branch)}
                    />
                  ) : !activeChat ? (
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
                        <div
                          className={`chat-group${hasSidePanels ? "" : " chat-group--centered"}`}
                        >
                          <div className="chat-column">
                            <MessageList
                              turns={agent.turns}
                              isStreaming={agent.isStreaming}
                              cwd={agent.cwd ?? activeRepo.path}
                              scrollRef={msgScrollRef}
                              jumpBarRef={jumpBarRef}
                              branchInfo={agent.branchInfo}
                              onForkMessage={(userMessageId, newText) =>
                                agent.forkMessage(userMessageId, newText, { model, permissionMode })
                              }
                              onSwitchBranch={agent.switchBranch}
                              onRevert={agent.revertToCheckpoint}
                              chatId={activeChatId ?? undefined}
                            />
                            {agent.pendingAttention && (
                              <AttentionPrompt
                                pending={agent.pendingAttention}
                                onRespond={agent.respondAttention}
                              />
                            )}
                            {agent.pendingPermission && !agent.pendingAttention && (
                              <PermissionPrompt
                                pending={agent.pendingPermission}
                                onRespond={agent.respondPermission}
                              />
                            )}
                            <div style={{ display: (agent.pendingPermission || agent.pendingAttention) ? "none" : undefined }}>
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
                                contextUsage={agent.contextUsage}
                                repoPath={activeRepo?.path}
                                sdkSlashCommands={agent.slashCommands}
                              />
                            </div>
                          </div>
                          {/* right-rail: jump bar always; files panel + todo panel stacked (wide); compact todo strip (narrow) */}
                          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
                          <div ref={rightRailRef} className={`right-rail${todoNarrow ? " right-rail--narrow" : ""}`} onClick={(e) => e.stopPropagation()}>
                            <MessageJumpBar
                              jumpBarRef={jumpBarRef}
                            />
                            {!todoNarrow && (filesChanged.length > 0 || todos.length > 0) && (
                              <div className="right-rail-panels">
                                {filesChanged.length > 0 && (
                                  <FilesPanel
                                    files={filesChanged}
                                    onFileOpen={setOpenFile}
                                    activeFilePath={openFile?.path ?? null}
                                  />
                                )}
                                {todos.length > 0 && (
                                  <TodoPanel todos={todos} compact={false} />
                                )}
                              </div>
                            )}
                            {todoNarrow && todos.length > 0 && (
                              <div className="right-rail-panels">
                                <TodoPanel todos={todos} compact={true} />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
                {/* One terminal panel per open repo — kept mounted so PTY sessions
                    survive repo switches. Non-active panels are hidden via
                    display:none and stay alive in the background. */}
                {workspace.openRepos.map((repo) => (
                  <TerminalPanel
                    key={repo.path}
                    ref={(handle) => {
                      if (handle) terminalRefs.current.set(repo.path, handle);
                      else terminalRefs.current.delete(repo.path);
                    }}
                    repoPath={repo.path}
                    defaultCwd={repo.path}
                    hidden={repo.path !== activeRepo.path}
                  />
                ))}
              </main>
            )}
            </div>{/* end workspace-panels */}
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
