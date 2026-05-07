import { useState } from "react";

interface Props {
  name: string;
  input: unknown;
  result?: { content: string; isError: boolean };
}

// Builds a one-line summary from the tool name and input. Mirrors the way
// the VS Code extension shows e.g. "Read README.md" or "Bash · npm test".
function summarize(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  switch (name) {
    case "Read":
      return String(i.file_path ?? "");
    case "Write":
      return String(i.file_path ?? "");
    case "Edit":
      return String(i.file_path ?? "");
    case "Bash":
      return String(i.command ?? "");
    case "Glob":
      return String(i.pattern ?? "");
    case "Grep":
      return String(i.pattern ?? "");
    case "WebFetch":
      return String(i.url ?? "");
    case "WebSearch":
      return String(i.query ?? "");
    case "Task":
    case "Agent":
      return String(i.description ?? i.prompt ?? "");
    default:
      try {
        return JSON.stringify(input).slice(0, 120);
      } catch {
        return "";
      }
  }
}

export function ToolUseBlock({ name, input, result }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const summary = summarize(name, input);
  const status = result ? (result.isError ? "error" : "done") : "running";
  return (
    <div
      className={`tool ${collapsed ? "collapsed" : ""} ${
        result?.isError ? "error" : ""
      }`}
    >
      <div className="tool-header" onClick={() => setCollapsed((c) => !c)}>
        <span className="chevron">▾</span>
        <span className="tool-name">{name}</span>
        <span className="tool-summary">{summary}</span>
        <span className="tool-status">{status}</span>
      </div>
      <div className="tool-body input">
        {typeof input === "string"
          ? input
          : JSON.stringify(input, null, 2)}
      </div>
      {result && (
        <div className="tool-body">{result.content || "(no output)"}</div>
      )}
    </div>
  );
}
