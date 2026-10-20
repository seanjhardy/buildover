import { useCallback, useEffect, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, Crown } from "lucide-react";
import { api } from "../lib/api.js";
import type { MasterInfo } from "../lib/api.js";
import { useAgent } from "../hooks/useAgent.js";
import { MessageList } from "./MessageList.js";
import { MessageQueue } from "./MessageQueue.js";
import { AttentionPrompt, PermissionPrompt } from "./PermissionPrompt.js";
import { StatusIcon } from "./StatusIcon.js";
import { Composer } from "./Composer.js";
import { ChatBanners } from "./ChatBanners.js";
import { McpPanel } from "./McpPanel.js";
import { WarmPill } from "./WarmPill.js";
import type { GridChatSettings } from "./GridPanel.js";
import type { Model, PermissionMode } from "../types.js";

const COLLAPSED_KEY = "buildover.masterCollapsed";
// Mirrors App / GridPanel: these tools are user checkpoints and always prompt.
const ALWAYS_PROMPT_TOOLS = new Set(["ExitPlanMode", "RequestUserAttention", "AskUserQuestion"]);

interface Props {
  settings: GridChatSettings;
}

/**
 * The Master agent: a permanent cross-repo chat pinned down the left of the
 * Grid page. It's an ordinary buildover chat (same transcript, prompts, queue
 * and Composer) living in its own home directory, with a cross-repo toolset
 * that lets it see, message and keep-warm every other chat.
 */
export function MasterPanel({ settings }: Props) {
  const [info, setInfo] = useState<MasterInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Provisioned server-side on first request; retry quietly on a cold start.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api
        .getMaster()
        .then((next) => {
          if (!cancelled) setInfo(next);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          timer = setTimeout(load, 4000);
        });
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // A handoff moves the Master role to a fresh chat server-side; re-read where
  // it now lives so this panel follows it.
  const reload = useCallback(async () => {
    setInfo(await api.getMaster());
  }, []);

  if (collapsed) {
    return (
      <div className="master-panel master-panel--collapsed">
        <button
          type="button"
          className="master-collapse-btn"
          title="Show the Master agent"
          onClick={toggleCollapsed}
        >
          <PanelLeftOpen size={15} />
        </button>
        <span className="master-collapsed-label">Master</span>
      </div>
    );
  }

  return (
    <div className="master-panel">
      {info ? (
        <MasterChat
          key={info.chatId}
          info={info}
          settings={settings}
          onCollapse={toggleCollapsed}
          onReload={reload}
        />
      ) : (
        <>
          <header className="master-head">
            <Crown size={14} className="master-head-icon" />
            <span className="master-head-title">Master</span>
            <button
              type="button"
              className="master-collapse-btn"
              title="Hide the Master agent"
              onClick={toggleCollapsed}
            >
              <PanelLeftClose size={15} />
            </button>
          </header>
          <div className="master-empty">{error ? `Unavailable — ${error}` : "Starting…"}</div>
        </>
      )}
    </div>
  );
}

