import type { ChatStatus } from "../types.js";

interface Props {
  status: ChatStatus;
}

export function StatusIcon({ status }: Props) {
  switch (status) {
    case "awaiting_input":
      return (
        <span className="chat-status-icon awaiting" title="Needs your input">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 3v-3H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
          </svg>
        </span>
      );
    case "running":
      return (
        <span className="chat-status-icon running" title="Running">
          <svg
            className="spin"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M14 8a6 6 0 1 1-2-4.47" strokeLinecap="round" />
          </svg>
        </span>
      );
    case "agent_done":
      return (
        <span className="chat-status-icon done" title="Agent finished">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 8.5l3 3 7-7" />
          </svg>
        </span>
      );
    case "finished":
      return (
        <span className="chat-status-icon finished" title="Archived">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 4h12v2H2zM3 7h10v6H3z" />
          </svg>
        </span>
      );
    case "idle":
    default:
      return (
        <span className="chat-status-icon idle" title="Idle">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="8" cy="8" r="5" />
          </svg>
        </span>
      );
  }
}
