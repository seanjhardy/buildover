import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Bot, Check, Square } from "lucide-react";
import { StatusIcon } from "./StatusIcon.js";
import { taskDuration, useNow } from "./SubagentsPanel.js";
import type { SubagentEntry } from "../hooks/useSubagents.js";
import type { GridSubagentChat } from "../lib/api.js";
import type { ChatStatus } from "../types.js";

/** Stopped subagents listed under the working ones. */
const RECENT_DONE = 4;

const AT_WORK: ReadonlySet<ChatStatus> = new Set(["running", "queued", "awaiting_input"]);

/** A row in a window's subagent list: an SDK subagent from its transcript
 *  (with its live task, when the CLI reports one), or a chat it spawned. */
type Item = { kind: "task"; entry: SubagentEntry } | { kind: "chat"; chat: GridSubagentChat };

export interface GridSubagentList {
  /** At work first, then the latest few that have stopped. */
  items: Item[];
  /** How many are at work. */
  working: number;
  /** How many of those are waiting on the user. */
  waiting: number;
}

/** Subagents only: shell commands and monitors are tasks too. */
function isAgent(e: SubagentEntry): boolean {
  return !e.task || e.task.taskType.endsWith("agent") || !!e.task.subagentType;
}

/** A window's subagents, from its transcript and live tasks (`entries`) and
 *  the subagent chats it spawned (`chats`). */
export function gridSubagents(entries: SubagentEntry[], chats: GridSubagentChat[] = []): GridSubagentList {
  const agents = entries.filter(isAgent);
  const busyChats = chats.filter((c) => AT_WORK.has(c.status));
  const busyAgents = agents.filter((a) => a.status === "running");
  // The transcript lists them oldest first; the server sends chats newest first.
  const done: Item[] = [
    ...chats.filter((c) => !AT_WORK.has(c.status)).map((chat) => ({ kind: "chat" as const, chat })),
    ...agents
      .filter((a) => a.status !== "running")
      .reverse()
      .map((entry) => ({ kind: "task" as const, entry })),
  ];
  return {
    items: [
      ...busyChats.map((chat) => ({ kind: "chat" as const, chat })),
      ...busyAgents.map((entry) => ({ kind: "task" as const, entry })),
      ...done.slice(0, RECENT_DONE),
    ],
    working: busyChats.length + busyAgents.length,
    waiting: busyChats.filter((c) => c.status === "awaiting_input").length,
  };
}

function countLabel({ working, waiting }: GridSubagentList): string {
  const running = `${working} subagent${working === 1 ? "" : "s"} running`;
  return waiting ? `${running}, ${waiting} waiting for you` : running;
}

/** A window's working subagents: a spinner and a count over the top right of
 *  its transcript, which opens a list of what each one is doing. Only there
 *  while some are at work, or while the list is open. */
