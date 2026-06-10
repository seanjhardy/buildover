import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { agentSocket } from "../lib/agentSocket.js";
import type { AgentEvent, PlanTicket, PlanTicketStatus } from "../types.js";

export interface UsePlansReturn {
  tickets: PlanTicket[];
  loading: boolean;
  reload: () => Promise<void>;
  setStatus: (
    ticketId: string,
    status: PlanTicketStatus,
    feedback?: string,
  ) => Promise<void>;
  remove: (ticketId: string) => Promise<void>;
  reorder: (ticketId: string, order: number) => Promise<void>;
  /** Send an ephemeral message to the agent linked to a ticket. Resolves to
   *  the target chat id, or null if no agent is linked yet. */
  sendMessage: (ticketId: string, text: string) => Promise<string | null>;
}

// Fetches the repo's coordinator plan board and keeps it live by listening for
// plans_updated events on the coordinator chat's WS channel. The coordinator
// chat is already subscribed by useChats (sidebar), so events flow without an
// extra subscribe message — we just attach a listener.
export function usePlans(
  repoPath: string | null,
  coordinatorChatId: string | null,
): UsePlansReturn {
  const [tickets, setTickets] = useState<PlanTicket[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!repoPath) {
      setTickets([]);
      return;
    }
    setLoading(true);
    try {
      const list = await api.listPlans(repoPath);
      setTickets(sortTickets(list));
    } catch {
      // best-effort; the WS push will repopulate
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live updates pushed over the coordinator chat's channel.
  useEffect(() => {
    if (!coordinatorChatId) return;
    const handler = (event: AgentEvent) => {
      if (event.type === "plans_updated") {
        setTickets(sortTickets(event.tickets));
      }
    };
    return agentSocket.onChatEvent(coordinatorChatId, handler);
  }, [coordinatorChatId]);

  // Refresh after socket reconnects (e.g. server restart) so the panel doesn't
  // go stale waiting for a push that was missed.
  useEffect(() => {
    return agentSocket.onReconnect(() => {
      void reload();
    });
  }, [reload]);

  const setStatus = useCallback(
    async (ticketId: string, status: PlanTicketStatus, feedback?: string) => {
      if (!repoPath) return;
      const updated = await api.updatePlan(repoPath, ticketId, {
        status,
        feedback,
      });
      setTickets((prev) =>
        sortTickets(prev.map((t) => (t.id === ticketId ? updated : t))),
      );
    },
    [repoPath],
  );

  const sendMessage = useCallback(
    async (ticketId: string, text: string) => {
      if (!repoPath) return null;
      try {
        const r = await api.messagePlanAgent(repoPath, ticketId, text);
        return r.chatId;
      } catch {
        return null; // e.g. 409 — no agent linked to this plan yet
      }
    },
    [repoPath],
  );

  const remove = useCallback(
    async (ticketId: string) => {
      if (!repoPath) return;
      await api.deletePlan(repoPath, ticketId);
      setTickets((prev) => prev.filter((t) => t.id !== ticketId));
    },
    [repoPath],
  );

  const reorder = useCallback(
    async (ticketId: string, order: number) => {
      if (!repoPath) return;
      await api.updatePlan(repoPath, ticketId, { order });
      await reload();
    },
    [repoPath, reload],
  );

  return { tickets, loading, reload, setStatus, remove, reorder, sendMessage };
}

function sortTickets(list: PlanTicket[]): PlanTicket[] {
  return [...list].sort((a, b) => a.order - b.order);
}
