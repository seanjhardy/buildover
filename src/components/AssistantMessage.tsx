import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ContentBlock } from "../types.js";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { ToolUseBlock } from "./ToolUseBlock.js";
import { ToolGroup } from "./ToolGroup.js";

// Runs of 3+ consecutive tool_use blocks are collapsed under a single
// "N tools called" header. Smaller runs render inline as before.
const TOOL_GROUP_THRESHOLD = 3;

interface Props {
  content: ContentBlock[];
  // Map of tool_use_id → tool result, threaded in from the parent so the
  // tool card can show its own output.
  toolResults: Record<string, { content: string; isError: boolean }>;
  cwd?: string;
}

// A virtual "row" produced by groupContent — either a single content block,
// or a group of consecutive tool_use blocks meant to be rendered together.
type Row =
  | { kind: "block"; block: ContentBlock; key: string }
  | {
      kind: "tool-group";
      tools: Extract<ContentBlock, { type: "tool_use" }>[];
      key: string;
    };

// Presentational tools render inline as rich content (SVG, table, chart).
// Their "tool call" is just the transport for data. They must never get
// folded into a "N tools called" group and always render as standalone blocks.
function isPresentationalTool(name: string): boolean {
  return (
    name === "RenderSVG" || name.endsWith("__RenderSVG") ||
    name === "RenderTable" || name.endsWith("__RenderTable") ||
    name === "RenderChart" || name.endsWith("__RenderChart")
  );
}

// Walks the content array and packs consecutive tool_use blocks into groups.
// Presentational tools (e.g. RenderSVG) break the run so they always render
// as standalone blocks.
function groupContent(content: ContentBlock[]): Row[] {
  const rows: Row[] = [];
  let i = 0;
  while (i < content.length) {
    const block = content[i];
    if (
      block.type === "tool_use" &&
      !isPresentationalTool(block.name)
    ) {
      // Greedily consume the run of consecutive groupable tool_use blocks.
      const run: Extract<ContentBlock, { type: "tool_use" }>[] = [];
      let j = i;
      while (
        j < content.length &&
        content[j].type === "tool_use" &&
        !isPresentationalTool(
          (content[j] as Extract<ContentBlock, { type: "tool_use" }>).name,
        )
      ) {
        run.push(content[j] as Extract<ContentBlock, { type: "tool_use" }>);
        j++;
      }
      if (run.length >= TOOL_GROUP_THRESHOLD) {
        rows.push({ kind: "tool-group", tools: run, key: `tg-${run[0].id}` });
      } else {
        for (const t of run) {
          rows.push({ kind: "block", block: t, key: t.id });
        }
      }
      i = j;
      continue;
    }
    rows.push({ kind: "block", block, key: `b-${i}` });
    i++;
  }
  return rows;
}

function AssistantMessageInner({ content, toolResults, cwd }: Props) {
  const rows = groupContent(content);
  return (
    <div className="message assistant">
      {rows.map((row) => {
        if (row.kind === "tool-group") {
          return (
            <ToolGroup
              key={row.key}
              tools={row.tools}
              toolResults={toolResults}
              cwd={cwd}
            />
          );
        }
        const block = row.block;
        if (block.type === "text") {
          return (
            <div key={row.key} className="assistant-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {block.text}
              </ReactMarkdown>
            </div>
          );
        }
        if (block.type === "thinking") {
          // Older chats (and redacted-thinking edge cases) can carry an empty
          // thinking string — don't render a dropdown that expands to nothing.
          if (!block.thinking.trim()) return null;
          return <ThinkingBlock key={row.key} thinking={block.thinking} />;
        }
        if (block.type === "tool_use") {
          return (
            <ToolUseBlock
              key={row.key}
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
