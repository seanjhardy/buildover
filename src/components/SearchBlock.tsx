import { useState } from "react";
import { Search, FolderSearch, ChevronRight, ChevronDown } from "lucide-react";

type SearchKind = "grep" | "glob";

interface Props {
  kind: SearchKind;
  pattern: string;
  result?: { content: string; isError: boolean };
}

export function SearchBlock({ kind, pattern, result }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const Icon = kind === "glob" ? FolderSearch : Search;
  const label = kind === "glob" ? "Glob" : "Grep";

  if (collapsed) {
    return (
      <div
        className={`tool-visual search-visual collapsed${result?.isError ? " error" : ""}`}
        onClick={() => setCollapsed(false)}
        title="Click to expand"
      >
        <Icon size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">{label}</span>
        <span className="search-pattern">{pattern}</span>
        <ChevronRight size={12} className="chevron" />
      </div>
    );
  }

  return (
    <div className={`tool-visual search-visual${result?.isError ? " error" : ""}`}>
      <div className="tool-visual-header" onClick={() => setCollapsed(true)}>
        <Icon size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">{label}</span>
        <span className="search-pattern">{pattern}</span>
        <ChevronDown size={12} className="chevron" />
      </div>
      <div className="tool-visual-body">
        {result && result.content && result.content.trim().length > 0 ? (
          <div className="search-results">
            <pre>{result.content}</pre>
          </div>
        ) : result ? (
          <div className="search-empty-state">No matches found</div>
        ) : null}
      </div>
    </div>
  );
}
