import { useEffect, useMemo, useRef } from "react";
import type { ChatTurn } from "../hooks/useAgent.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { UserMessage } from "./UserMessage.js";

// How many pixels from the bottom counts as "at the bottom". A small
// threshold handles sub-pixel rounding and the streaming thinking pulse.
const SCROLL_THRESHOLD = 120;

interface Props {
  turns: ChatTurn[];
  isStreaming: boolean;
  cwd?: string;
  scrollRef?: React.RefObject<HTMLDivElement>;
  chatId?: string;
}

export function MessageList({ turns, isStreaming, cwd, scrollRef, chatId }: Props) {
  // ref points at the .message-list div — used both as the DOM ref and the
  // scroll container for auto-scroll / "is at bottom" logic.
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = scrollRef ?? internalRef;

  // Track whether the user was at the bottom before the new turns arrived.
  // We capture this before the render so we can decide whether to scroll
  // after React has committed the new DOM.
  const wasAtBottomRef = useRef(true);

  // Set to true when the active chat changes. Consumed (and cleared) by the
  // useEffect([turns]) below once the async replay arrives and turns are
  // non-empty. This is kept separate from wasAtBottomRef so the no-dep-array
  // snapshot effect cannot clobber it between the chatId change and the replay.
  const scrollToChatBottomRef = useRef(false);

  // Build a global tool_use_id → result map by walking all tool_results turns.
  // The agent loop emits tool results in their own user turn; we splice them
  // back into the assistant cards visually so each tool shows its own output.
  const toolResults = useMemo(() => {
    const map: Record<string, { content: string; isError: boolean }> = {};
    for (const turn of turns) {
      if (turn.kind !== "tool_results") continue;
      for (const block of turn.content) {
        if (block.type === "tool_result") {
          map[block.tool_use_id] = {
            content: block.content,
            isError: Boolean(block.is_error),
          };
        }
      }
    }
    return map;
  }, [turns]);

  // Whenever the active chat changes, arm the flag so that the next time
  // turns become non-empty (i.e. after the async chat_replay arrives) we
  // unconditionally scroll to the bottom.
  useEffect(() => {
    if (!chatId) return;
    scrollToChatBottomRef.current = true;
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Snapshot whether we're near the bottom *before* the render that added
  // new turns. useLayoutEffect runs synchronously after DOM mutation but
  // before paint, so scrollHeight already reflects the new content.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    wasAtBottomRef.current = distanceFromBottom <= SCROLL_THRESHOLD;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // If we just switched to a different chat, scroll to the bottom once the
    // async replay has populated turns. Clear the flag so subsequent streaming
    // messages use the normal wasAtBottomRef logic.
    // We scroll immediately AND schedule a deferred re-scroll via rAF + setTimeout
    // because ReactMarkdown and other sub-components may expand the layout
    // after the initial paint, meaning scrollHeight isn't final yet.
    if (scrollToChatBottomRef.current && turns.length > 0) {
      scrollToChatBottomRef.current = false;
      const scrollToBottom = () => el.scrollTo({ top: el.scrollHeight });
      scrollToBottom();
      const raf = requestAnimationFrame(() => {
        scrollToBottom();
        const timer = setTimeout(scrollToBottom, 150);
        return () => clearTimeout(timer);
      });
      return () => cancelAnimationFrame(raf);
    }
    // Always scroll on the very first message (empty → non-empty transition),
    // and on subsequent messages only if the user was already at the bottom.
    if (turns.length === 1 || wasAtBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [turns]);

  if (turns.length === 0) {
    return (
      <div className="message-list" ref={ref}>
        <div className="message-list-empty">
          <p>Let's a build!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={ref}>
      {turns.map((turn) => {
        if (turn.kind === "user") {
          return (
            <div
              key={turn.id}
              data-turn-id={turn.id}
              data-turn-kind="user"
            >
              <UserMessage
                text={turn.text}
                attachments={turn.attachments}
              />
            </div>
          );
        }
        if (turn.kind === "assistant") {
          return (
            <AssistantMessage
              key={turn.id}
              content={turn.content}
              toolResults={toolResults}
              cwd={cwd}
            />
          );
        }
        if (turn.kind === "result") {
          const cost =
            typeof turn.totalCostUsd === "number"
              ? `$${turn.totalCostUsd.toFixed(4)}`
              : "—";
          return (
            <div key={turn.id} className="result-line">
              {turn.subtype} · {turn.numTurns} turns ·{" "}
              {(turn.durationMs / 1000).toFixed(1)}s · {cost}
            </div>
          );
        }
        return null;
      })}
      {isStreaming && (
        <div className="thinking-pulse" aria-label="thinking">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}
