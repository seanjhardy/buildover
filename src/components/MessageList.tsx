import { useEffect, useMemo, useRef } from "react";
import type { ChatTurn } from "../hooks/useAgent.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { UserMessage } from "./UserMessage.js";

interface Props {
  turns: ChatTurn[];
  isStreaming: boolean;
}

export function MessageList({ turns, isStreaming }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Build a global tool_use_id → result map by walking all tool_results turns.
  // The agent loop emits tool results in their own user turn; we splice them
  // back into the assistant cards visually so each tool shows its own output.
  const toolResults = useMemo(() => {
    const map: Record<string, { content: string; isError: boolean }> = {};
    for (const turn of turns) {
      if (turn.kind !== "tool_results") continue;
      for (const block of turn.content) {
        if (block.type === "tool_result") {
          map[block.tool_use_id] = {
            content: block.content,
            isError: Boolean(block.is_error),
          };
        }
      }
    }
    return map;
  }, [turns]);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [turns]);

  if (turns.length === 0) {
    return (
      <div className="message-list" ref={ref}>
        <div className="message-list-empty">
          <p>Let's a build!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={ref}>
      {turns.map((turn) => {
        if (turn.kind === "user") {
          return (
            <UserMessage
              key={turn.id}
              text={turn.text}
              attachments={turn.attachments}
            />
          );
        }
        if (turn.kind === "assistant") {
          return (
            <AssistantMessage
              key={turn.id}
              content={turn.content}
              toolResults={toolResults}
            />
          );
        }
        if (turn.kind === "result") {
          const cost =
            typeof turn.totalCostUsd === "number"
              ? `$${turn.totalCostUsd.toFixed(4)}`
              : "—";
          return (
            <div key={turn.id} className="result-line">
              {turn.subtype} · {turn.numTurns} turns ·{" "}
              {(turn.durationMs / 1000).toFixed(1)}s · {cost}
            </div>
          );
        }
        return null;
      })}
      {isStreaming && (
        <div className="thinking-pulse" aria-label="thinking">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}
