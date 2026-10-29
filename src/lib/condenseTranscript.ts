import type { ChatTurn } from "../hooks/useAgent.js";
import type { ContentBlock } from "../types.js";

/** Every turn MessageList renders as a row (tool_results are folded into the
 *  assistant rows that called them, so they never appear on their own). */
export type RenderedTurn = Exclude<ChatTurn, { kind: "tool_results" }>;

// Tools that put something to the user and block on the answer. The assistant
// prose immediately before one of these is the reasoning behind the question,
// so it stays visible even mid-turn.
const QUESTION_TOOLS = ["ExitPlanMode", "RequestUserAttention", "AskUserQuestion"];

// Presentational tools render as rich content (SVG, table, chart, image) rather than
// as a tool call — their output *is* the message, so it is never activity.
const PRESENTATIONAL_TOOLS = ["RenderSVG", "RenderTable", "RenderChart", "Render3DModel", "ShowImage"];

// MCP exposes tools as `mcp__<server>__<Tool>`, so match the bare name too.
const matchesTool = (name: string, names: string[]): boolean =>
  names.some((n) => name === n || name.endsWith(`__${n}`));

export const isPresentationalTool = (name: string): boolean =>
  matchesTool(name, PRESENTATIONAL_TOOLS);

const isQuestionTool = (name: string): boolean => matchesTool(name, QUESTION_TOOLS);

/** A stretch of collapsed work, or a row that renders as it always has. */
export type CondensedRow =
  | {
      kind: "turn";
      key: string;
      turn: RenderedTurn;
      /** Present when only part of an assistant turn's blocks stay visible. */
      content?: ContentBlock[];
    }
  | {
      kind: "activity";
      key: string;
      /** Tool calls in this stretch — the n in "used n tools". */
      toolCount: number;
      parts: { id: string; content: ContentBlock[] }[];
    };

const hasVisibleText = (turn: RenderedTurn): boolean =>
  turn.kind === "assistant" &&
  turn.content.some((b) => b.type === "text" && b.text.trim().length > 0);

const asksQuestion = (turn: RenderedTurn | undefined): boolean =>
  !!turn &&
  turn.kind === "assistant" &&
  turn.content.some((b) => b.type === "tool_use" && isQuestionTool(b.name));

/**
 * Reduces a transcript to the high-level shape the Master chat reads in:
 * the user's own messages, the closing assistant message of each turn, and any
 * assistant message that leads straight into a question — with everything
 * between them (tool calls, thinking, intermediate chatter) merged into one
 * collapsed "used n tools" row per unbroken stretch.
 *
 * Nothing is dropped: every block lands either on a visible row or inside an
 * activity row's `parts`, so expanding restores the full blow-by-blow.
 */
export function condenseTranscript(turns: RenderedTurn[]): CondensedRow[] {
  // A user message opens a turn; the closing assistant message is the last one
  // carrying prose before the next user message.
  const keepText = new Array<boolean>(turns.length).fill(false);
  let stretchStart = 0;
  const closeStretch = (end: number) => {
    for (let i = end - 1; i >= stretchStart; i--) {
      if (hasVisibleText(turns[i])) {
        keepText[i] = true;
        break;
      }
    }
  };
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].kind === "user") {
      closeStretch(i);
      stretchStart = i + 1;
    }
  }
  closeStretch(turns.length);

  for (let i = 0; i < turns.length; i++) {
    if (!hasVisibleText(turns[i])) continue;
    if (asksQuestion(turns[i]) || asksQuestion(turns[i + 1])) keepText[i] = true;
  }

  const rows: CondensedRow[] = [];
  let pending: Extract<CondensedRow, { kind: "activity" }> | null = null;

  const flush = () => {
    if (pending && pending.parts.length > 0) rows.push(pending);
    pending = null;
  };
  const collapse = (id: string, block: ContentBlock) => {
    if (!pending) pending = { kind: "activity", key: `act-${id}`, toolCount: 0, parts: [] };
    const last = pending.parts[pending.parts.length - 1];
    if (last && last.id === id) last.content.push(block);
    else pending.parts.push({ id, content: [block] });
    if (block.type === "tool_use") pending.toolCount++;
  };

  turns.forEach((turn, index) => {
    if (turn.kind !== "assistant") {
      // User messages and result lines are already high-level, one-line rows.
      flush();
      rows.push({ kind: "turn", key: turn.id, turn });
      return;
    }
    // Walk the blocks in order so collapsed work never jumps ahead of the
    // prose it came after.
    let visible: ContentBlock[] = [];
    let segment = 0;
    const flushVisible = () => {
      if (visible.length === 0) return;
      rows.push({
        kind: "turn",
        key: `${turn.id}-v${segment++}`,
        turn,
        content: visible,
      });
      visible = [];
    };
    for (const block of turn.content) {
      const isVisible =
        (block.type === "text" && keepText[index] && block.text.trim().length > 0) ||
        (block.type === "tool_use" && isPresentationalTool(block.name));
      if (isVisible) {
        flush();
        visible.push(block);
      } else {
        flushVisible();
        collapse(turn.id, block);
      }
    }
    flushVisible();
  });
  flush();
  return rows;
}

/** The label on a collapsed row. Thinking-only stretches have no tools to count. */
export function activityLabel(toolCount: number): string {
  if (toolCount === 0) return "thinking";
  return `used ${toolCount} tool${toolCount === 1 ? "" : "s"}`;
}
