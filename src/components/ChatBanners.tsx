import { useEffect, useState } from "react";
import { CornerDownRight, Flame, Loader2, X } from "lucide-react";
import type { ChatHandoffTo } from "../types.js";
import { KEEP_WARM_BUDGET_HOURS } from "../types.js";
import { chatWarning } from "../lib/tokenCost.js";
import { budgetMsLeft, formatWarmSpan } from "../lib/warmth.js";
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
  /** ISO deadline the warmth budget runs to. Absent === warming off. */
  keepWarmUntil?: string | null;
  /** Buys a warmth budget. Omitted for providers without a prompt cache. */
  onKeepWarm?: (hours: number) => void;
  /** Inside a grid card the warm pill already carries the cost story, so the
   *  cost banners are suppressed there and only the live notices remain. */
  hideCostWarning?: boolean;
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
    keepWarmUntil,
    onKeepWarm,
    hideCostWarning,
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

  const warning =
    busy || handoffTo || hideCostWarning
      ? null
      : chatWarning({ model, contextTokens, lastApiAtMs, now });
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
  const budgetLeft = budgetMsLeft(keepWarmUntil);

  if (!notice && !slotQueue && !handoffTo && !showWarning && !handoffError) return null;

  return (
    <div className="chat-banners">
      {slotQueue && (
        <div className="chat-banner chat-banner--info" role="status">
          <Loader2 size={13} className="chat-banner-spinner" />
          <span className="chat-banner-text">
            Queued: you have capped concurrent turns at {slotQueue.max} and {slotQueue.running} are
            running{slotQueue.position > 1 ? `, ${slotQueue.position - 1} chat${slotQueue.position > 2 ? "s" : ""} ahead of this one` : ""}.
            This chat starts on its own as soon as a turn finishes. Clear the maxConcurrentTurns
            preference (or set it to 0) to run every chat at once.
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
        <div
          // Both kinds are information about cost, so neither takes the amber
          // treatment reserved for things that actually went wrong.
          className="chat-banner chat-banner--actions chat-banner--info"
          role="status"
        >
          <span className="chat-banner-text">
            <span className="chat-banner-msg chat-banner-msg--full">{warning.message}</span>
            <span className="chat-banner-msg chat-banner-msg--short">{warning.shortMessage}</span>
          </span>
          <div className="chat-banner-actions">
            <button
              type="button"
              // A cold cache is a one-off cost, not a reason to abandon the
              // chat: only the large-context note pushes a fresh chat hard.
              className={`chat-banner-btn${warning.kind === "large" ? " chat-banner-btn--primary" : ""}`}
              onClick={onHandoff}
              disabled={handoffBusy}
            >
              {handoffBusy ? (
                <>
                  <Loader2 size={12} className="chat-banner-spinner" /> Writing note…
                </>
              ) : (
                <>
                  <span className="chat-banner-btn-full">Continue in fresh chat</span>
                  <span className="chat-banner-btn-abbr">Fresh chat</span>
                </>
              )}
            </button>
            {warning.kind === "cold" && onKeepWarm && (
              <button
                type="button"
                className={`chat-banner-btn${budgetLeft > 0 ? " is-on" : ""}`}
                aria-pressed={budgetLeft > 0}
                onClick={() => onKeepWarm(KEEP_WARM_BUDGET_HOURS)}
                title={
                  budgetLeft > 0
                    ? `Already keeping this warm for ${formatWarmSpan(budgetLeft)} more — click to add ${KEEP_WARM_BUDGET_HOURS}h`
                    : `Ping every 55 min for ${KEEP_WARM_BUDGET_HOURS}h so the cache stays alive`
                }
              >
                <Flame size={12} />
                <span className="chat-banner-btn-full">
                  {budgetLeft > 0 ? `Warm ${formatWarmSpan(budgetLeft)}` : `Keep warm ${KEEP_WARM_BUDGET_HOURS}h`}
                </span>
                <span className="chat-banner-btn-abbr">
                  {budgetLeft > 0 ? formatWarmSpan(budgetLeft) : `${KEEP_WARM_BUDGET_HOURS}h`}
                </span>
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
