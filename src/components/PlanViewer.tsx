import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Code,
  MessageSquare,
  Trash2,
  X,
} from "lucide-react";
import type { PlanTicket, PlanTicketStatus } from "../types.js";

interface Props {
  ticket: PlanTicket;
  onClose: () => void;
  onSetStatus: (status: PlanTicketStatus, feedback?: string) => void;
  onDelete: () => void;
  /** Ephemeral message to the agent linked to this plan (worker, else drafter). */
  onSendMessage: (text: string) => void;
  onReorder?: (order: number) => void;
  /** Index within the (ordered) ticket list — drives move up/down. */
  index?: number;
  total?: number;
  onOpenChat?: (chatId: string) => void;
}

const STATUS_LABEL: Record<PlanTicketStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  in_progress: "In progress",
  agent_done: "Ready for review",
  done: "Done",
  rejected: "Rejected",
};

// Right-side detail pane for a single plan ticket. Mirrors the FileViewer
// geometry (shares the `.detail-pane` slot) and surfaces the approve/reject/
// mark-done actions plus a composer that messages the plan's agent directly.
export function PlanViewer({
  ticket,
  onClose,
  onSetStatus,
  onDelete,
  onSendMessage,
  onReorder,
  index,
  total,
  onOpenChat,
}: Props) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [messageText, setMessageText] = useState("");
  // Plans carry two bodies: a plain-language overview for the user
  // (humanDescription, shown by default) and the technical spec written for
  // the implementing agent (description, behind the toggle). Older tickets
  // may only have the technical version — then it's shown without a toggle.
  const [showTechnical, setShowTechnical] = useState(false);
  const hasHuman = Boolean(ticket.humanDescription?.trim());

  // Always land on the overview when switching to a different ticket.
  useEffect(() => {
    setShowTechnical(false);
  }, [ticket.id]);

  // Close on Escape — unless the user is mid-typing in a textarea.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const canReorder =
    onReorder != null &&
    (ticket.status === "draft" || ticket.status === "approved");
  // Messages route to the worker subagent if one was spawned, otherwise to
  // the agent that drafted the ticket. With neither, there's nobody to talk to.
  const hasAgent = Boolean(ticket.subagentChatId ?? ticket.createdByChatId);

  const submitMessage = () => {
    const text = messageText.trim();
    if (!text || !hasAgent) return;
    onSendMessage(text);
    setMessageText("");
  };

  const confirmReject = () => {
    onSetStatus("rejected", feedback.trim() || undefined);
    setRejecting(false);
    setFeedback("");
  };

  return (
    <div className="plan-viewer detail-pane">
      {/* Header */}
      <div className="plan-viewer-header">
        <span className="plan-viewer-title">{ticket.title}</span>
        <span className={`plan-ticket-chip plan-ticket-chip--${ticket.status}`}>
          {ticket.status === "in_progress" && (
            <span className="plan-working-dot" aria-hidden="true" />
          )}
          {STATUS_LABEL[ticket.status]}
        </span>
        <button
          className="plan-viewer-close"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close plan"
        >
          <X size={14} />
        </button>
      </div>

      {/* View toggle: plain-language overview vs technical spec */}
      {hasHuman && (
        <div className="plan-viewer-view-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={!showTechnical}
            className={`plan-viewer-view-btn${!showTechnical ? " plan-viewer-view-btn--active" : ""}`}
            onClick={() => setShowTechnical(false)}
            title="Plain-language overview of this plan"
          >
            <BookOpen size={12} /> Overview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={showTechnical}
            className={`plan-viewer-view-btn${showTechnical ? " plan-viewer-view-btn--active" : ""}`}
            onClick={() => setShowTechnical(true)}
            title="Detailed technical specification for the implementing agent"
          >
            <Code size={12} /> Technical spec
          </button>
        </div>
      )}

      {/* Body */}
      <div className="plan-viewer-body">
        {(() => {
          const body =
            hasHuman && !showTechnical
              ? ticket.humanDescription!
              : ticket.description;
          return body ? (
            <div className="plan-viewer-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
            </div>
          ) : (
            <div className="plan-viewer-empty">No description.</div>
          );
        })()}
      </div>

      {/* Footer actions */}
      <div className="plan-viewer-footer">
        {rejecting ? (
          <div className="plan-viewer-reject">
            <textarea
              value={feedback}
              placeholder="Optional feedback for the agent that drafted this plan…"
              onChange={(e) => setFeedback(e.target.value)}
              rows={2}
              autoFocus
            />
            <div className="plan-viewer-reject-actions">
              <button
                className="plan-ticket-btn plan-ticket-btn--reject"
                onClick={confirmReject}
              >
                <X size={12} /> Confirm reject
              </button>
              <button
                className="plan-ticket-btn"
                onClick={() => {
                  setRejecting(false);
                  setFeedback("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="plan-viewer-actions">
            {ticket.status === "draft" && (
              <>
                <button
                  className="plan-ticket-btn plan-ticket-btn--approve"
                  onClick={() => onSetStatus("approved")}
                >
                  <Check size={12} /> Approve
                </button>
                <button
                  className="plan-ticket-btn plan-ticket-btn--reject"
                  onClick={() => setRejecting(true)}
                >
                  <X size={12} /> Reject
                </button>
              </>
            )}
            {ticket.status === "agent_done" && (
              <button
                className="plan-ticket-btn plan-ticket-btn--approve"
                onClick={() => onSetStatus("done")}
                title="Sign off this ticket as done"
              >
                <CheckCheck size={12} /> Mark done
              </button>
            )}
            {ticket.subagentChatId && onOpenChat && (
              <button
                className="plan-ticket-btn"
                onClick={() => onOpenChat(ticket.subagentChatId!)}
                title="Open the chat working on this ticket"
              >
                <MessageSquare size={12} /> Open chat
              </button>
            )}
            {canReorder && (
              <>
                <button
                  className="plan-ticket-btn plan-ticket-btn--icon"
                  onClick={() => onReorder!(Math.max(0, ticket.order - 1))}
                  disabled={index === 0}
                  title="Move up"
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  className="plan-ticket-btn plan-ticket-btn--icon"
                  onClick={() => onReorder!(ticket.order + 1)}
                  disabled={total != null && index != null && index >= total - 1}
                  title="Move down"
                >
                  <ChevronDown size={13} />
                </button>
              </>
            )}
            <button
              className="plan-ticket-btn plan-ticket-btn--icon plan-ticket-btn--danger"
              onClick={onDelete}
              title="Delete ticket"
            >
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>

      {/* Pinned composer: messages go straight to the plan's agent, nothing
          is stored on the ticket. */}
      <div className="plan-viewer-composer">
        <textarea
          value={messageText}
          placeholder={
            hasAgent
              ? "Message the agent on this plan…"
              : "No agent is linked to this plan yet"
          }
          disabled={!hasAgent}
          onChange={(e) => setMessageText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submitMessage();
            }
          }}
          rows={2}
        />
        <button
          className="send-btn"
          onClick={submitMessage}
          disabled={!hasAgent || !messageText.trim()}
          title="Send to the plan's agent (⌘/Ctrl+Enter)"
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  );
}
