import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import type { ChatPriority, ChatStatus, ChatTier, ChatWaitKind } from "../types.js";
import { CHAT_TIERS } from "../types.js";
import { api } from "../lib/api.js";
import {
  dropOrder,
  resurfaceChoices,
  SECTION_LABEL,
  SECTIONS,
  shortWhen,
  snoozeChoices,
  TIER_KEYS,
  TIER_LABEL,
  type QueueSection,
} from "../lib/queueOrder.js";
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
  /** Which section of the list it sits in. */
  section: QueueSection;
  /** Set while it's snoozed off the list: when it comes back. */
  snoozedUntil?: string;
}

export interface WaitInput {
  kind?: ChatWaitKind;
  target?: string;
  note?: string;
  resurfaceAt?: string;
}

/** Which inline editor is open under which card. */
export type QueueEditor = { chatId: string; kind: "waiting" | "snooze" } | null;

const REASON: Partial<Record<ChatStatus, string>> = {
  awaiting_input: "Waiting for you",
  agent_done: "Finished",
  error: "Hit an error",
};

const KEY_OF = Object.fromEntries(
  Object.entries(TIER_KEYS).map(([key, tier]) => [tier ?? "none", key]),
) as Record<ChatTier | "none", string>;

const WATCH_LABEL: Record<ChatWaitKind, string> = { github: "PR", slack: "Slack", email: "email" };

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

/** The card's second line: what it's waiting on, why it's back, or what it said. */
function reasonOf(item: QueueItem, now: number): string {
  const p = item.priority;
  if (item.snoozedUntil) return `Snoozed until ${shortWhen(item.snoozedUntil, now)}`;
  if (item.section === "back") return `Back: ${p?.back?.because ?? "its date came round"}`;
  if (p?.tier === "waiting") {
    const parts = [`Waiting on ${p.waitingOn || "something"}`];
    const watching = [...new Set((p.waits ?? []).map((w) => WATCH_LABEL[w.kind]))];
    if (watching.length) parts.push(`watching ${watching.join(", ")}`);
    if (p.resurfaceAt) parts.push(`back ${shortWhen(p.resurfaceAt, now)}`);
    return parts.join(" · ");
  }
  return item.summary || REASON[item.status] || "Needs you";
}

/** "2026-11-09T09:00" for a datetime-local input, in local time. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | undefined {
  const d = v ? new Date(v) : null;
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

/** Escape shuts an inline editor without the grid seeing it. */
function escapes(onCancel: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };
}

/** Under a card: what it's waiting on, what to watch, and when to bring it back. */
function WaitingEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ChatPriority;
  onSave: (w: WaitInput) => void;
  onCancel: () => void;
}) {
  const waiting = initial?.tier === "waiting" && !initial.back;
  const [what, setWhat] = useState(waiting ? (initial.waitingOn ?? "") : "");
  const [kind, setKind] = useState<ChatWaitKind | null>(null);
  const [when, setWhen] = useState(() =>
    waiting && initial.resurfaceAt ? toLocalInput(new Date(initial.resurfaceAt)) : "",
  );
  // A PR link watches the PR unless told otherwise.
  const looksLikePr = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|^[\w.-]+\/[\w.-]+#\d+$/.test(what.trim());
  const watch = kind ?? (looksLikePr ? "github" : null);
  const canSave = !watch || !!what.trim();
  return (
    <form
      className="gc-qedit"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSave) return;
        onSave({
          ...(watch && { kind: watch, target: what.trim() }),
          ...(what.trim() && { note: what.trim() }),
          resurfaceAt: fromLocalInput(when),
        });
      }}
      onKeyDown={escapes(onCancel)}
    >
      <input
        autoFocus
        className="gc-qedit-input"
        placeholder="Waiting on… (a PR link, Dan's reply in #infra, an email)"
        value={what}
        onChange={(e) => setWhat(e.target.value)}
      />
      <div className="gc-qedit-label">Watch</div>
      <div className="gc-qedit-chips">
        {([null, "github", "slack", "email"] as const).map((k) => (
          <button
            key={k ?? "none"}
            type="button"
            className={`gc-qedit-chip${watch === k ? " gc-qedit-chip--on" : ""}`}
            onClick={() => setKind(k)}
          >
            {k ? (k === "github" ? "GitHub PR" : k === "slack" ? "Slack" : "Email") : "Nothing"}
          </button>
        ))}
      </div>
      <div className="gc-qedit-label">Bring it back</div>
      <div className="gc-qedit-chips">
        {resurfaceChoices(Date.now()).map((c) => {
          const v = toLocalInput(c.at);
          return (
            <button
              key={c.label}
              type="button"
              className={`gc-qedit-chip${when === v ? " gc-qedit-chip--on" : ""}`}
              onClick={() => setWhen(v)}
            >
              {c.label}
            </button>
          );
        })}
        <button
          type="button"
          className={`gc-qedit-chip${when === "" ? " gc-qedit-chip--on" : ""}`}
          onClick={() => setWhen("")}
        >
          {watch ? "When it happens" : "No date"}
        </button>
      </div>
      <input
        type="datetime-local"
        className="gc-qedit-input"
        aria-label="Bring it back on"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
      />
      <div className="gc-qedit-actions">
        <button type="button" className="gc-qedit-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="gc-qedit-btn gc-qedit-btn--save" disabled={!canSave}>
          Wait
        </button>
      </div>
    </form>
  );
}

