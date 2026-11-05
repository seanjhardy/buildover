import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import type { ChatStatus } from "../types.js";
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
}

/** Every chat waiting on the user — asking something, finished, or stopped on
 *  an error — down the right of the canvas as a rolling reel: the current card
 *  sits near the middle and the rest shrink and fade with distance. Scroll to
 *  move along it, click a card to fly to its chat. A card only leaves when its
 *  chat stops needing the user. */
export function GridQueue({ items, open, onOpen }: Props) {
  const box = useRef<HTMLElement>(null);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  const wheel = useRef(0);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  const [, setTick] = useState(0);

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
  }, [at, items]);

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
          return (
            <button
              key={item.chatId}
              ref={(el) => {
                cards.current[i] = el;
              }}
              type="button"
              className={`gc-qcard${i === at ? " gc-qcard--cursor" : ""}${item.chatId === open ? " gc-qcard--open" : ""}`}
              style={
                {
                  ...repoColorVars(item.color),
                  transform: `scale(${1 - Math.min(d, 5) * 0.045})`,
                  opacity: d === 0 ? 1 : Math.max(0.15, 1 - d * 0.2),
                } as React.CSSProperties
              }
              onClick={() => {
                setCursor(i);
                onOpen(item.chatId);
              }}
            >
              <span className="gc-qcard-main">
                <span className="gc-qcard-title">{item.title}</span>
                <span className="gc-qcard-summary">
                  <span className="gc-qcard-repo">{item.repoName}</span>
                  {" · "}
                  {timeAgo(item.since)}
                  {" · "}
                  {item.summary || REASON[item.status] || "Needs you"}
                </span>
              </span>
              <Status status={item.status} />
            </button>
          );
        })}
      </div>
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
