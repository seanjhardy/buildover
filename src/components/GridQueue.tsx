import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import type { ChatPriority, ChatStatus, ChatTier } from "../types.js";
import { CHAT_TIERS } from "../types.js";
import { resurfaceChoices, shortWhen, TIER_KEYS, TIER_LABEL } from "../lib/queueOrder.js";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu.js";
import { repoColorVars, type RepoColor } from "./RepoChip.js";

export interface QueueItem {
  chatId: string;
  title: string;
  repoName: string;
  color: RepoColor;
  status: ChatStatus;
  /** When it started waiting (ms). */
  since: number;
  /** What it wants, in a line: its question, or the end of its last reply. */
  summary: string;
  /** The user's tier, if they set one. */
  priority?: ChatPriority;
  /** A waiting chat whose resurface date has passed: back up the list, flagged. */
  resurfaced?: boolean;
}

const KEY_OF = Object.fromEntries(
  Object.entries(TIER_KEYS).map(([key, tier]) => [tier ?? "none", key]),
) as Record<ChatTier | "none", string>;

/** The tier pill on a card: "Urgent", "Waiting · PR review · Mon 9:00",
 *  "Back · PR review". */
function TierPill({ priority, resurfaced }: { priority: ChatPriority; resurfaced?: boolean }) {
  const now = Date.now();
  const parts = [resurfaced ? "Back" : TIER_LABEL[priority.tier]];
  if (priority.waitingOn) parts.push(priority.waitingOn);
  if (priority.resurfaceAt && !resurfaced) parts.push(`until ${shortWhen(priority.resurfaceAt, now)}`);
  return <span className="gc-qtier">{parts.join(" · ")}</span>;
}

/** "2026-11-09T09:00" for a datetime-local input, in local time. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Under a card: what it's waiting on, and when to bring it back up. */
function WaitingEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ChatPriority;
  onSave: (p: ChatPriority) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState(initial?.tier === "waiting" ? (initial.waitingOn ?? "") : "");
  const [when, setWhen] = useState(() =>
    initial?.tier === "waiting" && initial.resurfaceAt ? toLocalInput(new Date(initial.resurfaceAt)) : "",
  );
  const save = () => {
    const at = when ? new Date(when) : null;
    onSave({
      tier: "waiting",
      ...(note.trim() && { waitingOn: note.trim() }),
      ...(at && Number.isFinite(at.getTime()) && { resurfaceAt: at.toISOString() }),
    });
  };
  return (
    <form
      className="gc-qwait"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <input
        autoFocus
        className="gc-qwait-note"
        placeholder="Waiting on… (an email, Slack, a PR review)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="gc-qwait-when">
        {resurfaceChoices(Date.now()).map((c) => {
          const v = toLocalInput(c.at);
          return (
            <button
              key={c.label}
              type="button"
              className={`gc-qwait-chip${when === v ? " gc-qwait-chip--on" : ""}`}
              onClick={() => setWhen(v)}
            >
              {c.label}
            </button>
          );
        })}
        <button
          type="button"
          className={`gc-qwait-chip${when === "" ? " gc-qwait-chip--on" : ""}`}
          onClick={() => setWhen("")}
        >
          No date
        </button>
      </div>
      <input
        type="datetime-local"
        className="gc-qwait-date"
        aria-label="Bring it back up on"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
      />
      <div className="gc-qwait-actions">
        <button type="button" className="gc-qwait-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="gc-qwait-btn gc-qwait-btn--save">
          Wait
        </button>
      </div>
    </form>
  );
}

const REASON: Partial<Record<ChatStatus, string>> = {
  awaiting_input: "Waiting for you",
  agent_done: "Finished",
  error: "Hit an error",
};

function Status({ status }: { status: ChatStatus }) {
  const icon =
    status === "agent_done" ? (
      <Check size={15} />
    ) : status === "error" ? (
      <CircleAlert size={15} />
    ) : (
      <span className="gc-qstatus-dot" />
    );
  return (
    <span className={`gc-qstatus gc-qstatus--${status}`} title={REASON[status] ?? "Needs you"}>
      {icon}
    </span>
  );
}

interface Props {
  items: QueueItem[];
  /** The chat the canvas is focused on; the reel follows it when it's listed. */
  open: string | null;
  onOpen: (chatId: string) => void;
  /** Sets a chat's tier; null clears it. */
  onSetPriority: (chatId: string, priority: ChatPriority | null) => void;
  /** The chat whose "waiting on" editor is open, if any. */
  editingWaiting: string | null;
  onEditWaiting: (chatId: string | null) => void;
  /** A passing line at the foot of the list (e.g. "Set 'Fix login' to Low"). */
  hint?: string | null;
}

