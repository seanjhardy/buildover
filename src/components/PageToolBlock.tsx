import { PanelTop } from "lucide-react";
import "../styles/front-page.css";

interface Props {
  tool: string;
  input: Record<string, unknown>;
  result?: { content: string; isError: boolean };
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

// One line per front-page tool call (server/pageTools.ts) on the chat side of
// a window: what the agent wrote to the front, not the raw JSON.
function describe(tool: string, i: Record<string, unknown>): [string, string] {
  switch (tool) {
    case "set_card":
      return ["Card", [text(i.title), text(i.summary)].filter(Boolean).join(": ")];
    case "milestone":
      return [i.kind === "issue" ? "Issue" : i.kind === "state" ? "Now" : "Context", text(i.text)];
    case "show_panel":
      return ["Panel", text(i.title) || text(i.key)];
    case "patch_panel":
      return ["Panel edited", text(i.key)];
    case "suggest_options":
      return ["Options", Array.isArray(i.options) ? i.options.map((o) => text((o as { label?: unknown })?.label)).join(" · ") : ""];
    case "wait":
      return ["Waiting", text(i.note)];
    case "done":
      return ["Done", text(i.note)];
    case "remember":
      return ["Remembered", text(i.principle)];
    default:
      return [tool, ""];
  }
}

export function PageToolBlock({ tool, input, result }: Props) {
  const [label, body] = describe(tool, input);
  return (
    <div className={`page-tool-line${result?.isError ? " failed" : ""}`} title={result?.isError ? result.content : undefined}>
      <PanelTop size={12} />
      <span className="page-tool-label">{label}</span>
      <span className="page-tool-text">{body}</span>
    </div>
  );
}
