import { useCallback, useEffect, useState } from "react";
import { ChevronRight, CircleAlert } from "lucide-react";
import { api } from "../lib/api.js";
import type { ItemState, PipelineItemView, PipelineSourceView, PipelinesView } from "../types.js";
import { repoColorVars, type RepoColor } from "./RepoChip.js";
import "../styles/grid-sources.css";

// The pipeline sources down the left of the canvas: what each is working on
// out of sight, the week's spend against its budget, and the next sweep.
// Items that need the user arrive on the canvas as ordinary windows; this
// only shows the rest and opens them.

const POLL_MS = 10_000;

const STATE_LABEL: Record<ItemState, string> = {
  new: "Not started",
  working: "Looking into it",
  ready: "Ready for the next sweep",
  waiting: "Waiting",
  shown: "On your canvas",
  done: "Done",
};

/** States worth a line each, in this order. "new" is only counted. */
const LISTED: ItemState[] = ["shown", "ready", "working", "waiting"];

const money = (usd: number) => `$${usd < 10 ? usd.toFixed(2) : Math.round(usd)}`;

function when(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function Budget({ budget }: { budget: PipelinesView["budget"] }) {
  const { spentUsd, capUsd, warnAt } = budget;
  if (capUsd === null) {
    return (
      <div className="gs-budget" title="The budget is a share of one subscription's week. It's worked out from how far usage moves as agents run; until then one agent works at a time.">
        <div className="gs-budget-line">
          <span>{money(spentUsd)} this week</span>
          <span className="gs-faint">working out budget</span>
        </div>
      </div>
    );
  }
  const used = capUsd > 0 ? spentUsd / capUsd : 1;
  const level = used >= 1 ? "over" : used >= warnAt ? "warn" : "ok";
  return (
    <div className={`gs-budget gs-budget--${level}`}>
      <div className="gs-budget-line">
        <span>
          {money(spentUsd)} of {money(capUsd)} this week
        </span>
        {level === "over" && <span>paused</span>}
      </div>
      <div className="gs-meter">
        <div className="gs-meter-fill" style={{ width: `${Math.min(100, used * 100)}%` }} />
      </div>
    </div>
  );
}

function Item({ item, onOpen }: { item: PipelineItemView; onOpen: (item: PipelineItemView) => void }) {
  return (
    <button
      type="button"
      className={`gs-item gs-item--${item.state}`}
      onClick={() => onOpen(item)}
      disabled={!item.chatId}
      title={item.summary ?? item.title}
    >
      <span className="gs-item-dot" />
      <span className="gs-item-text">
        <span className="gs-item-title">
          {item.urgent && <CircleAlert size={12} className="gs-urgent" />}
          {item.title}
        </span>
        <span className="gs-item-state">{STATE_LABEL[item.state]}</span>
      </span>
    </button>
  );
}

function Source({
  source,
  color,
  onOpen,
}: {
  source: PipelineSourceView;
  color: RepoColor;
  onOpen: (item: PipelineItemView) => void;
}) {
  const [open, setOpen] = useState(true);
  const { counts } = source;
  const listed = LISTED.flatMap((s) => source.items.filter((i) => i.state === s));
  const tally = [
    counts.working && `${counts.working} working`,
    counts.ready && `${counts.ready} ready`,
    counts.waiting && `${counts.waiting} waiting`,
    counts.new && `${counts.new} not started`,
  ].filter(Boolean);
  return (
    <section className="gs-source" style={repoColorVars(color) as React.CSSProperties}>
      <button type="button" className="gs-source-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight size={13} className={`gs-chevron${open ? " gs-chevron--open" : ""}`} />
        <span className="gs-source-name">{source.name}</span>
        <span className="gs-faint">{money(source.spendUsd)}</span>
      </button>
      <div className="gs-tally">{tally.length ? tally.join(" · ") : "Nothing open"}</div>
      {source.error && (
        <div className="gs-error" title={source.error}>
          {source.error}
        </div>
      )}
      {open && listed.length > 0 && (
        <div className="gs-items">
          {listed.map((item) => (
            <Item key={item.key} item={item} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}

interface Props {
  colorOf: (repoPath: string) => RepoColor;
  /** A chat on the canvas: fly to it. */
  onFocus: (chatId: string) => void;
  /** Any other chat: open it in its repo. */
  onOpenChat: (repoPath: string, chatId: string) => void;
  /** Whether a chat is on the canvas. */
  onGrid: (chatId: string) => boolean;
}

export function GridSources({ colorOf, onFocus, onOpenChat, onGrid }: Props) {
  const [view, setView] = useState<PipelinesView | null>(null);
  const [releasing, setReleasing] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getPipelines()
        .then((v) => alive && setView(v))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const release = useCallback(async () => {
    setReleasing(true);
    try {
      setView(await api.releasePipelines());
    } catch {
      // The next poll shows whatever happened.
    } finally {
      setReleasing(false);
    }
  }, []);

  if (!view || view.sources.length === 0) return null;
  const readyCount = view.sources.reduce((n, s) => n + s.counts.ready, 0);

  return (
    <aside className="gs-rail">
      <div className="gs-head">
        <div className="gs-sweep">
          <span className="gs-faint">Next sweep</span> {when(view.nextSweep)}
        </div>
        <button
          type="button"
          className="gc-tool-btn gs-release"
          onClick={() => void release()}
          disabled={releasing || readyCount === 0}
          title="Put the ready items on the canvas now"
        >
          Show now
        </button>
      </div>
      <Budget budget={view.budget} />
      {view.sources.map((s) => (
        <Source
          key={s.id}
          source={s}
          color={colorOf(s.repoPath)}
          onOpen={(item) => {
            if (!item.chatId) return;
            if (onGrid(item.chatId)) onFocus(item.chatId);
            else onOpenChat(item.repoPath, item.chatId);
          }}
        />
      ))}
    </aside>
  );
}
