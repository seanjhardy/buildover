import { memo, useEffect, useState } from "react";
import { CircleAlert, Play, Workflow } from "lucide-react";
import { api } from "../lib/api.js";
import { openExternalUrl } from "../lib/openExternalUrl.js";
import type { PipelineSourceView, PipelinesView } from "../types.js";
import "../styles/grid-pipelines.css";

// A pipeline as a window on the canvas, among the chats. It says what the
// source is doing and what's lined up; anything it has started is a chat
// window of its own beside it. What it costs shows on hover.

/** Position key of a pipeline's window on the canvas. */
export const pipelineCardId = (sourceId: string) => `pipeline:${sourceId}`;

const LINED_UP_SHOWN = 8;

const money = (usd: number) => `$${usd < 10 ? usd.toFixed(2) : Math.round(usd)}`;

function when(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function SignIn({ servers, onSignedIn }: { servers: string[]; onSignedIn: () => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const server = servers[0];

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(async () => {
      try {
        const r = await api.getMcpAuthState(pending);
        if (r.state === "connected") {
          setPending(null);
          onSignedIn();
        } else if (r.state === "failed") {
          setPending(null);
          setError(r.error ?? "Sign-in didn't work");
        }
      } catch {
        /* try again next time */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [pending, onSignedIn]);

  const start = async () => {
    setError(undefined);
    setPending(server);
    try {
      const r = await api.startMcpAuth(server);
      if (r.connected) {
        setPending(null);
        onSignedIn();
      } else if (r.authUrl) openExternalUrl(r.authUrl);
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="gp-signin">
      <p>It can't read {servers.join(" or ")} until you sign in.</p>
      <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={!!pending}>
        {pending ? "Waiting for sign-in…" : `Sign in to ${server}`}
      </button>
      {error && <div className="gp-error">{error}</div>}
    </div>
  );
}

interface Props {
  source: PipelineSourceView;
  budget: PipelinesView["budget"];
  c: number;
  r: number;
  sideClass: string;
  repoHue: number;
  repoTone: number;
  focused: boolean;
  selected: boolean;
  onRun: (sourceId: string) => void;
  /** Fly to a chat it started. */
  onFocusChat: (chatId: string) => void;
}

export const GridPipelineCard = memo(function GridPipelineCard({
  source,
  budget,
  c,
  r,
  sideClass,
  repoHue,
  repoTone,
  focused,
  selected,
  onRun,
  onFocusChat,
}: Props) {
  const id = pipelineCardId(source.id);
  const repoName = source.repoPath.split("/").pop() ?? source.repoPath;
  const started = source.items.filter((i) => i.state !== "new" && i.chatId);
  const linedUp = source.items.filter((i) => i.state === "new");
  const busy = source.reading || source.counts.working > 0;

  const status = source.reading
    ? `Reading ${source.name} now…`
    : source.checkedAt
      ? `Read at ${when(source.checkedAt)}, next at ${when(source.nextCheckAt)}`
      : `First read at ${when(source.nextCheckAt)}`;

  const cost = [
    `${money(source.spendUsd)} this week`,
    budget.capUsd === null
      ? `all pipelines ${money(budget.spentUsd)} (budget still being worked out)`
      : `all pipelines ${money(budget.spentUsd)} of ${money(budget.capUsd)}`,
  ].join(" · ");

  return (
    <div
      data-grid-card={id}
      className={`gc-card gc-tinted gp-card${sideClass}${focused ? " gc-card--focused" : selected ? " gc-card--selected" : ""}`}
      style={
        {
          "--repo-hue": repoHue,
          "--repo-tone": repoTone,
          "--c": c,
          "--r": r,
        } as React.CSSProperties
      }
    >
      <div className="gc-head">
        <div className="gc-head-side" />
        <div className="gc-head-title" title={`${source.name} pipeline — ${source.repoPath}`}>
          <span className={`gc-head-status${busy ? " gp-busy" : ""}`}>
            <Workflow size={13} />
          </span>
          <span className="gc-head-name">{source.name}</span>
          <span className="gc-head-repo">
            <span className="gc-head-repo-dot" aria-hidden />
            {repoName}
          </span>
        </div>
        <div className="gc-head-side gc-head-side--end" />
      </div>

      <div className="gc-card-body gp-body">
        <div className="gp-top">
          <span className="gp-status">{status}</span>
          <button
            type="button"
            className="btn btn-primary gp-run"
            onClick={(e) => {
              e.stopPropagation();
              onRun(source.id);
            }}
            disabled={source.reading}
            title="Read it now and start on the best thing it finds"
          >
            <Play size={12} />
            Run now
          </button>
        </div>

        {source.signIn ? (
          <SignIn servers={source.signIn} onSignedIn={() => onRun(source.id)} />
        ) : (
          source.error && (
            <div className="gp-error" title={source.error}>
              <CircleAlert size={13} />
              {source.error}
            </div>
          )
        )}

        {started.length > 0 && (
          <section className="gp-section">
            <h4>On the canvas</h4>
            {started.map((item) => (
              <button
                key={item.key}
                type="button"
                className="gp-item gp-item--link"
                onClick={(e) => {
                  e.stopPropagation();
                  onFocusChat(item.chatId!);
                }}
                title="Go to it"
              >
                {item.urgent && <CircleAlert size={12} className="gp-urgent" />}
                {item.title}
              </button>
            ))}
          </section>
        )}

        {linedUp.length > 0 && (
          <section className="gp-section">
            <h4>Lined up</h4>
            {linedUp.slice(0, LINED_UP_SHOWN).map((item) => (
              <div key={item.key} className="gp-item">
                {item.title}
              </div>
            ))}
            {linedUp.length > LINED_UP_SHOWN && <div className="gp-more">and {linedUp.length - LINED_UP_SHOWN} more</div>}
          </section>
        )}

        {!started.length && !linedUp.length && !source.error && !source.reading && (
          <div className="gp-empty">Nothing new for you here.</div>
        )}
      </div>

      <div className="gp-cost">{cost}</div>

      <div className="gc-label" aria-hidden>
        <span className="gc-label-repo">Pipeline</span>
        <span className="gc-label-title">{source.name}</span>
      </div>
    </div>
  );
});
