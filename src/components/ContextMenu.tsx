import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

export interface ContextMenuItem {
  label: string;
  icon?: LucideIcon;
  /** Right-aligned shortcut hint, e.g. "⌘C". Display only. */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type ContextMenuEntry = ContextMenuItem | "divider";

interface Props {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

const MARGIN = 6;

/**
 * Right-click menu rendered through a portal so `position: fixed` is measured
 * against the viewport rather than any transformed ancestor. Flips towards the
 * cursor when it would overflow, matching native menu behaviour.
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  // Measure before paint so the menu never flashes at an off-screen position.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const flipLeft = x + width + MARGIN > window.innerWidth;
    const flipUp = y + height + MARGIN > window.innerHeight;
    setPos({
      left: Math.max(MARGIN, flipLeft ? x - width : x),
      top: Math.max(MARGIN, flipUp ? Math.max(MARGIN, y - height) : y),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const selectable = items
          .map((item, i) => (item !== "divider" && !item.disabled ? i : -1))
          .filter((i) => i !== -1);
        if (selectable.length === 0) return;
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const cursor = selectable.indexOf(activeIndex);
        const next = cursor === -1
          ? (delta === 1 ? 0 : selectable.length - 1)
          : (cursor + delta + selectable.length) % selectable.length;
        setActiveIndex(selectable[next]!);
        return;
      }
      if (e.key === "Enter" && activeIndex >= 0) {
        e.preventDefault();
        const item = items[activeIndex];
        if (item && item !== "divider" && !item.disabled) { onClose(); item.onSelect(); }
      }
    };
    // Deferred so the contextmenu event that opened this doesn't close it.
    const id = setTimeout(() => document.addEventListener("mousedown", onPointerDown), 0);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, items, activeIndex]);

  return createPortal(
    <div
      ref={menuRef}
      className="ctx-menu"
      role="menu"
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        visibility: pos ? "visible" : "hidden",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === "divider" ? (
          <div key={`d${i}`} className="ctx-menu-divider" />
        ) : (
          <button
            key={item.label + i}
            role="menuitem"
            type="button"
            disabled={item.disabled}
            className={`ctx-menu-item${item.danger ? " ctx-menu-item--danger" : ""}${
              activeIndex === i ? " ctx-menu-item--active" : ""
            }`}
            onMouseEnter={() => setActiveIndex(i)}
            onClick={() => { onClose(); item.onSelect(); }}
          >
            <span className="ctx-menu-icon">{item.icon ? <item.icon size={13} /> : null}</span>
            <span className="ctx-menu-label">{item.label}</span>
            {item.shortcut && <span className="ctx-menu-shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
