import { useEffect, useState } from "react";
import { CornerDownRight, Flame, Loader2, X } from "lucide-react";
import type { ChatHandoffTo } from "../types.js";
import { chatWarning } from "../lib/tokenCost.js";
import type { ChatNotice, SlotQueueInfo } from "../hooks/useAgent.js";

interface Props {
  chatId: string;
  model: string;
  /** Current context size in tokens. */
  contextTokens: number;
  /** When the chat last talked to the API (ms since epoch), if known. */
  lastApiAtMs?: number;
  /** A turn is in flight: the prompt cache is being used, so no cold warning. */
  busy: boolean;
  notice: ChatNotice | null;
  slotQueue: SlotQueueInfo | null;
  handoffTo: ChatHandoffTo | null;
  onOpenChat: (chatId: string) => void;
  keepWarm: boolean;
  keepWarmHours: number;
  /** Omitted for providers without a prompt cache. */
  onToggleKeepWarm?: () => void;
  onHandoff: () => void;
  handoffBusy: boolean;
  handoffError: string | null;
}

const DISMISS_KEY = (chatId: string) => `buildover.bannerDismissed.${chatId}`;

function readDismissed(chatId: string): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY(chatId));
  } catch {
    return null;
  }
}

/**
 * Status strip between the message list and the composer: queue / rate-limit
 * notices, the "Continued in ..." link, and the cold-cache / large-context
 * warnings (each dismissible; the dismissal is remembered per chat until the
 * condition changes).
 */
export function ChatBanners(props: Props) {
  const {
    chatId,
    model,
    contextTokens,
    lastApiAtMs,
    busy,
    notice,
    slotQueue,
    handoffTo,
    onOpenChat,
    keepWarm,
    keepWarmHours,
    onToggleKeepWarm,
    onHandoff,
    handoffBusy,
    handoffError,
  } = props;

  // Re-evaluate once a minute so a chat going cold while open shows the banner.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const warning = busy || handoffTo ? null : chatWarning({ model, contextTokens, lastApiAtMs, now });
  const [dismissedKey, setDismissedKey] = useState<string | null>(() => readDismissed(chatId));

  useEffect(() => {
    setDismissedKey(readDismissed(chatId));
  }, [chatId]);

  // The condition went away (compaction, a new message): forget the dismissal
  // so the warning comes back if it ever re-occurs.
  useEffect(() => {
    if (busy || warning) return;
    if (dismissedKey === null) return;
    setDismissedKey(null);
    try {
      localStorage.removeItem(DISMISS_KEY(chatId));
    } catch {
      // ignore
    }
  }, [busy, warning, dismissedKey, chatId]);

  const dismiss = () => {
    if (!warning) return;
    setDismissedKey(warning.key);
    try {
      localStorage.setItem(DISMISS_KEY(chatId), warning.key);
    } catch {
      // ignore
    }
  };

  const showWarning = warning !== null && warning.key !== dismissedKey;

  if (!notice && !slotQueue && !handoffTo && !showWarning && !handoffError) return null;

  return (
    <div className="chat-banners">
      {slotQueue && (
        <div className="chat-banner chat-banner--info" role="status">
          <Loader2 size={13} className="chat-banner-spinner" />
          <span className="chat-banner-text">
            Queued: waiting for a free agent slot ({slotQueue.running}/{slotQueue.max} turns running
            {slotQueue.position > 1 ? `, ${slotQueue.position - 1} ahead of this one` : ""}).
          </span>
        </div>
      )}
      {notice && (
        <div className="chat-banner chat-banner--warn" role="status">
          <span className="chat-banner-text">{notice.message}</span>
        </div>
      )}
      {handoffTo && (
        <div className="chat-banner chat-banner--link" role="status">
          <CornerDownRight size={13} />
          <span className="chat-banner-text">
            Continued in{" "}
            <button type="button" className="chat-banner-link" onClick={() => onOpenChat(handoffTo.chatId)}>
              {handoffTo.title}
            </button>
          </span>
        </div>
      )}
      {handoffError && (
        <div className="chat-banner chat-banner--error" role="alert">
          <span className="chat-banner-text">Handoff failed: {handoffError}</span>
        </div>
      )}
      {showWarning && warning && (
        <div className={`chat-banner chat-banner--${warning.kind === "cold" ? "warn" : "info"}`} role="status">
          <span className="chat-banner-text">{warning.message}</span>
          <div className="chat-banner-actions">
            <button
              type="button"
              className="chat-banner-btn chat-banner-btn--primary"
              onClick={onHandoff}
              disabled={handoffBusy}
            >
              {handoffBusy ? (
                <>
                  <Loader2 size={12} className="chat-banner-spinner" /> Writing note…
                </>
              ) : (
                "Continue in fresh chat"
              )}
            </button>
            {warning.kind === "cold" && onToggleKeepWarm && (
              <button
                type="button"
                className={`chat-banner-btn${keepWarm ? " is-on" : ""}`}
                aria-pressed={keepWarm}
                onClick={onToggleKeepWarm}
                title="Ping every 55 min so the prompt cache never expires again"
              >
                <Flame size={12} /> Keep warm {keepWarmHours}h
              </button>
            )}
            <button type="button" className="chat-banner-dismiss" onClick={dismiss} aria-label="Dismiss">
              <X size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
