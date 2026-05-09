import { memo, useEffect, useRef } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
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

// A single virtual row — either a real ChatTurn or the streaming indicator.
type VirtualItem = ChatTurn | { kind: "__streaming__" };

function MessageListInner({ turns, isStreaming, cwd, scrollRef, chatId }: Props) {
  // The scroll container div. Also exposed via the external scrollRef so that
  // MessageJumpBar (which listens for scroll events and queries DOM nodes in
  // the container) continues to work after we add virtualisation.
  const containerRef = useRef<HTMLDivElement>(null);

  // VirtualizerHandle gives us programmatic scroll control.
  const virtualizerRef = useRef<VirtualizerHandle>(null);

  // Track whether the user was at the bottom before the latest render.
  const wasAtBottomRef = useRef(true);

  // Set to true when the active chat changes so we scroll to the bottom once
  // the first batch of turns arrives from the server or cache.
  const scrollToChatBottomRef = useRef(false);

  // Incremental tool_use_id → result map — kept as a stable ref object so
  // AssistantMessage's arePropsEqual bails cheaply for unchanged messages.
  const toolResultsRef = useRef<Record<string, { content: string; isError: boolean }>>({});
  const prevTurnsLenRef = useRef(0);

  // Walk only newly-appended turns to find tool_results entries.
  const currentLen = turns.length;
  if (currentLen !== prevTurnsLenRef.current) {
    const startIdx = Math.max(0, prevTurnsLenRef.current - 1);
    for (let i = startIdx; i < currentLen; i++) {
      const turn = turns[i];
      if (turn.kind !== "tool_results") continue;
      for (const block of turn.content) {
        if (block.type === "tool_result") {
          toolResultsRef.current[block.tool_use_id] = {
            content: block.content,
            isError: Boolean(block.is_error),
          };
        }
      }
    }
    prevTurnsLenRef.current = currentLen;
  }

  const toolResults = toolResultsRef.current;

  // Wire the external scrollRef to the same DOM element we control so that
  // MessageJumpBar can attach its scroll listener and query user-turn nodes.
  useEffect(() => {
    if (!scrollRef) return;
    (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current =
      containerRef.current;
  });

  // On chat switch: arm the scroll-to-bottom flag and reset tool results.
  useEffect(() => {
    if (!chatId) return;
    scrollToChatBottomRef.current = true;
    toolResultsRef.current = {};
    prevTurnsLenRef.current = 0;
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Snapshot scroll position BEFORE commit so we can decide whether to
  // auto-scroll after new items are added.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    wasAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD;
  });

  // Build the virtual items list: real turns + optional streaming indicator.
  const items: VirtualItem[] = isStreaming
    ? [...turns, { kind: "__streaming__" }]
    : turns;

  // Auto-scroll whenever turns change (streaming or new-chat load).
  useEffect(() => {
    const v = virtualizerRef.current;
    if (!v || items.length === 0) return;

    const scrollToEnd = () => v.scrollToIndex(items.length - 1, { align: "end" });

    if (scrollToChatBottomRef.current && turns.length > 0) {
      scrollToChatBottomRef.current = false;
      scrollToEnd();
      const raf = requestAnimationFrame(() => {
        scrollToEnd();
        const t = setTimeout(scrollToEnd, 150);
        return () => clearTimeout(t);
      });
      return () => cancelAnimationFrame(raf);
    }
    if (turns.length === 1 || wasAtBottomRef.current) {
      scrollToEnd();
    }
  }, [turns]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderItem = (item: VirtualItem, i: number) => {
    if (item.kind === "__streaming__") {
      return (
        <div key="__streaming__" className="thinking-pulse" aria-label="thinking">
          <span />
          <span />
          <span />
        </div>
      );
    }
    if (item.kind === "user") {
      return (
        <div key={item.id} data-turn-id={item.id} data-turn-kind="user">
          <UserMessage text={item.text} attachments={item.attachments} />
        </div>
      );
    }
    if (item.kind === "assistant") {
      return (
        <AssistantMessage
          key={item.id}
          content={item.content}
          toolResults={toolResults}
          cwd={cwd}
        />
      );
    }
    if (item.kind === "result") {
      const cost =
        typeof item.totalCostUsd === "number"
          ? `$${item.totalCostUsd.toFixed(4)}`
          : "—";
      return (
        <div key={item.id} className="result-line">
          {item.subtype} · {item.numTurns} turns ·{" "}
          {(item.durationMs / 1000).toFixed(1)}s · {cost}
        </div>
      );
    }
    // tool_results turns are invisible — they're threaded into their
    // corresponding AssistantMessage card via the toolResults map.
    return <div key={`tr-${i}`} style={{ display: "none" }} />;
  };

  if (turns.length === 0 && !isStreaming) {
    return (
      <div className="message-list" ref={containerRef}>
        <div className="message-list-empty">
          <p>{"Let's a build!"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={containerRef}>
      <Virtualizer
        ref={virtualizerRef}
        scrollRef={containerRef}
        bufferSize={600}
      >
        {items.map(renderItem)}
      </Virtualizer>
    </div>
  );
}

export const MessageList = memo(MessageListInner);