export function GridSubagents({
  list,
  focused,
  onStopTask,
  onOpenChat,
}: {
  list: GridSubagentList;
  /** Whether its window is the focused one: the list closes when it isn't. */
  focused: boolean;
  onStopTask: (taskId: string) => void;
  /** Brings a subagent chat onto the grid beside this window. */
  onOpenChat: (chatId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Arrowing away to another window takes the list with it.
  useEffect(() => {
    if (!focused) setOpen(false);
  }, [focused]);

  // A press anywhere else, or Escape, closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Captured, so the grid doesn't also take this Escape to let go of windows.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (list.working === 0 && !open) return null;
  const label = countLabel(list);
  return (
    <div ref={ref} className="gc-agents" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`gc-agents-badge${list.waiting ? " gc-agents-badge--waiting" : ""}${open ? " gc-agents-badge--open" : ""}`}
        aria-label={`${label}: ${open ? "hide" : "show"} what they're doing`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={open ? label : `${label}. Click to see what they're doing.`}
        onClick={() => setOpen((o) => !o)}
      >
        {list.working > list.waiting ? (
          <span className="gc-agents-spinner" aria-hidden />
        ) : list.waiting ? (
          <span className="gc-agents-dot" aria-hidden />
        ) : (
          <Check size={12} className="gc-agents-done" aria-hidden />
        )}
        {list.working}
      </button>
      {open && (
        <SubagentPanel
          list={list}
          onStopTask={onStopTask}
          onOpenChat={(chatId) => {
            setOpen(false);
            onOpenChat(chatId);
          }}
        />
      )}
    </div>
  );
}

function SubagentPanel({
  list,
  onStopTask,
  onOpenChat,
}: {
  list: GridSubagentList;
  onStopTask: (taskId: string) => void;
  onOpenChat: (chatId: string) => void;
}) {
  const now = useNow(list.items.some((i) => i.kind === "task" && i.entry.task?.status === "running"));
  return (
    <div className="gc-agents-panel" role="dialog" aria-label="Subagents">
      <div className="gc-agents-head">
        <Bot size={13} />
        <span className="gc-agents-title">Subagents</span>
        <span className="gc-agents-count">
          {list.working ? `${list.working} running` : "None running"}
          {list.waiting > 0 && ` · ${list.waiting} waiting for you`}
        </span>
      </div>
      <div className="gc-agents-list">
        {list.items.map((item) =>
          item.kind === "chat" ? (
            <ChatRow key={item.chat.id} chat={item.chat} onOpen={onOpenChat} />
          ) : (
            <TaskRow key={item.entry.id} entry={item.entry} now={now} onStop={onStopTask} />
          ),
        )}
      </div>
    </div>
  );
}

function TaskRow({ entry, now, onStop }: { entry: SubagentEntry; now: number; onStop: (taskId: string) => void }) {
  const { task } = entry;
  const running = entry.status === "running";
  const meta = task
    ? [
        running && task.lastToolName ? `Using ${task.lastToolName}` : null,
        task.toolUses ? `${task.toolUses} tool use${task.toolUses === 1 ? "" : "s"}` : null,
        task.totalTokens ? `${Math.round(task.totalTokens / 1000)}k tokens` : null,
        task.background ? "background" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <div className={`gc-agent${running ? "" : " gc-agent--done"}`}>
      <StatusIcon status={entry.status} />
      <span className="gc-agent-main">
        <span className="gc-agent-top">
          <span className="gc-agent-type">{entry.subagentType ?? "agent"}</span>
          <span className="gc-agent-label" title={entry.label}>
            {entry.label}
          </span>
          {task && <span className="gc-agent-time">{taskDuration(task, now)}</span>}
        </span>
        {meta && <span className="gc-agent-meta">{meta}</span>}
        {task?.summary && <span className="gc-agent-summary">{task.summary}</span>}
      </span>
      {task?.status === "running" && (
        <button
          type="button"
          className="gc-agent-stop"
          aria-label={`Stop ${entry.label}`}
          title="Stop this subagent"
          onClick={() => onStop(task.id)}
        >
          <Square size={9} />
        </button>
      )}
    </div>
  );
}

function ChatRow({ chat, onOpen }: { chat: GridSubagentChat; onOpen: (chatId: string) => void }) {
  const label = chat.title || chat.task || "Subagent";
  return (
    <button
      type="button"
      className={`gc-agent gc-agent--chat${AT_WORK.has(chat.status) ? "" : " gc-agent--done"}`}
      title="Open its chat beside this window"
      onClick={() => onOpen(chat.id)}
    >
      <StatusIcon status={chat.status} />
      <span className="gc-agent-main">
        <span className="gc-agent-top">
          <span className="gc-agent-type">chat</span>
          <span className="gc-agent-label">{label}</span>
          {chat.status === "awaiting_input" && <span className="gc-agent-flag">Needs input</span>}
          <ArrowUpRight size={12} className="gc-agent-open" />
        </span>
        {chat.task && chat.task !== label && <span className="gc-agent-summary">{chat.task}</span>}
      </span>
    </button>
  );
}
