import { useState } from "react";
import {
  FileText,
  FilePlus,
  FilePen,
  ChevronRight,
  ChevronDown,
} from "lucide-react";

type Operation = "read" | "write" | "edit";

interface Props {
  operation: Operation;
  filePath: string;
  oldString?: string;
  newString?: string;
  content?: string;
  result?: { content: string; isError: boolean };
  cwd?: string;
}

function relativizePath(path: string, cwd?: string): string {
  if (!cwd || !path.startsWith(cwd)) return path;
  const rest = path.slice(cwd.length);
  return rest.startsWith("/") ? rest : "/" + rest;
}

const OP_META: Record<
  Operation,
  { Icon: typeof FileText; label: string }
> = {
  read: { Icon: FileText, label: "Read" },
  write: { Icon: FilePlus, label: "Wrote" },
  edit: { Icon: FilePen, label: "Edited" },
};

// Renders a git-style inline diff with removed lines (-) then added lines (+).
function InlineDiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  return (
    <div className="inline-diff">
      <div className="diff-lines removed">
        {oldLines.map((line, i) => (
          <div key={`old-${i}`} className="diff-line">
            <span className="diff-marker">-</span>
            <span className="diff-content">{line}</span>
          </div>
        ))}
      </div>
      <div className="diff-lines added">
        {newLines.map((line, i) => (
          <div key={`new-${i}`} className="diff-line">
            <span className="diff-marker">+</span>
            <span className="diff-content">{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FileOperationBlock({
  operation,
  filePath,
  oldString,
  newString,
  content,
  result,
  cwd,
}: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const { Icon, label } = OP_META[operation];
  const relPath = relativizePath(filePath, cwd);

  if (collapsed) {
    return (
      <div
        className={`tool-visual file-op-visual collapsed${result?.isError ? " error" : ""}`}
        onClick={() => setCollapsed(false)}
        title="Click to expand"
      >
        <Icon size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">{label}</span>
        <span className="file-op-path">{relPath}</span>
        <ChevronRight size={12} className="chevron" />
      </div>
    );
  }

  return (
    <div className={`tool-visual file-op-visual${result?.isError ? " error" : ""}`}>
      <div className="tool-visual-header" onClick={() => setCollapsed(true)}>
        <Icon size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">{label}</span>
        <span className="file-op-path">{relPath}</span>
        <ChevronDown size={12} className="chevron" />
      </div>
      <div className="tool-visual-body">
        {operation === "edit" && (oldString !== undefined || newString !== undefined) ? (
          <InlineDiffView oldStr={oldString ?? ""} newStr={newString ?? ""} />
        ) : operation === "write" && content !== undefined ? (
          <pre className="file-op-content">{content}</pre>
        ) : result && result.content ? (
          <pre className="file-op-content">{result.content}</pre>
        ) : (
          <div className="file-op-empty">(no content)</div>
        )}
      </div>
    </div>
  );
}
