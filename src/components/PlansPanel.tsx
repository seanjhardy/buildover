import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PlanTicket, PlanTicketStatus } from "../types.js";

interface Props {
  tickets: PlanTicket[];
  /** Open the ticket in the right-side detail pane. */
  onOpen: (ticket: PlanTicket) => void;
  /** Id of the ticket currently open in the detail pane (highlighted). */
  activePlanId?: string | null;
  /** When true, renders as a narrow icon strip (same style as the jump bar) */
  compact?: boolean;
}

const STATUS_LABEL: Record<PlanTicketStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  in_progress: "In progress",
  agent_done: "Ready for review",
  done: "Done",
  rejected: "Rejected",
};

function statusIcon(status: PlanTicketStatus): string {
  if (status === "draft") return "○";
  if (status === "approved") return "◎";
  if (status === "in_progress") return "★";
  if (status === "agent_done") return "✓";
  if (status === "done") return "☑";
  if (status === "rejected") return "✗";
  return "○";
}

// The plan board shown beside the coordinator chat. Tickets are ordered by
// priority; clicking a card opens it in the right-side PlanViewer where the
// user approves drafts, signs off agent-finished work, reorders, or messages
// the agent working on the plan. Closed tickets (done/rejected) are tucked
// behind a collapsed toggle so the board only shows live work by default.

/** Full panel — shown when there is enough horizontal space */
function FullPanel({ tickets, onOpen, activePlanId }: { tickets: PlanTicket[]; onOpen: (ticket: PlanTicket) => void; activePlanId?: string | null }) {
  const [showClosed, setShowClosed] = useState(false);

  const isClosed = (t: PlanTicket) =>
    t.status === "done" || t.status === "rejected";
  const open = tickets.filter((t) => !isClosed(t));
  const closed = tickets.filter(isClosed);

  const renderTicket = (t: PlanTicket, label: string) => {
    const isActive = activePlanId === t.id;
    return (
      <div
        key={t.id}
        className={`plan-ticket plan-ticket--${t.status}${isClosed(t) ? " plan-ticket--closed" : ""}${isActive ? " plan-ticket--active" : ""}`}
      >
        <button
          type="button"
          className="plan-ticket-main"
          onClick={() => onOpen(t)}
          title="Open plan"
        >
          <span className="plan-ticket-order">{label}</span>
          <span className="plan-ticket-title">{t.title}</span>
          <span className={`plan-ticket-chip plan-ticket-chip--${t.status}`}>
            {t.status === "in_progress" && (
              <span className="plan-working-dot" aria-hidden="true" />
            )}
            {STATUS_LABEL[t.status]}
          </span>
          <ChevronRight size={14} className="plan-ticket-open-chevron" />
        </button>
      </div>
    );
  };

  return (
    <div className="plans-panel">
      <div className="plans-panel-header">Plans</div>
      <div className="plans-panel-list">
        {open.map((t, i) => renderTicket(t, String(i + 1)))}
        {open.length === 0 && (
          <div className="plans-panel-empty">No open plans.</div>
        )}
        {closed.length > 0 && (
          <>
            <button
              type="button"
              className="plans-panel-closed-toggle"
              onClick={() => setShowClosed((v) => !v)}
            >
              {showClosed ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
              {closed.length} closed
            </button>
            {showClosed && closed.map((t) => renderTicket(t, "·"))}
          </>
        )}
      </div>
    </div>
  );
}

/** Icon strip — shown when the window is narrow; sits in the right-rail beside the jump bar */
function IconStrip({ tickets, onOpen }: { tickets: PlanTicket[]; onOpen: (ticket: PlanTicket) => void }) {
  const isClosed = (t: PlanTicket) =>
    t.status === "done" || t.status === "rejected";
  // Only show open tickets in compact mode
  const openTickets = tickets.filter((t) => !isClosed(t));

  if (openTickets.length === 0) return null;

  return (
    <div className="plans-icon-strip">
      {openTickets.map((ticket) => (
        <button
          key={ticket.id}
          type="button"
          className={`plans-strip-item plans-strip-item--${ticket.status}`}
          onClick={() => onOpen(ticket)}
        >
          <span className="plans-strip-icon">{statusIcon(ticket.status)}</span>
          <div className="plans-strip-tooltip">
            <span className="plans-strip-tooltip-status">{STATUS_LABEL[ticket.status]}</span>
            {ticket.title}
          </div>
        </button>
      ))}
    </div>
  );
}

export function PlansPanel({ tickets, onOpen, activePlanId, compact }: Props) {
  if (tickets.length === 0) return null;
  return compact ? <IconStrip tickets={tickets} onOpen={onOpen} /> : <FullPanel tickets={tickets} onOpen={onOpen} activePlanId={activePlanId} />;
}
