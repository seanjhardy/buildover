import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Crown, X } from "lucide-react";
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

// Mirrors App / GridPanel: these tools are user checkpoints and always prompt.
const ALWAYS_PROMPT_TOOLS = new Set(["ExitPlanMode", "RequestUserAttention", "AskUserQuestion"]);
/** Re-ask where the Master lives this often: the server starts it afresh
 *  after two idle hours, and the button should follow without a reload. */
const MASTER_RECHECK_MS = 10 * 60_000;

interface Props {
  settings: GridChatSettings;
}

/**
 * The Master agent: a permanent cross-repo chat behind a floating button at
 * the bottom left of the Grid page, opening into a small popover above it. It's
 * an ordinary buildover chat (same transcript, prompts, queue and Composer)
 * living in its own home directory, with a cross-repo toolset that lets it
 * see, message and keep-warm every other chat. The chat stays mounted while
 * the popover is shut, so the button's badge can show when it wants you.
 */
export function MasterButton({ settings }: Props) {
  const [info, setInfo] = useState<MasterInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [wantsYou, setWantsYou] = useState(false);

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
    const recheck = setInterval(load, MASTER_RECHECK_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(recheck);
    };
  }, []);

  // A handoff (or two idle hours) moves the Master role to a fresh chat
  // server-side; re-read where it now lives so this follows it.
  const reload = useCallback(async () => {
    const next = await api.getMaster();
    setInfo((prev) =>
      prev && prev.chatId === next.chatId && prev.model === next.model ? prev : next,
    );
  }, []);

  const openPopover = useCallback(() => {
    setOpen(true);
    void reload().catch(() => undefined);
  }, [reload]);

  // A press anywhere else shuts the popover. "Inside" is judged on the React
  // tree, so its portals (the MCP panel, an image, a context menu) count: the
  // document resets the mark as the press starts, the popover or button sets
  // it as the press reaches them, and the verdict waits for the event to
  // finish, so a handler that stops the press on its way can't hide it.
  const pressedInsideRef = useRef(false);
  const markPressInside = useCallback(() => {
    pressedInsideRef.current = true;
  }, []);
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onDown = () => {
      pressedInsideRef.current = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!pressedInsideRef.current) setOpen(false);
      });
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      clearTimeout(timer);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={`master-fab${open ? " master-fab--open" : ""}`}
        title="Master agent"
        aria-label="Open the Master agent"
        aria-expanded={open}
        onPointerDownCapture={markPressInside}
        onClick={() => (open ? setOpen(false) : openPopover())}
      >
        <Crown size={18} />
        {wantsYou && !open && <span className="master-fab-badge" aria-label="Wants you" />}
      </button>

      <div
        className={`master-popover${open ? " master-popover--open" : ""}`}
        role="dialog"
        aria-label="Master agent"
        aria-hidden={!open}
        onPointerDownCapture={markPressInside}
      >
        {info ? (
          <MasterChat
            key={info.chatId}
            info={info}
            settings={settings}
            open={open}
            onClose={() => setOpen(false)}
            onReload={reload}
            onWantsYou={setWantsYou}
          />
        ) : (
          <>
            <header className="master-head">
              <Crown size={14} className="master-head-icon" />
              <span className="master-head-title">Master</span>
              <button
                type="button"
                className="master-close-btn"
                title="Close"
                onClick={() => setOpen(false)}
              >
                <X size={15} />
              </button>
            </header>
            <div className="master-empty">{error ? `Unavailable — ${error}` : "Starting…"}</div>
          </>
        )}
      </div>
    </>
  );
}

function MasterChat({
  info,
  settings,
  open,
  onClose,
  onReload,
  onWantsYou,
}: {
  info: MasterInfo;
  settings: GridChatSettings;
  open: boolean;
  onClose: () => void;
  onReload: () => Promise<void>;
  onWantsYou: (wants: boolean) => void;
}) {
  const agent = useAgent(info.repoPath, info.chatId);
  const status = agent.status ?? "idle";
  const wantsYou =
    status === "awaiting_input" ||
    status === "agent_done" ||
    status === "error" ||
    agent.pendingAttention != null;
  useEffect(() => onWantsYou(wantsYou), [wantsYou, onWantsYou]);

  // Opening the popover puts the caret straight in the message box.
  const composerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      composerRef.current?.querySelector<HTMLTextAreaElement>("textarea.composer-input")?.focus();
    }, 60);
    return () => clearTimeout(t);
  }, [open]);
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
  // The chat record is the source of truth for the model: /api/master can be
  // stale (a server started before its memo fix still serves the model it saw
  // at boot), and seeding the Composer from it reverts the user's choice on
  // the next send.
  useEffect(() => {
    let cancelled = false;
    api
      .getChat(info.repoPath, info.chatId)
      .then((record) => {
        if (!cancelled && record?.model) setModel(record.model);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [info.repoPath, info.chatId]);
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
          <StatusIcon status={status} />
        </span>
        <span className="master-head-note">Starts fresh after 2 quiet hours</span>
        <WarmPill lastApiAtMs={lastApiAtMs} locked managedHours={info.keepWarmHours} />
        <button type="button" className="master-close-btn" title="Close" onClick={onClose}>
          <X size={15} />
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
        <div className="composer-dock" ref={composerRef}>
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
            prefill={agent.turns.length === 0 ? agent.meta.handoffPrefill : null}
            // The narrow bar the grid windows use: the popover is about as small.
            simplified
          />
        </div>
      </div>

      {mcpOpen &&
        createPortal(
          <McpPanel
            tools={agent.tools}
            mcpServers={agent.mcpServers}
            cwd={agent.cwd}
            onClose={() => setMcpOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}
