import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, Info } from "lucide-react";
import type { MessageOrigin } from "../types.js";

interface Props {
  origin: MessageOrigin;
  label?: string;
  text: string;
}

// Renders a message that was injected into the chat by the app or another
// agent (subagent reports, coordinator feedback, plan-panel relays). These are
// deliberately styled as compact, muted system chips so they can never be
// mistaken for something the user typed. Long bodies collapse to a one-line
// preview and expand on click.
export function SystemMessage({ origin, label, text }: Props) {
  const lines = text.split("\n");
  const collapsible = text.length > 240 || lines.length > 3;
  const [open, setOpen] = useState(!collapsible);

  const Icon = origin === "subagent" ? Bot : Info;
  const preview = lines.find((l) => l.trim()) ?? "";

  return (
    <div className={`system-message system-message--${origin}`}>
      <button
        type="button"
        className="system-message-header"
        onClick={() => collapsible && setOpen((v) => !v)}
        disabled={!collapsible}
        title={collapsible ? (open ? "Collapse" : "Expand") : undefined}
      >
        <Icon size={12} className="system-message-icon" />
        <span className="system-message-label">
          {label ?? (origin === "subagent" ? "Subagent" : "System")}
        </span>
        {!open && (
          <span className="system-message-preview">{preview}</span>
        )}
        {collapsible &&
          (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </button>
      {open && <div className="system-message-body">{text}</div>}
    </div>
  );
}