function MasterChat({
  info,
  settings,
  onCollapse,
  onReload,
}: {
  info: MasterInfo;
  settings: GridChatSettings;
  onCollapse: () => void;
  onReload: () => Promise<void>;
}) {
  const agent = useAgent(info.repoPath, info.chatId);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  // Handing off keeps the Master role but starts a fresh transcript — the one
  // way its permanent context gets reset.
  const handleHandoff = useCallback(async () => {
    if (handoffBusy) return;
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      await api.handoffChat(info.repoPath, info.chatId);
      await onReload();
    } catch (err) {
      setHandoffError(err instanceof Error ? err.message : String(err));
    } finally {
      setHandoffBusy(false);
    }
  }, [handoffBusy, info.repoPath, info.chatId, onReload]);

  const [model, setModel] = useState<Model>(info.model);
  useEffect(() => setModel(info.model), [info.model]);
  const handleModelChange = useCallback(
    (next: string) => {
      setModel(next);
      void api.patchChat(info.repoPath, info.chatId, { model: next }).catch(() => undefined);
    },
    [info.repoPath, info.chatId],
  );

  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => agent.chatPermissionMode ?? "bypassPermissions",
  );
  useEffect(() => {
    if (agent.chatPermissionMode != null) setPermissionMode(agent.chatPermissionMode);
  }, [agent.chatPermissionMode]);

  // Same as the open chat view and grid cards: bypass mode auto-approves
  // ordinary tool permissions so this chat never sits blocked.
  const { pendingPermission, respondPermission } = agent;
  useEffect(() => {
    if (permissionMode !== "bypassPermissions") return;
    if (!pendingPermission) return;
    if (ALWAYS_PROMPT_TOOLS.has(pendingPermission.toolName)) return;
    respondPermission(pendingPermission.requestId, { behavior: "allow" });
  }, [permissionMode, pendingPermission, respondPermission]);

  const lastApiAtMs = (() => {
    const iso = agent.meta.cost?.lastApiAt;
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : undefined;
  })();
  const chatStartedAt = (() => {
    for (const t of agent.turns) if (t.kind === "user" && t.ts) return t.ts;
    return undefined;
  })();

  return (
    <>
      <header className="master-head">
        <Crown size={14} className="master-head-icon" />
        <span className="master-head-title">Master</span>
        <span className="master-head-status">
          <StatusIcon status={agent.status ?? "idle"} />
        </span>
        <WarmPill
          lastApiAtMs={lastApiAtMs}
          keepWarm
          keepWarmHours={info.keepWarmHours}
          locked
        />
        <button
          type="button"
          className="master-collapse-btn"
          title="Hide the Master agent"
          onClick={onCollapse}
        >
          <PanelLeftClose size={15} />
        </button>
      </header>

      <div className="master-body">
        <MessageList
          turns={agent.turns}
          isStreaming={agent.isStreaming}
          historyReady={agent.historyReady}
          cwd={agent.cwd ?? info.repoPath}
          branchInfo={agent.branchInfo}
          onForkMessage={(userMessageId, newText, attachments) =>
            agent.forkMessage(userMessageId, newText, attachments, { model, permissionMode })
          }
          onSwitchBranch={agent.switchBranch}
          onRevert={agent.revertToCheckpoint}
          chatId={info.chatId}
          chatKind="master"
        />
      </div>

      <div className="master-dock">
        <ChatBanners
          chatId={info.chatId}
          model={model}
          contextTokens={agent.contextUsage?.usedTokens ?? 0}
          lastApiAtMs={lastApiAtMs}
          busy={agent.isStreaming || agent.status === "running" || agent.status === "queued"}
          notice={agent.notice}
          slotQueue={agent.slotQueue}
          handoffTo={agent.meta.handoffTo}
          onOpenChat={() => void onReload()}
          keepWarm
          keepWarmHours={info.keepWarmHours}
          onHandoff={() => void handleHandoff()}
          handoffBusy={handoffBusy}
          handoffError={handoffError}
        />
        {agent.pendingAttention && (
          <AttentionPrompt pending={agent.pendingAttention} onRespond={agent.respondAttention} />
        )}
        {agent.pendingPermission && !agent.pendingAttention && (
          <PermissionPrompt pending={agent.pendingPermission} onRespond={agent.respondPermission} />
        )}
        <div className="composer-dock">
          <MessageQueue
            queue={agent.messageQueue}
            usageQueuedTurns={agent.queuedTurns}
            paused={agent.queuePaused}
            onTogglePause={agent.toggleQueuePaused}
            onRemove={agent.removeQueued}
            onFastTrack={agent.fastTrackQueued}
            onSteer={agent.steerQueued}
            onReorder={agent.reorderQueue}
          />
          <Composer
            chatId={info.chatId}
            onSend={(text, attachments) => agent.send(text, { model, permissionMode, attachments })}
            onQueuePaused={(text, attachments) =>
              agent.enqueuePaused(text, { model, permissionMode, attachments })
            }
            onInterrupt={agent.interrupt}
            disabled={agent.connection !== "connected"}
            isStreaming={agent.isStreaming}
            model={model}
            permissionMode={permissionMode}
            onPermissionModeChange={(m) => {
              setPermissionMode(m);
              agent.setPermissionMode(m);
            }}
            onModelChange={handleModelChange}
            availableModels={settings.availableModels}
            onRefreshModels={settings.onRefreshModels}
            onToggleMcp={() => setMcpOpen((v) => !v)}
            contextUsage={agent.contextUsage}
            repoPath={info.repoPath}
            sdkSlashCommands={agent.slashCommands}
            thinkingSummaries={settings.thinkingSummaries}
            onThinkingSummariesChange={settings.onThinkingSummariesChange}
            effort={settings.effort}
            onEffortChange={settings.onEffortChange}
            chatCost={agent.meta.cost}
            chatStartedAt={chatStartedAt}
            keepWarm
            keepWarmHours={info.keepWarmHours}
            prefill={agent.turns.length === 0 ? agent.meta.handoffPrefill : null}
          />
        </div>
      </div>

      {mcpOpen && (
        <McpPanel
          tools={agent.tools}
          mcpServers={agent.mcpServers}
          cwd={agent.cwd}
          onClose={() => setMcpOpen(false)}
        />
      )}
    </>
  );
}
