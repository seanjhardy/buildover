import { useState } from "react";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { StatusIcon } from "./StatusIcon.js";
import type { SubagentEntry } from "../hooks/useSubagents.js";

interface Props {
  subagents: SubagentEntry[];
  /** Open a chat-backed subagent (coordinator-spawned). Transcript-derived
   *  agents have no chat to open and render as static rows. */
  onSelectChat: (chatId: string) => void;
  /** When true, renders as a narrow icon strip (same style as the jump bar) */
  compact?: boolean;
}

/** Full panel — shown when there is enough horizontal space */
function FullPanel({ subagents, onSelectChat }: { subagents: SubagentEntry[]; onSelectChat: (chatId: string) => void }) {
  const [collapsed, setCollapsed] = useState(false);

  const runningCount = subagents.filter(
    (s) => s.status === "running" || s.status === "queued",
  ).length;

  return (
    <div className="subagents-panel">
      <div
        className="subagents-panel-header"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? "Expand agents" : "Collapse agents"}
      >
        <div className="subagents-panel-header-left">
          <Bot size={12} />
          <span>Agents</span>
        </div>
        <span className="subagents-panel-header-right">
          {collapsed ? (
            <span className="subagents-panel-count">{subagents.length}</span>
          ) : runningCount > 0 ? (
            <span className="subagents-panel-running">{runningCount} running</span>
          ) : null}
          <span className="subagents-panel-chevron">
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
        </span>
      </div>
      {!collapsed && (
        <div className="subagents-list">
          {subagents.map((agent) => {
            const clickable = agent.chatId != null;
            return (
              <button
                key={agent.id}
                type="button"
                className={`subagent-item${clickable ? " subagent-item--clickable" : ""}`}
                onClick={
                  clickable ? () => onSelectChat(agent.chatId!) : undefined
                }
                title={agent.label}
                disabled={!clickable}
              >
                <StatusIcon status={agent.status} />
                {agent.subagentType && (
                  <span className="subagent-item-type">{agent.subagentType}</span>
                )}
                <span className="subagent-item-label">{agent.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Icon strip — shown when the window is narrow; sits in the right-rail beside the jump bar */
function IconStrip({ subagents, onSelectChat }: { subagents: SubagentEntry[]; onSelectChat: (chatId: string) => void }) {
  return (
    <div className="subagents-icon-strip">
      {subagents.map((agent) => {
        const clickable = agent.chatId != null;
        return (
          <button
            key={agent.id}
            type="button"
            className={`subagents-strip-item subagents-strip-item--${agent.status}${clickable ? " subagents-strip-item--clickable" : ""}`}
            onClick={clickable ? () => onSelectChat(agent.chatId!) : undefined}
            disabled={!clickable}
          >
            <StatusIcon status={agent.status} />
            <div className="subagents-strip-tooltip">
              {agent.subagentType && <span className="subagents-strip-tooltip-type">{agent.subagentType}</span>}
              {agent.label}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function SubagentsPanel({ subagents, onSelectChat, compact }: Props) {
  if (subagents.length === 0) return null;
  return compact ? <IconStrip subagents={subagents} onSelectChat={onSelectChat} /> : <FullPanel subagents={subagents} onSelectChat={onSelectChat} />;
}
