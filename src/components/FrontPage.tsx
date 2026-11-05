import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight, Clock } from "lucide-react";
import type { FrontPage as Page, FrontPanel } from "../lib/frontPage.js";
import "../styles/front-page.css";

export type CloseKind = "done" | "not_now" | "not_relevant";

interface Props {
  page: Page;
  /** The big action: send it as the user's message. */
  onAnswer: (label: string) => void;
  /** Any other offered answer: start a message with it for the user to finish. */
  onDraft: (label: string) => void;
}

// A window's front page: the agent's plain-language card, one big action and
// an optional live preview. The chat is on the back (the title bar flips it),
// and the window's own composer stays available on both sides.
export function FrontPage({ page, onAnswer, onDraft }: Props) {
  const [main, ...more] = page.options;
  const preview = [...page.panels].reverse().find((p) => p.format === "url");
  const panels = page.panels.filter((p) => p !== preview);

  return (
    <div className="front-page">
      <header className="front-page-head">
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
            <button className="btn btn-primary front-page-action" title={main.detail} onClick={() => onAnswer(main.label)}>
              {main.label}
            </button>
            {more.map((o) => (
              <button key={o.label} className="btn front-page-option" title={o.detail} onClick={() => onDraft(o.label)}>
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
