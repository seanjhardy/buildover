import { useMemo } from "react";
import type { ChatTurn } from "./useAgent.js";
import type { AgentTask, ChatStatus } from "../types.js";

export interface SubagentEntry {
  /** Unique key — the tool_use id for transcript agents, chat id for chat-backed ones, task id for other tasks. */
  id: string;
  /** Short human label (the Agent tool's `description`, or the chat's task/title). */
  label: string;
  /** Agent type (e.g. "Explore", "Plan") when known. */
  subagentType?: string;
  /** Mapped onto ChatStatus so the panel can reuse StatusIcon. */
  status: ChatStatus;
  /** Present for subagents that live as real chats — enables click-to-open. */
  chatId?: string;
  /** Live CLI task backing this entry — enables stop / output. */
  task?: AgentTask;
}

function taskStatus(task: AgentTask): ChatStatus {
  switch (task.status) {
    case "running":
      return "running";
    case "completed":
      return "agent_done";
    case "failed":
      return "error";
    case "stopped":
      return "idle";
  }
}

function taskTypeLabel(task: AgentTask): string {
  if (task.subagentType) return task.subagentType;
  if (task.taskType === "local_bash") return "shell";
  if (task.taskType === "local_agent") return "agent";
  return task.taskType.replace(/^local_/, "");
}

/**
 * Derives subagents and shell processes for the chat from two sources:
 *  - `Agent` / `Task` tool calls in the transcript, paired with their
 *    tool_result blocks.
 *  - Live tasks pushed by the server, which are authoritative for anything
 *    they cover. Background agents return a placeholder tool_result straight
 *    away, so without them they'd show as done while still working.
 *
 * Transcript status mapping (when no live task covers the call):
 *  - no result yet + chat is streaming  → "running"
 *  - no result yet + chat idle          → "idle" (interrupted / abandoned)
 *  - result with is_error               → "error"
 *  - result                             → "agent_done"
 *
 * Shell tasks are listed while running, and afterwards only if they ran in the
 * background — finished foreground commands are already in the transcript.
 */
export function useSubagents(
  turns: ChatTurn[],
  isStreaming: boolean,
  tasks: AgentTask[] = [],
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

    for (const task of tasks) {
      const idx = task.toolUseId ? indexById.get(task.toolUseId) : undefined;
      if (idx !== undefined) {
        agents[idx] = { ...agents[idx], status: taskStatus(task), task };
        continue;
      }
      if (task.status !== "running" && !task.background) continue;
      agents.push({
        id: task.id,
        label: task.description || "Task",
        subagentType: taskTypeLabel(task),
        status: taskStatus(task),
        task,
      });
    }

    // Running work first; otherwise keep chronological order.
    const running = agents.filter((a) => a.status === "running");
    const rest = agents.filter((a) => a.status !== "running");
    return [...running, ...rest];
  }, [turns, isStreaming, tasks]);
}
