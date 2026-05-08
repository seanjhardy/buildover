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

export function AssistantMessage({ content, toolResults, cwd }: Props) {
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
