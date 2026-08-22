import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BranchInfo, ChatTurn } from "../hooks/useAgent.js";
import type { Attachment } from "../types.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { UserMessage } from "./UserMessage.js";
import { SystemMessage } from "./SystemMessage.js";
import { TimestampDivider } from "./TimestampDivider.js";

// Allow only rounding noise when deciding that a deliberate downward scroll
// has returned to the bottom.
const BOTTOM_EPSILON = 2;
const INITIAL_HISTORY_ITEMS = 60;
const HISTORY_BATCH_SIZE = 60;

// Data the MessageJumpBar needs to navigate the rendered message list.
export interface JumpBarHandle {
  containerRef: React.RefObject<HTMLDivElement | null>;
  userItems: { id: string; text: string }[];
  // Called by MessageList whenever userItems changes so the jump bar can
  // refresh its state even when no scroll event fires (e.g. branch switch).
  notifyUpdate?: () => void;
  // Jump navigation is deliberate browsing, so it must opt out of bottom pinning.
  setPinned?: (pinned: boolean) => void;
  scrollToMessage?: (id: string) => void;
}

interface Props {
  turns: ChatTurn[];
  isStreaming: boolean;
  historyReady?: boolean;
  cwd?: string;
  scrollRef?: React.RefObject<HTMLDivElement>;
  jumpBarRef?: React.RefObject<JumpBarHandle | null>;
  chatId?: string;
  branchInfo?: Map<string, BranchInfo>;
  onForkMessage?: (
    userMessageId: string,
    newText: string,
    attachments?: Attachment[],
  ) => void;
  onSwitchBranch?: (parentMessageId: string, targetBranchId: string) => void;
  onRevert?: (checkpointId: string) => void;
}

type RenderedTurn = Exclude<ChatTurn, { kind: "tool_results" }>;
type MessageItem = RenderedTurn | { kind: "__streaming__" };

