import { SvgBlock } from "./SvgBlock.js";
import { TableBlock } from "./TableBlock.js";
import { ChartBlock } from "./ChartBlock.js";
import type { ChartDataset } from "./ChartBlock.js";
import { AskUserQuestionBlock } from "./AskUserQuestionBlock.js";
import { FileOperationBlock } from "./FileOperationBlock.js";
import { BashCommandBlock } from "./BashCommandBlock.js";
import { SearchBlock } from "./SearchBlock.js";
import { AgentTaskBlock } from "./AgentTaskBlock.js";
import { WebBlock } from "./WebBlock.js";
import { AttentionBlock } from "./AttentionBlock.js";
import { GenericToolBlock } from "./GenericToolBlock.js";

interface Props {
  name: string;
  input: unknown;
  result?: { content: string; isError: boolean };
  cwd?: string;
}

// Returns the presentational type for tools that render inline as rich
// content instead of the standard collapsed/expanded tool card. Handles
// both the bare name and the MCP-prefixed form (`mcp__<server>__<tool>`).
type PresentationalType = "svg" | "table" | "chart";
function getPresentationalType(name: string): PresentationalType | null {
  if (name === "RenderSVG" || name.endsWith("__RenderSVG")) return "svg";
  if (name === "RenderTable" || name.endsWith("__RenderTable")) return "table";
  if (name === "RenderChart" || name.endsWith("__RenderChart")) return "chart";
  return null;
}

export function ToolUseBlock({ name, input, result, cwd }: Props) {
  // Presentational tools render inline as rich content; the tool call is
  // just the transport mechanism for the data.
  const presentational = getPresentationalType(name);
  if (presentational && input && typeof input === "object") {
    const i = input as Record<string, unknown>;

    if (presentational === "svg") {
      const svg = typeof i.svg === "string" ? i.svg : "";
      if (svg) {
        return (
          <SvgBlock
            svg={svg}
            title={typeof i.title === "string" ? i.title : undefined}
            caption={typeof i.caption === "string" ? i.caption : undefined}
          />
        );
      }
    }

    if (presentational === "table") {
      const headers = Array.isArray(i.headers)
        ? (i.headers as unknown[]).map(String)
        : [];
      const rows = Array.isArray(i.rows)
        ? (i.rows as unknown[]).map((row) =>
            Array.isArray(row) ? (row as unknown[]).map(String) : [],
          )
        : [];
      return (
        <TableBlock
          headers={headers}
          rows={rows}
          title={typeof i.title === "string" ? i.title : undefined}
          caption={typeof i.caption === "string" ? i.caption : undefined}
        />
      );
    }

    if (presentational === "chart") {
      const type = i.type === "bar" || i.type === "line" || i.type === "pie"
        ? i.type
        : "bar";
      const labels = Array.isArray(i.labels)
        ? (i.labels as unknown[]).map(String)
        : [];
      const datasets: ChartDataset[] = Array.isArray(i.datasets)
        ? (i.datasets as unknown[]).map((ds) => {
            const d = ds as Record<string, unknown>;
            return {
              label: typeof d.label === "string" ? d.label : "",
              values: Array.isArray(d.values)
                ? (d.values as unknown[]).map(Number)
                : [],
              color: typeof d.color === "string" ? d.color : undefined,
            };
          })
        : [];
      return (
        <ChartBlock
          type={type}
          labels={labels}
          datasets={datasets}
          title={typeof i.title === "string" ? i.title : undefined}
          caption={typeof i.caption === "string" ? i.caption : undefined}
        />
      );
    }
  }

  // Enhanced visual rendering for common tools
  if (input && typeof input === "object") {
    const i = input as Record<string, unknown>;

    // AskUserQuestion - show questions and answers
    if (name === "AskUserQuestion") {
      return <AskUserQuestionBlock input={i} result={result} />;
    }

    // Attention prompts
    if (
      name === "RequestUserAttention" ||
      name === "mcp__buildover-custom-tools__RequestUserAttention"
    ) {
      return (
        <AttentionBlock
          message={String(i.message ?? "Attention needed")}
          summary={i.summary ? String(i.summary) : undefined}
        />
      );
    }

    // File operations - Read, Write, Edit
    if (name === "Read" && i.file_path) {
      return (
        <FileOperationBlock
          operation="read"
          filePath={String(i.file_path)}
          result={result}
          cwd={cwd}
        />
      );
    }

    if (name === "Write" && i.file_path) {
      return (
        <FileOperationBlock
          operation="write"
          filePath={String(i.file_path)}
          content={typeof i.content === "string" ? i.content : undefined}
          result={result}
          cwd={cwd}
        />
      );
    }

    if (name === "Edit" && i.file_path) {
      return (
        <FileOperationBlock
          operation="edit"
          filePath={String(i.file_path)}
          oldString={typeof i.old_string === "string" ? i.old_string : undefined}
          newString={typeof i.new_string === "string" ? i.new_string : undefined}
          result={result}
          cwd={cwd}
        />
      );
    }

    // Bash commands
    if (name === "Bash" && i.command) {
      return (
        <BashCommandBlock
          command={String(i.command)}
          description={i.description ? String(i.description) : undefined}
          result={result}
        />
      );
    }

    // Search tools
    if (name === "Grep" && i.pattern) {
      return (
        <SearchBlock kind="grep" pattern={String(i.pattern)} result={result} />
      );
    }

    if (name === "Glob" && i.pattern) {
      return (
        <SearchBlock kind="glob" pattern={String(i.pattern)} result={result} />
      );
    }

    // Web tools
    if (name === "WebFetch" && i.url) {
      return <WebBlock kind="fetch" target={String(i.url)} result={result} />;
    }

    if (name === "WebSearch" && i.query) {
      return <WebBlock kind="search" target={String(i.query)} result={result} />;
    }

    // Agent / Task delegation
    if ((name === "Task" || name === "Agent") && (i.description || i.prompt)) {
      return (
        <AgentTaskBlock
          description={String(i.description ?? "Agent task")}
          prompt={i.prompt ? String(i.prompt) : undefined}
          subagentType={i.subagent_type ? String(i.subagent_type) : undefined}
          result={result}
        />
      );
    }
  }

  // Fallback: generic visual block handles all other tools (MCP, ToolSearch, etc.)
  return <GenericToolBlock name={name} input={input} result={result} />;
}
