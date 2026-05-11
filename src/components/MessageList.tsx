import { memo, useEffect, useMemo, useRef } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import type { BranchInfo, ChatTurn } from "../hooks/useAgent.js";
import type { ContentBlock } from "../types.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { ToolGroup } from "./ToolGroup.js";
import { UserMessage } from "./UserMessage.js";

// Runs of 3+ consecutive tool calls (across consecutive assistant turns) are
// collapsed under a single "N tools called" header.
const TOOL_GROUP_THRESHOLD = 3;

// How many pixels from the bottom counts as "at the bottom". A small
// threshold handles sub-pixel rounding and the streaming thinking pulse.
const SCROLL_THRESHOLD = 120;

// Data the MessageJumpBar needs to navigate without querying the DOM.
// MessageList writes this on every render so the jump bar always has
// up-to-date indices into the virtual list.
export interface JumpBarHandle {
  virtualizerRef: React.RefObject<VirtualizerHandle | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  // One entry per user message, in order. itemIndex is the index into the
  // Virtualizer's children array (accounting for the top-spacer at index 0).
  userItems: { id: string; text: string; itemIndex: number }[];
}

interface Props {
  turns: ChatTurn[];
  isStreaming: boolean;
  cwd?: string;
  scrollRef?: React.RefObject<HTMLDivElement>;
  jumpBarRef?: React.RefObject<JumpBarHandle | null>;
  chatId?: string;
  branchInfo?: Map<string, BranchInfo>;
  onForkMessage?: (userMessageId: string, newText: string) => void;
  onSwitchBranch?: (parentMessageId: string, targetBranchId: string) => void;
}

// A single virtual row — either a real ChatTurn, the streaming indicator, or
// a synthetic "tool group" that coalesces a run of tool-only assistant turns.
type VirtualItem =
  | ChatTurn
  | { kind: "__streaming__" }
  | {
      kind: "__tool_group__";
      id: string;
      tools: Extract<ContentBlock, { type: "tool_use" }>[];
    };

// Returns true if every block in the assistant turn's content is a tool_use.
function isToolOnlyAssistant(turn: ChatTurn): turn is Extract<ChatTurn, { kind: "assistant" }> {
  return (
    turn.kind === "assistant" &&
    turn.content.length > 0 &&
    turn.content.every((b) => b.type === "tool_use")
  );
}

// Walks the flat turns list and coalesces runs of consecutive tool-only
// assistant turns (plus their interleaved invisible tool_results turns) into
// a single tool-group virtual item when the run contains TOOL_GROUP_THRESHOLD
// or more tool_use blocks. Smaller runs pass through unchanged.
function buildVirtualItems(turns: ChatTurn[]): VirtualItem[] {
  const out: VirtualItem[] = [];
  let i = 0;
  while (i < turns.length) {
    const t = turns[i];
    if (isToolOnlyAssistant(t)) {
      // Greedily extend the run across consecutive tool-only assistant turns,
      // tolerating interleaved tool_results turns (which are invisible anyway).
      const tools: Extract<ContentBlock, { type: "tool_use" }>[] = [];
      const consumed: ChatTurn[] = [];
      let j = i;
      while (j < turns.length) {
        const tj = turns[j];
        if (isToolOnlyAssistant(tj)) {
          for (const b of tj.content) {
            tools.push(b as Extract<ContentBlock, { type: "tool_use" }>);
          }
          consumed.push(tj);
          j++;
        } else if (tj.kind === "tool_results") {
          consumed.push(tj);
          j++;
        } else {
          break;
        }
      }
      if (tools.length >= TOOL_GROUP_THRESHOLD) {
        out.push({
          kind: "__tool_group__",
          id: `tg-${tools[0].id}`,
          tools,
        });
      } else {
        // Not enough tools to collapse — emit the consumed turns as-is.
        for (const c of consumed) out.push(c);
      }
      i = j;
      continue;
    }
    out.push(t);
    i++;
  }
  return out;
}

function MessageListInner({ turns, isStreaming, cwd, scrollRef, jumpBarRef, chatId, branchInfo, onForkMessage, onSwitchBranch }: Props) {
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
  // MessageJumpBar can attach its scroll listener.
  useEffect(() => {
    if (!scrollRef) return;
    (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current =
      containerRef.current;
  });

  // Build the virtual items list: grouped turns + optional streaming indicator.
  // Index 0 is always the top spacer div, so actual item indices start at 1.
  const grouped = buildVirtualItems(turns);
  const items: VirtualItem[] = isStreaming
    ? [...grouped, { kind: "__streaming__" }]
    : grouped;

  // Build the jump-bar data: for each user message, record which Virtualizer
  // child index it occupies (+1 for the top-spacer at index 0).
  const userItems = useMemo(() => {
    const result: { id: string; text: string; itemIndex: number }[] = [];
    items.forEach((item, i) => {
      if (item.kind === "user") {
        result.push({ id: item.id, text: item.text, itemIndex: i + 1 }); // +1 for spacer
      }
    });
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, isStreaming]);

  // Keep jumpBarRef up to date every render so the scroll handler always
  // reads the latest userItems and virtualizerRef without needing a re-mount.
  useEffect(() => {
    if (!jumpBarRef) return;
    (jumpBarRef as React.MutableRefObject<JumpBarHandle | null>).current = {
      virtualizerRef,
      containerRef,
      userItems,
    };
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
    if (item.kind === "__tool_group__") {
      return (
        <ToolGroup
          key={item.id}
          tools={item.tools}
          toolResults={toolResults}
          cwd={cwd}
        />
      );
    }
    if (item.kind === "user") {
      return (
        <div key={item.id} data-turn-id={item.id} data-turn-kind="user">
          <UserMessage
            text={item.text}
            attachments={item.attachments}
            messageId={item.id}
            branchInfo={branchInfo?.get(item.id)}
            isStreaming={isStreaming}
            onFork={onForkMessage ?? (() => {})}
            onSwitchBranch={onSwitchBranch ?? (() => {})}
          />
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
        <div key="__top-spacer__" style={{ height: 40 }} />
        {items.map(renderItem)}
      </Virtualizer>
    </div>
  );
}

export const MessageList = memo(MessageListInner);
