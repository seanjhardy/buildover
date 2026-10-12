import { useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Square } from "lucide-react";
import { StatusIcon } from "./StatusIcon.js";
import type { SubagentEntry } from "../hooks/useSubagents.js";
import type { AgentTask } from "../types.js";

export type LoadTaskOutput = (
  taskId: string,
) => Promise<{ output: string; truncated: boolean }>;

interface Props {
  subagents: SubagentEntry[];
  /** Open a chat-backed subagent (coordinator-spawned). Transcript-derived
   *  agents have no chat to open and render as static rows. */
  onSelectChat: (chatId: string) => void;
  /** Stops a running subagent / shell task without touching the main turn. */
  onStopTask: (taskId: string) => void;
  /** Fetches the tail of a task's output file. */
  loadTaskOutput: LoadTaskOutput;
  /** When true, renders as a narrow icon strip (same style as the jump bar) */
  compact?: boolean;
}

// How often an expanded running task's output is re-fetched.
const OUTPUT_POLL_MS = 2_000;

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function taskDuration(task: AgentTask, now: number): string {
  const start = Date.parse(task.startedAt);
  const end = task.endedAt ? Date.parse(task.endedAt) : now;
  return formatElapsed(end - start);
}

// Ticks once a second while `active`, so running rows show a live duration.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function TaskOutput({ task, loadTaskOutput }: { task: AgentTask; loadTaskOutput: LoadTaskOutput }) {
  const [output, setOutput] = useState<{ output: string; truncated: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const running = task.status === "running";

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      loadTaskOutput(task.id)
        .then((r) => {
          if (cancelled) return;
          setOutput(r);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    void load();
    if (!running) return () => { cancelled = true; };
    const id = setInterval(load, OUTPUT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [task.id, running, loadTaskOutput]);

  // Follow the tail as new output arrives.
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output?.output]);

  if (failed && !output) return <div className="subagent-output-empty">Output unavailable</div>;
  if (!output) return <div className="subagent-output-empty">Loading output…</div>;
  if (!output.output.trim()) return <div className="subagent-output-empty">No output yet</div>;
  return (
    <pre ref={preRef} className="subagent-output">
      {output.truncated && <span className="subagent-output-truncated">…earlier output truncated{"\n"}</span>}
      {output.output}
    </pre>
  );
}

function TaskDetails({ task, loadTaskOutput }: { task: AgentTask; loadTaskOutput: LoadTaskOutput }) {
  const meta = [
    task.background ? "background" : "foreground",
    task.lastToolName && task.status === "running" ? `using ${task.lastToolName}` : null,
    task.toolUses ? `${task.toolUses} tool uses` : null,
    task.totalTokens ? `${Math.round(task.totalTokens / 1000)}k tokens` : null,
  ].filter(Boolean);
  return (
    <div className="subagent-details">
      <div className="subagent-details-meta">{meta.join(" · ")}</div>
      {task.summary && <div className="subagent-details-summary">{task.summary}</div>}
      {task.hasOutput && <TaskOutput task={task} loadTaskOutput={loadTaskOutput} />}
    </div>
  );
}

/** Full panel — shown when there is enough horizontal space */
function FullPanel({ subagents, onSelectChat, onStopTask, loadTaskOutput }: Omit<Props, "compact">) {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const runningCount = subagents.filter(
    (s) => s.status === "running" || s.status === "queued",
  ).length;
  const now = useNow(subagents.some((s) => s.task?.status === "running"));

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="subagents-panel">
      <div
        className="subagents-panel-header"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? "Expand agents" : "Collapse agents"}
      >
        <div className="subagents-panel-header-left">
          <Bot size={12} />
          <span>Agents &amp; processes</span>
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
            const task = agent.task;
            const isOpen = task != null && expanded.has(agent.id);
            const onClick =
              agent.chatId != null
                ? () => onSelectChat(agent.chatId!)
                : task
                  ? () => toggleExpanded(agent.id)
                  : undefined;
            return (
              <div key={agent.id} className="subagent-row">
                <div
                  role={onClick ? "button" : undefined}
                  tabIndex={onClick ? 0 : undefined}
                  className={`subagent-item${onClick ? " subagent-item--clickable" : ""}`}
                  onClick={onClick}
                  onKeyDown={
                    onClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onClick();
                          }
                        }
                      : undefined
                  }
                  title={agent.label}
                >
                  <StatusIcon status={agent.status} />
                  {agent.subagentType && (
                    <span className="subagent-item-type">{agent.subagentType}</span>
                  )}
                  <span className="subagent-item-label">{agent.label}</span>
                  {task && (
                    <span className="subagent-item-time">{taskDuration(task, now)}</span>
                  )}
                  {task?.status === "running" && (
                    <button
                      type="button"
                      className="subagent-item-stop"
                      title="Stop this task"
                      aria-label={`Stop ${agent.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onStopTask(task.id);
                      }}
                    >
                      <Square size={9} fill="currentColor" />
                    </button>
                  )}
                </div>
                {isOpen && <TaskDetails task={task} loadTaskOutput={loadTaskOutput} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Icon strip — shown when the window is narrow; sits in the right-rail beside the jump bar */
function IconStrip({ subagents, onSelectChat, onStopTask }: Omit<Props, "compact" | "loadTaskOutput">) {
  return (
    <div className="subagents-icon-strip">
      {subagents.map((agent) => {
        const task = agent.task;
        const stoppable = task?.status === "running";
        const onClick =
          agent.chatId != null
            ? () => onSelectChat(agent.chatId!)
            : stoppable
              ? () => {
                  if (window.confirm(`Stop "${agent.label}"?`)) onStopTask(task!.id);
                }
              : undefined;
        return (
          <button
            key={agent.id}
            type="button"
            className={`subagents-strip-item subagents-strip-item--${agent.status}${onClick ? " subagents-strip-item--clickable" : ""}`}
            onClick={onClick}
            disabled={!onClick}
          >
            <StatusIcon status={agent.status} />
            <div className="subagents-strip-tooltip">
              {agent.subagentType && <span className="subagents-strip-tooltip-type">{agent.subagentType}</span>}
              {agent.label}
              {stoppable && <span className="subagents-strip-tooltip-hint"> — click to stop</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function SubagentsPanel({ compact, subagents, onSelectChat, onStopTask, loadTaskOutput }: Props) {
  if (subagents.length === 0) return null;
  return compact ? (
    <IconStrip subagents={subagents} onSelectChat={onSelectChat} onStopTask={onStopTask} />
  ) : (
    <FullPanel
      subagents={subagents}
      onSelectChat={onSelectChat}
      onStopTask={onStopTask}
      loadTaskOutput={loadTaskOutput}
    />
  );
}
