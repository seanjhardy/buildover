import { useMemo } from "react";
import type { ChatTurn } from "./useAgent.js";

export interface AgentTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

/**
 * Derives the current agent todo list from the latest `TodoWrite` tool call
 * found in the chat turns. Each `TodoWrite` call replaces the full list, so
 * we only need the most recent one.
 */
export function useTodos(turns: ChatTurn[]): AgentTodo[] {
  return useMemo(() => {
    // Walk turns in reverse to find the latest TodoWrite call
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (turn.kind !== "assistant") continue;
      for (let j = turn.content.length - 1; j >= 0; j--) {
        const block = turn.content[j];
        // The tool is registered through the `buildover-custom-tools` SDK MCP
        // server, so its name in the turn history is fully qualified
        // (`mcp__buildover-custom-tools__TodoWrite`). Match both the bare and
        // prefixed forms, mirroring how RenderSVG/RenderTable/etc. are matched.
        if (
          block.type === "tool_use" &&
          (block.name === "TodoWrite" || block.name.endsWith("__TodoWrite"))
        ) {
          const input = block.input as { todos?: AgentTodo[] };
          if (Array.isArray(input?.todos)) return input.todos;
        }
      }
    }
    return [];
  }, [turns]);
}
