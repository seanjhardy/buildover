import { useState } from "react";
import type { ContentBlock } from "../types.js";
import { ToolUseBlock } from "./ToolUseBlock.js";

interface Props {
  tools: Extract<ContentBlock, { type: "tool_use" }>[];
  toolResults: Record<string, { content: string; isError: boolean }>;
  cwd?: string;
}

// Renders a run of consecutive tool_use blocks. When there are several, the
// whole group is collapsed under a single "N tools called" header so long
// chains of bash/read/edit calls don't dominate the chat. Click the header
// to expand and see each individual tool card (which can then be expanded
// further for input/output).
export function ToolGroup({ tools, toolResults, cwd }: Props) {
  const [collapsed, setCollapsed] = useState(true);

  const errorCount = tools.filter(
    (t) => toolResults[t.id]?.isError === true,
  ).length;
  const runningCount = tools.filter((t) => !toolResults[t.id]).length;

  let status = "done";
  if (runningCount > 0) status = "running";
  else if (errorCount > 0) status = "error";

  return (
    <div className={`tool-group${collapsed ? " collapsed" : ""}`}>
      <div
        className="tool-group-header"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="chevron">▾</span>
        <span className="tool-group-label">
          {tools.length} tools called
          {errorCount > 0 ? ` · ${errorCount} error${errorCount > 1 ? "s" : ""}` : ""}
        </span>
        <span className={`tool-group-status ${status}`}>{status}</span>
      </div>
      {!collapsed && (
        <div className="tool-group-body">
          {tools.map((t) => (
            <ToolUseBlock
              key={t.id}
              name={t.name}
              input={t.input}
              result={toolResults[t.id]}
              cwd={cwd}
            />
          ))}
        </div>
      )}
    </div>
  );
}
