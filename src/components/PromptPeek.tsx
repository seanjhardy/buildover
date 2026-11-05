import { useCallback, useEffect, useRef, useState } from "react";
import { indexOfPromptAbove } from "../lib/promptPeek.js";

// Resting the pointer on the top edge of a chat peeks at the user's message
// that has scrolled off above, so a long reply can be read with its prompt.
const HOVER_BAND_PX = 32;
// A pointer only passing through the band (on its way down from the header)
// shouldn't flash the peek.
const SHOW_DELAY_MS = 120;
const HIDE_DELAY_MS = 160;
// A click landing as the peek appears was aimed at the transcript beneath it.
const CLICK_ARM_MS = 250;
// A message starting this close to the top sits under the peek, so it counts
// as scrolled off: the peek never covers one message while naming another.
const COVERED_PX = 40;

interface PeekItem {
  id: string;
  text: string;
}

interface Props {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Every genuine user message in the transcript, oldest first. */
  items: PeekItem[];
  onJump: (id: string) => void;
}

function measure(container: HTMLElement, items: PeekItem[]): number {
  const mounted = Array.from(
    container.querySelectorAll<HTMLElement>('[data-turn-kind="user"][data-turn-id]'),
    (node) => ({
      id: node.dataset.turnId ?? "",
      // The bubble, not the timestamp rule above it, is what the reader sees.
      top: (node.querySelector(".message.user") ?? node).getBoundingClientRect().top,
    }),
  );
  return indexOfPromptAbove(
    items.map((item) => item.id),
    mounted,
    container.getBoundingClientRect().top + COVERED_PX,
  );
}

export function PromptPeek({ containerRef, items, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(-1);
  const peekRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef(false);
  const openedAtRef = useRef(0);
  // After a jump the pointer is still on the band; wait for it to leave
  // before peeking again.
  const dismissedRef = useRef(false);
  const itemsRef = useRef(items);

  const remeasure = useCallback(() => {
    const el = containerRef.current;
    if (el) setIndex(measure(el, itemsRef.current));
  }, [containerRef]);

  // A new message or a branch switch can change which one is above the view.
  useEffect(() => {
    itemsRef.current = items;
    if (openRef.current) remeasure();
  }, [items, remeasure]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let showTimer: number | undefined;
    let hideTimer: number | undefined;

    const show = () => {
      window.clearTimeout(hideTimer);
      hideTimer = undefined;
      if (openRef.current || showTimer !== undefined) return;
      showTimer = window.setTimeout(() => {
        showTimer = undefined;
        remeasure();
        openRef.current = true;
        openedAtRef.current = performance.now();
        setOpen(true);
      }, SHOW_DELAY_MS);
    };
    const hide = () => {
      window.clearTimeout(showTimer);
      showTimer = undefined;
      if (!openRef.current || hideTimer !== undefined) return;
      hideTimer = window.setTimeout(() => {
        hideTimer = undefined;
        openRef.current = false;
        setOpen(false);
      }, HIDE_DELAY_MS);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const overPeek = peekRef.current?.contains(event.target as Node) ?? false;
      const inBand = event.clientY - el.getBoundingClientRect().top <= HOVER_BAND_PX;
      if (!overPeek && !inBand) {
        dismissedRef.current = false;
        hide();
      } else if (!dismissedRef.current) {
        show();
      }
    };
    const onPointerLeave = () => {
      dismissedRef.current = false;
      hide();
    };
    // Follow the reader while they scroll with the peek open.
    const onScroll = () => {
      if (openRef.current) remeasure();
    };

    el.addEventListener("pointermove", onPointerMove, { passive: true });
    el.addEventListener("pointerleave", onPointerLeave, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("scroll", onScroll);
    };
  }, [containerRef, remeasure]);

  const item = index >= 0 ? items[index] : undefined;
  const shown = open && item !== undefined;

  return (
    <div className="prompt-peek-anchor">
      {item && (
        <button
          ref={peekRef}
          type="button"
          className={`prompt-peek${shown ? " prompt-peek--open" : ""}`}
          tabIndex={shown ? 0 : -1}
          aria-hidden={!shown}
          aria-label="Jump to this message"
          onClick={() => {
            if (performance.now() - openedAtRef.current < CLICK_ARM_MS) return;
            dismissedRef.current = true;
            openRef.current = false;
            setOpen(false);
            onJump(item.id);
          }}
        >
          <span className="prompt-peek-label">
            {index === items.length - 1
              ? "Your last message"
              : `Your message ${index + 1} of ${items.length}`}
          </span>
          <span className="prompt-peek-text">
            {item.text.trim() || "Attachments only"}
          </span>
        </button>
      )}
    </div>
  );
}