/** Under a card: snooze it off the list for a while, or until a set time. */
function SnoozeEditor({
  current,
  onSnooze,
  onCancel,
}: {
  current?: string;
  onSnooze: (until: string | null) => void;
  onCancel: () => void;
}) {
  const [when, setWhen] = useState(() => toLocalInput(current ? new Date(current) : snoozeChoices(Date.now())[2].at));
  return (
    <form
      className="gc-qedit gc-qedit--snooze"
      onSubmit={(e) => {
        e.preventDefault();
        const at = fromLocalInput(when);
        if (at) onSnooze(at);
      }}
      onKeyDown={escapes(onCancel)}
    >
      <div className="gc-qedit-chips">
        {snoozeChoices(Date.now()).map((c, i) => (
          <button
            key={c.label}
            type="button"
            autoFocus={i === 0}
            className="gc-qedit-chip"
            onClick={() => onSnooze(c.at.toISOString())}
          >
            {c.label}
          </button>
        ))}
      </div>
      <input
        type="datetime-local"
        className="gc-qedit-input"
        aria-label="Snooze until"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
      />
      <div className="gc-qedit-actions">
        {current && (
          <button type="button" className="gc-qedit-btn" onClick={() => onSnooze(null)}>
            Wake now
          </button>
        )}
        <button type="button" className="gc-qedit-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="gc-qedit-btn gc-qedit-btn--save">
          Snooze
        </button>
      </div>
    </form>
  );
}

/** The box at the top: what's typed goes to the Master, which sorts the list. */
function AskMaster() {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");
  return (
    <form
      className="gc-qask"
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t || state === "sending") return;
        setState("sending");
        api
          .messageMaster(t)
          .then(() => {
            setText("");
            setState("idle");
            window.dispatchEvent(new CustomEvent("buildover:open-master"));
          })
          .catch(() => setState("error"));
      }}
    >
      <input
        className={`gc-qask-input${state === "error" ? " gc-qask-input--error" : ""}`}
        placeholder={state === "error" ? "Couldn't reach the Master. Try again" : "Tell the Master how to sort these…"}
        value={text}
        disabled={state === "sending"}
        onChange={(e) => {
          setText(e.target.value);
          if (state === "error") setState("idle");
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        }}
      />
    </form>
  );
}

interface Props {
  /** In list order; snoozed ones are kept apart at the foot. */
  items: QueueItem[];
  /** The chat the canvas is focused on; the reel follows it when it's listed. */
  open: string | null;
  onOpen: (chatId: string) => void;
  /** Sets a chat's tier; null clears it. */
  onSetPriority: (chatId: string, priority: ChatPriority | null) => void;
  onWait: (chatId: string, wait: WaitInput) => void;
  onSnooze: (chatId: string, until: string | null) => void;
  /** A drop: these chats, in this order, land in this tier. */
  onPlace: (items: { chatId: string; tier: ChatTier; rank: number }[]) => void;
  editor: QueueEditor;
  onEditor: (editor: QueueEditor) => void;
  /** A passing line at the foot of the list (e.g. "Fix login: Low"). */
  hint?: string | null;
}

