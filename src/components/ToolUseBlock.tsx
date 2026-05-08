import { useState } from "react";

interface Props {
  name: string;
  input: unknown;
  result?: { content: string; isError: boolean };
  cwd?: string;
}

// Strip the cwd prefix from an absolute path so it shows as a project-relative
// path (e.g. /Users/.../buildover/src/foo.ts → /src/foo.ts).
function relativizePath(path: string, cwd?: string): string {
  if (!cwd || !path.startsWith(cwd)) return path;
  const rest = path.slice(cwd.length);
  return rest.startsWith("/") ? rest : "/" + rest;
}

// Builds a one-line summary from the tool name and input. Mirrors the way
// the VS Code extension shows e.g. "Read README.md" or "Bash · npm test".
function summarize(name: string, input: unknown, cwd?: string): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  switch (name) {
    case "Read":
      return relativizePath(String(i.file_path ?? ""), cwd);
    case "Write":
      return relativizePath(String(i.file_path ?? ""), cwd);
    case "Edit":
      return relativizePath(String(i.file_path ?? ""), cwd);
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

export function ToolUseBlock({ name, input, result, cwd }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const summary = summarize(name, input, cwd);
  const status = result ? (result.isError ? "error" : "done") : "running";

  if (collapsed) {
    return (
      <div
        className={`tool-inline${result?.isError ? " error" : ""}`}
        onClick={() => setCollapsed(false)}
        title="Click to expand"
      >
        <span className="tool-inline-chevron">▸</span>
        <span className="tool-inline-name">{name}</span>
        {summary && <span className="tool-inline-summary">{summary}</span>}
        <span className={`tool-inline-status ${status}`}>{status}</span>
      </div>
    );
  }

  return (
    <div className={`tool${result?.isError ? " error" : ""}`}>
      <div className="tool-header" onClick={() => setCollapsed(true)}>
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
