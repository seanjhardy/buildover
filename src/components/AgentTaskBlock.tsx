import { useState } from "react";
import { Bot, ChevronRight, ChevronDown } from "lucide-react";

interface Props {
  description: string;
  prompt?: string;
  subagentType?: string;
  result?: { content: string; isError: boolean };
}

export function AgentTaskBlock({
  description,
  prompt,
  subagentType,
  result,
}: Props) {
  const [collapsed, setCollapsed] = useState(true);

  if (collapsed) {
    return (
      <div
        className={`tool-visual agent-task-visual collapsed${result?.isError ? " error" : ""}`}
        onClick={() => setCollapsed(false)}
        title="Click to expand"
      >
        <Bot size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">Agent</span>
        <span className="agent-task-desc">{description}</span>
        <ChevronRight size={12} className="chevron" />
      </div>
    );
  }

  return (
    <div className={`tool-visual agent-task-visual${result?.isError ? " error" : ""}`}>
      <div className="tool-visual-header" onClick={() => setCollapsed(true)}>
        <Bot size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">Agent</span>
        <span className="agent-task-desc">{description}</span>
        <ChevronDown size={12} className="chevron" />
      </div>
      <div className="tool-visual-body">
        {subagentType && (
          <div className="agent-task-type">{subagentType}</div>
        )}
        {prompt && <div className="agent-task-prompt">{prompt}</div>}
        {result && result.content && (
          <div className="agent-task-result">
            <pre>{result.content}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
