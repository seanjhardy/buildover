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
    case "queued":
      return (
        <span className="chat-status-icon queued" title="Queued until usage resets">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 2.5h8" />
            <path d="M4 13.5h8" />
            <path d="M5 2.5c0 3.5 6 3.5 6 6s-6 2.5-6 5" />
            <path d="M11 2.5c0 3.5-6 3.5-6 6s6 2.5 6 5" />
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
    case "error":
      return (
        <span className="chat-status-icon error" title="Interrupted — retrying">
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
            <path d="M8 3v5" />
            <circle cx="8" cy="11.5" r="0.75" fill="currentColor" stroke="none" />
            <path d="M7.14 1.5a1 1 0 0 1 1.72 0l5.66 9.8A1 1 0 0 1 13.66 13H2.34a1 1 0 0 1-.86-1.5z" />
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