/** Every chat waiting on the user — asking something, finished, or stopped on
 *  an error — down the right of the canvas as a rolling reel in priority
 *  sections: the current card sits near the middle and the rest shrink and
 *  fade with distance. Scroll to move along it, click a card to fly to its
 *  chat, drag one to move it, right-click it for its tier, waiting and
 *  snooze. A card only leaves when its chat stops needing the user. */
export function GridQueue({
  items,
  open,
  onOpen,
  onSetPriority,
  onWait,
  onSnooze,
  onPlace,
  editor,
  onEditor,
  hint,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  const wheel = useRef(0);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  const [, setTick] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; item: QueueItem } | null>(null);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ section: QueueSection; index: number } | null>(null);

  const now = Date.now();
  const awake = items.filter((it) => !it.snoozedUntil);
  const snoozed = items.filter((it) => it.snoozedUntil);
  const shown = showSnoozed ? [...awake, ...snoozed] : awake;
  const bySection = new Map<QueueSection, QueueItem[]>(SECTIONS.map((s) => [s, []]));
  for (const it of awake) bySection.get(it.section)!.push(it);

  // An editor opened on a snoozed chat (Z on its window) shows it.
  const editingSnoozed = !!editor && snoozed.some((it) => it.chatId === editor.chatId);
  useEffect(() => {
    if (editingSnoozed) setShowSnoozed(true);
  }, [editingSnoozed]);

  const openIndex = open ? shown.findIndex((it) => it.chatId === open) : -1;
  useEffect(() => {
    if (openIndex >= 0) setCursor(openIndex);
  }, [openIndex]);
  // When the list shrinks under it, the cursor stays put and the next card
  // slides into its place.
  const at = Math.min(cursor, Math.max(0, shown.length - 1));

  useLayoutEffect(() => {
    const place = () => {
      const el = cards.current[at];
      if (!el || !box.current) return setOffset(0);
      setOffset(Math.min(0, box.current.clientHeight * 0.42 - (el.offsetTop + el.offsetHeight / 2)));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [at, items, editor, showSnoozed, drag]);

  // Keep the "5m" ages honest while nothing else changes.
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const menuItems = (item: QueueItem): ContextMenuEntry[] => {
    const current = item.priority?.tier;
    return [
      ...CHAT_TIERS.map((tier) => ({
        label: tier === "waiting" ? "Waiting on…" : TIER_LABEL[tier],
        icon: current === tier && item.section !== "back" ? Check : undefined,
        shortcut: KEY_OF[tier],
        onSelect: () =>
          tier === "waiting"
            ? onEditor({ chatId: item.chatId, kind: "waiting" })
            : onSetPriority(item.chatId, { tier }),
      })),
      "divider" as const,
      {
        label: item.snoozedUntil ? "Snoozed…" : "Snooze…",
        shortcut: "Z",
        onSelect: () => onEditor({ chatId: item.chatId, kind: "snooze" }),
      },
      ...(item.snoozedUntil ? [{ label: "Wake now", onSelect: () => onSnooze(item.chatId, null) }] : []),
      {
        label: "Clear tier",
        shortcut: KEY_OF.none,
        disabled: !current,
        onSelect: () => onSetPriority(item.chatId, null),
      },
    ];
  };

  const endDrag = () => {
    setDrag(null);
    setOver(null);
  };
  const drop = () => {
    if (drag && over) {
      const ids = bySection.get(over.section)!.map((it) => it.chatId);
      onPlace(dropOrder(over.section, ids, drag, over.index));
    }
    endDrag();
  };
  // While dragging, every section but "back" shows, so empty ones take drops.
  const sectionsShown = SECTIONS.filter((s) => (drag ? s !== "back" : bySection.get(s)!.length > 0));

  let i = -1;
  const card = (item: QueueItem, section: QueueSection | null, inSection: number) => {
    i += 1;
    const idx = i;
    const d = Math.abs(idx - at);
    const muted = !!item.snoozedUntil || item.section === "waiting";
    const base = d === 0 ? 1 : Math.max(0.15, 1 - d * 0.2);
    const sectionLen = section ? bySection.get(section)!.length : 0;
    const dropHere =
      drag && section && over?.section === section
        ? over.index === inSection
          ? "before"
          : over.index === sectionLen && inSection === sectionLen - 1
            ? "after"
            : undefined
        : undefined;
    return (
      <Fragment key={item.chatId}>
        <button
          ref={(el) => {
            cards.current[idx] = el;
          }}
          type="button"
          className={`gc-qcard${idx === at ? " gc-qcard--cursor" : ""}${item.chatId === open ? " gc-qcard--open" : ""}${muted ? " gc-qcard--muted" : ""}${item.chatId === drag ? " gc-qcard--dragging" : ""}`}
          data-section={item.section}
          data-drop={dropHere}
          draggable={!item.snoozedUntil}
          style={
            {
              ...repoColorVars(item.color),
              transform: `scale(${1 - Math.min(d, 5) * 0.045})`,
              opacity: muted ? base * 0.55 : base,
            } as React.CSSProperties
          }
          onClick={() => {
            setCursor(idx);
            onOpen(item.chatId);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setCursor(idx);
            setMenu({ x: e.clientX, y: e.clientY, item });
          }}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", item.chatId);
            setDrag(item.chatId);
          }}
          onDragEnd={endDrag}
          onDragOver={(e) => {
            if (!drag) return;
            if (!section || section === "back") {
              if (over) setOver(null);
              return;
            }
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const index = inSection + (e.clientY > r.top + r.height / 2 ? 1 : 0);
            if (over?.section !== section || over.index !== index) setOver({ section, index });
          }}
        >
          <span className="gc-qcard-main">
            <span className="gc-qcard-title">{item.title}</span>
            <span className="gc-qcard-summary">
              <span className="gc-qcard-repo">{item.repoName}</span>
              {" · "}
              {timeAgo(item.since)}
              {" · "}
              {reasonOf(item, now)}
            </span>
          </span>
          <Status status={item.status} />
        </button>
        {editor?.chatId === item.chatId &&
          (editor.kind === "waiting" ? (
            <WaitingEditor
              initial={item.priority}
              onSave={(w) => {
                onWait(item.chatId, w);
                onEditor(null);
              }}
              onCancel={() => onEditor(null)}
            />
          ) : (
            <SnoozeEditor
              current={item.snoozedUntil}
              onSnooze={(until) => {
                onSnooze(item.chatId, until);
                onEditor(null);
              }}
              onCancel={() => onEditor(null)}
            />
          ))}
      </Fragment>
    );
  };

  return (
    <aside className="gc-queue" aria-label="Chats waiting for you">
      <AskMaster />
      <div
        ref={box}
        className={`gc-qbody${offset < 0 ? " gc-qbody--scrolled" : ""}`}
        onWheel={(e) => {
          wheel.current += e.deltaY;
          if (Math.abs(wheel.current) < 50) return;
          setCursor(Math.max(0, Math.min(shown.length - 1, at + Math.sign(wheel.current))));
          wheel.current = 0;
        }}
        onDragOver={(e) => {
          if (drag) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          drop();
        }}
      >
        {items.length === 0 && <div className="gc-queue-empty">Nothing needs you.</div>}
        <div className="gc-reel" style={{ transform: `translateY(${offset}px)` }}>
          {sectionsShown.map((section) => {
            const list = bySection.get(section)!;
            return (
              <Fragment key={section}>
                <div
                  className={`gc-qhead${drag && over?.section === section && list.length === 0 ? " gc-qhead--drop" : ""}`}
                  data-section={section}
                  onDragOver={(e) => {
                    if (!drag || section === "back") return;
                    e.preventDefault();
                    if (over?.section !== section || over.index !== 0) setOver({ section, index: 0 });
                  }}
                >
                  <span className="gc-qhead-label">{SECTION_LABEL[section]}</span>
                  <span className="gc-qhead-count">{list.length || ""}</span>
                </div>
                {list.map((item, k) => card(item, section, k))}
              </Fragment>
            );
          })}
          {snoozed.length > 0 && (
            <button
              type="button"
              className="gc-qhead gc-qhead--snoozed"
              onClick={() => setShowSnoozed((v) => !v)}
              aria-expanded={showSnoozed}
            >
              <span className="gc-qhead-label">Snoozed</span>
              <span className="gc-qhead-count">
                {snoozed.length} {showSnoozed ? "▾" : "▸"}
              </span>
            </button>
          )}
          {showSnoozed && snoozed.map((item) => card(item, null, 0))}
        </div>
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