/** Every chat waiting on the user — asking something, finished, or stopped on
 *  an error — down the right of the canvas as a rolling reel: the current card
 *  sits near the middle and the rest shrink and fade with distance. Scroll to
 *  move along it, click a card to fly to its chat. A card only leaves when its
 *  chat stops needing the user. */
export function GridQueue({
  items,
  open,
  onOpen,
  onSetPriority,
  editingWaiting,
  onEditWaiting,
  hint,
}: Props) {
  const box = useRef<HTMLElement>(null);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  const wheel = useRef(0);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  const [, setTick] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; item: QueueItem } | null>(null);

  const menuItems = (item: QueueItem): ContextMenuEntry[] => {
    const current = item.priority?.tier;
    return [
      ...CHAT_TIERS.map((tier) => ({
        label: tier === "waiting" ? "Waiting on…" : TIER_LABEL[tier],
        icon: current === tier ? Check : undefined,
        shortcut: KEY_OF[tier],
        onSelect: () =>
          tier === "waiting" ? onEditWaiting(item.chatId) : onSetPriority(item.chatId, { tier }),
      })),
      "divider" as const,
      {
        label: "Clear tier",
        shortcut: KEY_OF.none,
        disabled: !current,
        onSelect: () => onSetPriority(item.chatId, null),
      },
    ];
  };

  const openIndex = open ? items.findIndex((it) => it.chatId === open) : -1;
  useEffect(() => {
    if (openIndex >= 0) setCursor(openIndex);
  }, [openIndex]);
  // When the list shrinks under it, the cursor stays put and the next card
  // slides into its place.
  const at = Math.min(cursor, Math.max(0, items.length - 1));

  useLayoutEffect(() => {
    const place = () => {
      const el = cards.current[at];
      if (!el || !box.current) return setOffset(0);
      setOffset(Math.min(0, box.current.clientHeight * 0.42 - (el.offsetTop + el.offsetHeight / 2)));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [at, items, editingWaiting]);

  // Keep the "5m" ages honest while nothing else changes.
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <aside
      ref={box}
      className={`gc-queue${offset < 0 ? " gc-queue--scrolled" : ""}`}
      aria-label="Chats waiting for you"
      onWheel={(e) => {
        wheel.current += e.deltaY;
        if (Math.abs(wheel.current) < 50) return;
        setCursor(Math.max(0, Math.min(items.length - 1, at + Math.sign(wheel.current))));
        wheel.current = 0;
      }}
    >
      {items.length === 0 && <div className="gc-queue-empty">Nothing needs you.</div>}
      <div className="gc-reel" style={{ transform: `translateY(${offset}px)` }}>
        {items.map((item, i) => {
          const d = Math.abs(i - at);
          const tier = item.priority?.tier;
          const muted = tier === "waiting" && !item.resurfaced;
          const base = d === 0 ? 1 : Math.max(0.15, 1 - d * 0.2);
          return [
            <button
              key={item.chatId}
              ref={(el) => {
                cards.current[i] = el;
              }}
              type="button"
              className={`gc-qcard${i === at ? " gc-qcard--cursor" : ""}${item.chatId === open ? " gc-qcard--open" : ""}${muted ? " gc-qcard--muted" : ""}${item.resurfaced ? " gc-qcard--back" : ""}`}
              data-tier={tier}
              style={
                {
                  ...repoColorVars(item.color),
                  transform: `scale(${1 - Math.min(d, 5) * 0.045})`,
                  opacity: muted ? base * 0.55 : base,
                } as React.CSSProperties
              }
              onClick={() => {
                setCursor(i);
                onOpen(item.chatId);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setCursor(i);
                setMenu({ x: e.clientX, y: e.clientY, item });
              }}
            >
              <span className="gc-qcard-main">
                <span className="gc-qcard-title">{item.title}</span>
                {item.priority && <TierPill priority={item.priority} resurfaced={item.resurfaced} />}
                <span className="gc-qcard-summary">
                  <span className="gc-qcard-repo">{item.repoName}</span>
                  {" · "}
                  {timeAgo(item.since)}
                  {" · "}
                  {item.summary || REASON[item.status] || "Needs you"}
                </span>
              </span>
              <Status status={item.status} />
            </button>,
            editingWaiting === item.chatId && (
              <WaitingEditor
                key={`${item.chatId}:wait`}
                initial={item.priority}
                onSave={(p) => {
                  onSetPriority(item.chatId, p);
                  onEditWaiting(null);
                }}
                onCancel={() => onEditWaiting(null)}
              />
            ),
          ];
        })}
      </div>
      {hint && <div className="gc-queue-hint">{hint}</div>}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.item)} onClose={() => setMenu(null)} />
      )}
    </aside>
  );
}

/** Compact "time since" label: now, 5m, 3h, 2d. */
export function timeAgo(when: string | number): string {
  const mins = Math.floor((Date.now() - new Date(when).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
