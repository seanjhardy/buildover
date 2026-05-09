import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ContentBlock } from "../types.js";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { ToolUseBlock } from "./ToolUseBlock.js";

interface Props {
  content: ContentBlock[];
  // Map of tool_use_id → tool result, threaded in from the parent so the
  // tool card can show its own output.
  toolResults: Record<string, { content: string; isError: boolean }>;
  cwd?: string;
}

function AssistantMessageInner({ content, toolResults, cwd }: Props) {
  return (
    <div className="message assistant">
      {content.map((block, i) => {
        if (block.type === "text") {
          return (
            <div key={i} className="assistant-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {block.text}
              </ReactMarkdown>
            </div>
          );
        }
        if (block.type === "thinking") {
          return <ThinkingBlock key={i} thinking={block.thinking} />;
        }
        if (block.type === "tool_use") {
          return (
            <ToolUseBlock
              key={block.id}
              name={block.name}
              input={block.input}
              result={toolResults[block.id]}
              cwd={cwd}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

// Custom comparator: skip re-render if content and cwd are unchanged, and the
// tool results relevant to this specific message haven't changed. This prevents
// the expensive ReactMarkdown re-parse on every parent render (e.g. while
// streaming or when the Composer's draft state updates).
//
// Safety: useAgent always appends new turn objects and never mutates existing
// ones, so prev.content !== next.content is a reliable change signal.
function arePropsEqual(prev: Props, next: Props): boolean {
  if (prev.content !== next.content) return false;
  if (prev.cwd !== next.cwd) return false;
  // Only check tool result entries referenced by this message's content.
  const ids = prev.content
    .filter((b) => b.type === "tool_use")
    .map((b) => (b as { id: string }).id);
  for (const id of ids) {
    const p = prev.toolResults[id];
    const n = next.toolResults[id];
    if (p === n) continue;
    if (!p || !n) return false;
    if (p.content !== n.content || p.isError !== n.isError) return false;
  }
  return true;
}

export const AssistantMessage = memo(AssistantMessageInner, arePropsEqual);
