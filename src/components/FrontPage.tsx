import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight, Clock, MessageSquare } from "lucide-react";
import type { FrontPage as Page, FrontPanel } from "../lib/frontPage.js";
import "../styles/front-page.css";

export type CloseKind = "done" | "not_now" | "not_relevant";

interface Props {
  page: Page;
  /** Send one of the agent's offered answers as the user's message. */
  onAnswer: (label: string) => void;
  onClose: (kind: CloseKind) => void;
  /** Turn the window over to the chat. */
  onFlip: () => void;
}

// A window's front page: the agent's plain-language card, one big action, an
// optional live preview, and the close buttons. The chat is on the back.
export function FrontPage({ page, onAnswer, onClose, onFlip }: Props) {
  const [main, ...more] = page.options;
  const preview = [...page.panels].reverse().find((p) => p.format === "url");
  const panels = page.panels.filter((p) => p !== preview);

  return (
    <div className="front-page">
      <header className="front-page-head">
        {page.tags.length > 0 && (
          <div className="front-page-tags">
            {page.tags.map((t) => (
              <span key={t} className="front-page-tag">{t}</span>
            ))}
          </div>
        )}
        {page.title && <h2 className="front-page-title">{page.title}</h2>}
        {page.summary && <p className="front-page-summary">{page.summary}</p>}
      </header>

      <div className="front-page-body">
        {page.issues.map((text) => (
          <blockquote key={text} className="front-page-issue">{text}</blockquote>
        ))}
        {page.context && <p className="front-page-context">{page.context}</p>}
        {page.state && <p className="front-page-state">{page.state}</p>}
        {page.waiting && (
          <p className="front-page-waiting">
            <Clock size={13} /> Waiting: {page.waiting.note}
          </p>
        )}

        {main && (
          <div className="front-page-actions">
            <button className="front-page-action" title={main.detail} onClick={() => onAnswer(main.label)}>
              {main.label}
            </button>
            {more.map((o) => (
              <button key={o.label} className="front-page-option" title={o.detail} onClick={() => onAnswer(o.label)}>
                {o.label}
              </button>
            ))}
          </div>
        )}

        {preview && (
          <div className="front-page-preview">
            <iframe src={preview.content} title={preview.title ?? "Preview"} />
          </div>
        )}

        {panels.map((p) => (
          <PanelSection key={p.key} panel={p} />
        ))}
      </div>

      <footer className="front-page-foot">
        <button onClick={() => onClose("done")}>Done</button>
        <button onClick={() => onClose("not_now")}>Not now</button>
        <button onClick={() => onClose("not_relevant")}>Not relevant</button>
        <button className="front-page-flip" onClick={onFlip} title="Show the chat">
          <MessageSquare size={13} /> Chat
        </button>
      </footer>
    </div>
  );
}

function PanelSection({ panel }: { panel: FrontPanel }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`front-page-panel${open ? " open" : ""}`}>
      <button className="front-page-panel-head" onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className="front-page-chevron" />
        {panel.title ?? panel.key}
      </button>
      {open &&
        (panel.format === "html" ? (
          <iframe className="front-page-html" sandbox="allow-scripts" srcDoc={panel.content} title={panel.title ?? panel.key} />
        ) : panel.format === "url" ? (
          <iframe className="front-page-html" src={panel.content} title={panel.title ?? panel.key} />
        ) : (
          <div className="front-page-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{panel.content}</ReactMarkdown>
          </div>
        ))}
    </section>
  );
}
