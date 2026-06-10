import { useState } from "react";
import { Globe, Search, ChevronRight, ChevronDown } from "lucide-react";

type WebKind = "fetch" | "search";

interface Props {
  kind: WebKind;
  target: string; // url for fetch, query for search
  result?: { content: string; isError: boolean };
}

export function WebBlock({ kind, target, result }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const Icon = kind === "fetch" ? Globe : Search;
  const label = kind === "fetch" ? "Fetch" : "Web Search";

  if (collapsed) {
    return (
      <div
        className={`tool-visual web-visual collapsed${result?.isError ? " error" : ""}`}
        onClick={() => setCollapsed(false)}
        title="Click to expand"
      >
        <Icon size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">{label}</span>
        <span className="web-target">{target}</span>
        <ChevronRight size={12} className="chevron" />
      </div>
    );
  }

  return (
    <div className={`tool-visual web-visual${result?.isError ? " error" : ""}`}>
      <div className="tool-visual-header" onClick={() => setCollapsed(true)}>
        <Icon size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">{label}</span>
        <span className="web-target">{target}</span>
        <ChevronDown size={12} className="chevron" />
      </div>
      <div className="tool-visual-body">
        {result && result.content && result.content.trim().length > 0 ? (
          <div className="web-results">
            <pre>{result.content}</pre>
          </div>
        ) : result ? (
          <div className="web-empty-state">No results</div>
        ) : null}
      </div>
    </div>
  );
}