function MessageListInner({ turns, isStreaming, historyReady = true, cwd, scrollRef, jumpBarRef, chatId, branchInfo, onForkMessage, onSwitchBranch, onRevert }: Props) {
  // The scroll container div. Also exposed to the jump bar.
  const containerRef = useRef<HTMLDivElement>(null);
  const historySentinelRef = useRef<HTMLDivElement>(null);

  // This records user intent, not a scroll-position snapshot. Layout shifts and
  // programmatic scrolls must never unpin a user who was following the output.
  const isPinnedRef = useRef(true);
  const previousChatIdRef = useRef<string | undefined>(undefined);
  const pendingWindowScrollRef = useRef<
    | { kind: "prepend"; scrollHeight: number; scrollTop: number }
    | { kind: "jump"; messageId: string }
    | null
  >(null);
  const [historyWindow, setHistoryWindow] = useState<{
    chatId?: string;
    start: number;
    expanded: boolean;
  }>({ chatId, start: 0, expanded: false });

  // Keep tool results immutable. AssistantMessage is memoized and compares the
  // result entries it uses; mutating one shared map made old and new props point
  // at the same values, so completed tools could remain stuck in a loading state.
  const toolResults = useMemo(() => {
    const result: Record<string, { content: string; isError: boolean }> = {};
    for (const turn of turns) {
      if (turn.kind !== "tool_results") continue;
      for (const block of turn.content) {
        if (block.type === "tool_result") {
          result[block.tool_use_id] = {
            content: block.content,
            isError: Boolean(block.is_error),
          };
        }
      }
    }
    return result;
  }, [turns]);

  // Wire the external scrollRef to the same DOM element we control so that
  // MessageJumpBar can attach its scroll listener.
  useEffect(() => {
    if (!scrollRef) return;
    (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current =
      containerRef.current;
  });

  // Keep every persisted turn as a stable row. Dynamically replacing several
  // live tool rows with one synthetic group made the transcript move while the
  // user was reading it.
  const renderedTurns = useMemo(
    () => turns.filter((turn): turn is RenderedTurn => turn.kind !== "tool_results"),
    [turns],
  );
  const items: MessageItem[] = isStreaming
    ? [...renderedTurns, { kind: "__streaming__" }]
    : renderedTurns;
  const isEmpty = turns.length === 0 && !isStreaming;
  const isHydrating = isEmpty && !historyReady;

  // Render only the newest history initially. Unlike height-based
  // virtualization, this keeps every mounted row in ordinary document flow and
  // prepends real rows in stable batches when the user asks for older history.
  const tailStart = Math.max(0, items.length - INITIAL_HISTORY_ITEMS);
  const historyIsExpanded =
    historyWindow.chatId === chatId && historyWindow.expanded;
  // A chat switch can render once with the previous chat's turns before the
  // new replay/cache state commits. Until this chat is explicitly expanded,
  // derive its window directly from the current tail without mutating state.
  const historyStart = historyIsExpanded
    ? Math.min(historyWindow.start, tailStart)
    : tailStart;
  const visibleItems = items.slice(historyStart);

  const findRenderedMessage = (id: string): HTMLElement | undefined => {
    const el = containerRef.current;
    if (!el) return undefined;
    return Array.from(
      el.querySelectorAll<HTMLElement>('[data-turn-kind="user"][data-turn-id]'),
    ).find((node) => node.dataset.turnId === id);
  };

  const scrollMessageToCenter = (id: string, behavior: ScrollBehavior) => {
    const el = containerRef.current;
    const target = findRenderedMessage(id);
    if (!el || !target) return;
    const containerTop = el.getBoundingClientRect().top;
    const targetRect = target.getBoundingClientRect();
    const targetCenter =
      targetRect.top - containerTop + el.scrollTop + targetRect.height / 2;
    el.scrollTo({
      top: targetCenter - el.clientHeight / 2,
      behavior,
    });
  };

  const loadEarlier = useCallback(() => {
    const el = containerRef.current;
    const currentStart = historyStart;
    if (!el || currentStart === 0 || pendingWindowScrollRef.current) return;
    isPinnedRef.current = false;
    pendingWindowScrollRef.current = {
      kind: "prepend",
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
    setHistoryWindow({
      chatId,
      expanded: true,
      start: Math.max(0, currentStart - HISTORY_BATCH_SIZE),
    });
  }, [chatId, historyStart]);

  // Prepend history as the user approaches the top. The layout effect below
  // restores the exact viewport offset, so loading another batch is invisible
  // to someone reading the first currently mounted message.
  useEffect(() => {
    const root = containerRef.current;
    const sentinel = historySentinelRef.current;
    if (!root || !sentinel || historyStart === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadEarlier();
      },
      {
        root,
        rootMargin: "180px 0px 0px 0px",
        threshold: 0,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [historyStart, loadEarlier]);

  const scrollToMessage = (id: string) => {
    const itemIndex = items.findIndex(
      (item) => item.kind === "user" && item.id === id,
    );
    if (itemIndex < 0) return;
    isPinnedRef.current = false;
    if (itemIndex < historyStart) {
      pendingWindowScrollRef.current = { kind: "jump", messageId: id };
      setHistoryWindow({
        chatId,
        expanded: true,
        start: Math.max(0, itemIndex - 5),
      });
      return;
    }
    scrollMessageToCenter(id, "smooth");
  };

  // Build the jump-bar from the complete transcript, not just the mounted
  // history window. scrollToMessage reveals an unloaded target before jumping.
  const userItems = useMemo(() => {
    const result: { id: string; text: string }[] = [];
    renderedTurns.forEach((item) => {
      // Only genuine user input belongs in the jump bar — injected system /
      // subagent messages share the "user" slot but aren't the user's turns.
      if (item.kind === "user" && (!item.origin || item.origin === "user")) {
        result.push({ id: item.id, text: item.text });
      }
    });
    return result;
  }, [renderedTurns]);

  // Keep jumpBarRef up to date every render so the scroll handler always
  // reads the latest userItems without needing a re-mount.
  useEffect(() => {
    if (!jumpBarRef) return;
    (jumpBarRef as React.MutableRefObject<JumpBarHandle | null>).current = {
      containerRef,
      userItems,
      notifyUpdate: jumpBarRef.current?.notifyUpdate,
      setPinned: (pinned) => {
        isPinnedRef.current = pinned;
      },
      scrollToMessage,
    };
  });

  // Notify the jump bar whenever userItems changes (e.g. branch switch) so it
  // can refresh its active dot and gradient without waiting for a scroll event.
  useEffect(() => {
    jumpBarRef?.current?.notifyUpdate?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userItems]);

  // Only explicit upward input unpins the view. A plain scroll event is not
  // enough: browsers also emit one for scroll anchoring, layout clamps, and our
  // own scrollTop writes. Downward input re-pins once it reaches the true end.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let touchY: number | null = null;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance <= BOTTOM_EPSILON) isPinnedRef.current = true;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        isPinnedRef.current = false;
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== null && nextY !== undefined && nextY > touchY) {
        isPinnedRef.current = false;
      }
      touchY = nextY ?? touchY;
    };
    const onPointerDown = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      // A pointer press in the scrollbar gutter means the user is taking
      // manual control. If they drag to the end, onScroll re-pins it.
      if (event.clientX >= rect.right - 18) isPinnedRef.current = false;
    };
    const onPointerUp = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance <= BOTTOM_EPSILON) isPinnedRef.current = true;
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  useLayoutEffect(() => {
    pendingWindowScrollRef.current = null;
  }, [chatId]);

  // After prepending a history batch, offset scrollTop by the exact new height
  // so the message under the user's eyes does not move. Jump navigation that
  // reveals an older batch centres its target in the same pre-paint phase.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const pending = pendingWindowScrollRef.current;
    if (!el || !pending) return;
    pendingWindowScrollRef.current = null;
    if (pending.kind === "prepend") {
      el.scrollTop = pending.scrollTop + (el.scrollHeight - pending.scrollHeight);
    } else {
      scrollMessageToCenter(pending.messageId, "auto");
    }
  }, [historyStart]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the view pinned when message content grows or the composer changes the
  // viewport height. Native document flow makes scrollHeight authoritative.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const inner = el.firstElementChild;
    const observer = new ResizeObserver(() => {
      if (isPinnedRef.current) el.scrollTop = el.scrollHeight;
      jumpBarRef?.current?.notifyUpdate?.();
    });
    if (inner) observer.observe(inner);
    observer.observe(el);
    return () => observer.disconnect();
  }, [jumpBarRef, isEmpty]);

  // Pin before paint whenever rows change. This prevents the one-frame upward
  // jump caused by waiting for requestAnimationFrame while content is appended.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chatChanged = previousChatIdRef.current !== chatId;
    previousChatIdRef.current = chatId;
    if (chatChanged) isPinnedRef.current = true;
    if (items.length > 0 && (chatChanged || isPinnedRef.current)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns, isStreaming, chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderItem = (item: MessageItem) => {
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
      // Messages injected by the app or another agent (subagent reports,
      // coordinator feedback, plan relays) render as muted system chips —
      // never as user bubbles.
      if (item.origin && item.origin !== "user") {
        return (
          <div key={item.id} data-turn-id={item.id} data-turn-kind="system">
            <SystemMessage
              origin={item.origin}
              label={item.originLabel}
              text={item.text}
            />
          </div>
        );
      }
      return (
        <div key={item.id} data-turn-id={item.id} data-turn-kind="user">
          <TimestampDivider ts={item.ts} />
          <UserMessage
            text={item.text}
            attachments={item.attachments}
            messageId={item.id}
            branchInfo={branchInfo?.get(item.id)}
            isStreaming={isStreaming}
            checkpointId={item.checkpointId}
            onFork={onForkMessage ?? (() => {})}
            onRevert={onRevert}
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
          <span>
            {item.subtype} · {item.numTurns} turns ·{" "}
            {(item.durationMs / 1000).toFixed(1)}s · {cost}
          </span>
        </div>
      );
    }
  };

  if (isHydrating) {
    return (
      <div
        className="message-list message-list--hydrating"
        ref={containerRef}
        aria-label="Loading conversation"
        aria-busy="true"
      >
        <div className="message-list-hydrating-indicator" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="message-list message-list--empty" ref={containerRef}>
        <div className="message-list-empty">
          <div className="message-list-empty-logo" aria-hidden="true" />
          <p>{"Let's a build!"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={containerRef}>
      <div className="message-list-content">
        {historyStart > 0 && (
          <div
            ref={historySentinelRef}
            className="message-history-sentinel"
            aria-hidden="true"
          />
        )}
        {visibleItems.map(renderItem)}
      </div>
    </div>
  );
}

export const MessageList = memo(MessageListInner);
