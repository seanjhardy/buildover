import { useMemo } from "react";
import type { ChatTurn } from "./useAgent.js";
import type { ChatStatus } from "../types.js";

export interface SubagentEntry {
  /** Unique key — the tool_use id for transcript agents, chat id for chat-backed ones. */
  id: string;
  /** Short human label (the Agent tool's `description`, or the chat's task/title). */
  label: string;
  /** Agent type (e.g. "Explore", "Plan") when known. */
  subagentType?: string;
  /** Mapped onto ChatStatus so the panel can reuse StatusIcon. */
  status: ChatStatus;
  /** Present for subagents that live as real chats — enables click-to-open. */
  chatId?: string;
}

/**
 * Derives in-flight and completed subagents from the chat transcript by
 * scanning for `Agent` / `Task` tool calls (the SDK's delegation tools) and
 * pairing them with their tool_result blocks.
 *
 * Status mapping:
 *  - no result yet + chat is streaming  → "running"
 *  - no result yet + chat idle          → "idle" (interrupted / abandoned)
 *  - result with is_error               → "error"
 *  - result                             → "agent_done"
 */
export function useSubagents(
  turns: ChatTurn[],
  isStreaming: boolean,
): SubagentEntry[] {
  return useMemo(() => {
    const agents: SubagentEntry[] = [];
    const indexById = new Map<string, number>();
    const resolved = new Set<string>();

    for (const turn of turns) {
      if (turn.kind === "assistant") {
        for (const block of turn.content) {
          if (block.type !== "tool_use") continue;
          if (block.name !== "Agent" && block.name !== "Task") continue;
          const input = block.input as {
            description?: string;
            prompt?: string;
            subagent_type?: string;
          };
          const label = String(
            input?.description ?? input?.prompt ?? "Agent task",
          );
          indexById.set(block.id, agents.length);
          agents.push({
            id: block.id,
            label,
            subagentType: input?.subagent_type
              ? String(input.subagent_type)
              : undefined,
            status: "running", // provisional — finalised below
          });
        }
      } else if (turn.kind === "tool_results") {
        for (const block of turn.content) {
          if (block.type !== "tool_result") continue;
          const idx = indexById.get(block.tool_use_id);
          if (idx === undefined) continue;
          resolved.add(block.tool_use_id);
          agents[idx] = {
            ...agents[idx],
            status: block.is_error ? "error" : "agent_done",
          };
        }
      }
    }

    // Unresolved tool calls are only "running" while the turn is in flight;
    // otherwise they were interrupted and shown as idle.
    for (let i = 0; i < agents.length; i++) {
      if (!resolved.has(agents[i].id) && !isStreaming) {
        agents[i] = { ...agents[i], status: "idle" };
      }
    }

    return agents;
  }, [turns, isStreaming]);
}
