import { useState } from "react";
import { Terminal, ChevronRight, ChevronDown } from "lucide-react";

interface Props {
  command: string;
  description?: string;
  result?: { content: string; isError: boolean };
}

export function BashCommandBlock({ command, description, result }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const summary = description || command;
  const status = result ? (result.isError ? "error" : "done") : "running";

  if (collapsed) {
    return (
      <div
        className={`tool-visual bash-visual collapsed${result?.isError ? " error" : ""}`}
        onClick={() => setCollapsed(false)}
        title="Click to expand"
      >
        <Terminal size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">Bash</span>
        <span className="bash-summary">{summary}</span>
        <ChevronRight size={12} className="chevron" />
      </div>
    );
  }

  return (
    <div className={`tool-visual bash-visual${result?.isError ? " error" : ""}`}>
      <div className="tool-visual-header" onClick={() => setCollapsed(true)}>
        <Terminal size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">Bash</span>
        <span className="bash-summary">{summary}</span>
        <ChevronDown size={12} className="chevron" />
      </div>
      <div className="tool-visual-body">
        <pre className="bash-command">$ {command}</pre>
        {result && result.content && result.content.trim().length > 0 ? (
          <pre className={`bash-output${status === "error" ? " error" : ""}`}>
            {result.content}
          </pre>
        ) : result ? (
          <div className="bash-output-empty">(no output)</div>
        ) : null}
      </div>
    </div>
  );
}
