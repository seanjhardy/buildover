import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chatsDir } from "./repos.js";
import type { PlanTicket, PlanTicketStatus, PlansFile } from "../src/types.js";

// Per-repo plan/ticket store backing the coordinator workflow. Lives next to
// the chats directory at ~/.buildover/repos/{name}/plans.json. Same
// atomic-write + lock discipline as chats.ts so concurrent tool calls from
// the coordinator and REST mutations from the plans panel never corrupt it.

function plansPath(repoPath: string): string {
  // chatsDir is ~/.buildover/repos/{name}/chats — plans.json sits beside it.
  return join(dirname(chatsDir(repoPath)), "plans.json");
}

const plansLocks = new Map<string, Promise<unknown>>();

async function withPlansLock<T>(
  repoPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = repoPath;
  const prev = plansLocks.get(key) ?? Promise.resolve();
  const swallowed = prev.then(
    () => undefined,
    () => undefined,
  );
  const tail = swallowed.then(fn);
  const safeTail: Promise<unknown> = tail.then(
    () => undefined,
    () => undefined,
  );
  plansLocks.set(key, safeTail);
  try {
    return await tail;
  } finally {
    if (plansLocks.get(key) === safeTail) plansLocks.delete(key);
  }
}

async function readPlansFile(repoPath: string): Promise<PlansFile> {
  try {
    const raw = await readFile(plansPath(repoPath), "utf8");
    return JSON.parse(raw) as PlansFile;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { tickets: [], updatedAt: new Date().toISOString() };
    }
    throw err;
  }
}

async function writePlansFile(repoPath: string, file: PlansFile): Promise<void> {
  const path = plansPath(repoPath);
  await mkdir(dirname(path), { recursive: true });
  file.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

function makeTicketId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `tk_${ts}${rand}`;
}

function sortTickets(tickets: PlanTicket[]): PlanTicket[] {
  return [...tickets].sort((a, b) => a.order - b.order);
}

/** Re-pack order values to 0..n-1 preserving relative order. */
function normalizeOrder(tickets: PlanTicket[]): void {
  sortTickets(tickets).forEach((t, i) => {
    t.order = i;
  });
}

export async function listTickets(repoPath: string): Promise<PlanTicket[]> {
  const file = await readPlansFile(repoPath);
  return sortTickets(file.tickets);
}

export interface NewTicketOpts {
  title: string;
  description: string;
  status?: PlanTicketStatus;
  /** Insert position; appended to the end when omitted. */
  order?: number;
  /** Chat id of the agent drafting this ticket — user feedback routes there. */
  createdByChatId?: string;
}

export async function createTicket(
  repoPath: string,
  opts: NewTicketOpts,
): Promise<PlanTicket> {
  return withPlansLock(repoPath, async () => {
    const file = await readPlansFile(repoPath);
    const now = new Date().toISOString();
    const ticket: PlanTicket = {
      id: makeTicketId(),
      title: opts.title,
      description: opts.description,
      status: opts.status ?? "draft",
      order: opts.order ?? file.tickets.length,
      createdByChatId: opts.createdByChatId,
      createdAt: now,
      updatedAt: now,
    };
    if (opts.order != null) {
      // Shift everything at/after the insert point down one slot.
      for (const t of file.tickets) {
        if (t.order >= opts.order) t.order += 1;
      }
    }
    file.tickets.push(ticket);
    normalizeOrder(file.tickets);
    await writePlansFile(repoPath, file);
    return ticket;
  });
}

export interface TicketPatch {
  title?: string;
  description?: string;
  status?: PlanTicketStatus;
  order?: number;
  subagentChatId?: string;
}

export async function updateTicket(
  repoPath: string,
  ticketId: string,
  patch: TicketPatch,
): Promise<PlanTicket | null> {
  return withPlansLock(repoPath, async () => {
    const file = await readPlansFile(repoPath);
    const ticket = file.tickets.find((t) => t.id === ticketId);
    if (!ticket) return null;
    if (patch.title != null) ticket.title = patch.title;
    if (patch.description != null) ticket.description = patch.description;
    if (patch.status != null) ticket.status = patch.status;
    if (patch.subagentChatId != null) ticket.subagentChatId = patch.subagentChatId;
    if (patch.order != null && patch.order !== ticket.order) {
      // Move: remove from old slot, shift, insert at new slot.
      const target = Math.max(0, Math.min(patch.order, file.tickets.length - 1));
      for (const t of file.tickets) {
        if (t === ticket) continue;
        if (t.order > ticket.order) t.order -= 1;
        if (t.order >= target) t.order += 1;
      }
      ticket.order = target;
    }
    ticket.updatedAt = new Date().toISOString();
    normalizeOrder(file.tickets);
    await writePlansFile(repoPath, file);
    return { ...ticket };
  });
}

export async function deleteTicket(
  repoPath: string,
  ticketId: string,
): Promise<boolean> {
  return withPlansLock(repoPath, async () => {
    const file = await readPlansFile(repoPath);
    const before = file.tickets.length;
    file.tickets = file.tickets.filter((t) => t.id !== ticketId);
    if (file.tickets.length === before) return false;
    normalizeOrder(file.tickets);
    await writePlansFile(repoPath, file);
    return true;
  });
}

export async function getTicket(
  repoPath: string,
  ticketId: string,
): Promise<PlanTicket | null> {
  const file = await readPlansFile(repoPath);
  return file.tickets.find((t) => t.id === ticketId) ?? null;
}
