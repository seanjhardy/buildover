/**
 * gridSearch.ts — Cmd+F on the Grid: find a phrase in the grid's chats.
 *
 * Each chat is boiled down to its searchable lines (the title, what the user
 * said and what the agent said back), kept per chat until the chat changes,
 * so typing a query reads each transcript from disk at most once.
 */

import { readChat } from "./chats.js";
import { listGridChats } from "./grid.js";
import type { ChatRecord } from "../src/types.js";

export type GridSearchRole = "title" | "user" | "assistant";

/** One line of a chat that can be searched. */
export interface SearchLine {
  role: GridSearchRole;
  /** Whitespace collapsed to single spaces. */
  text: string;
  ts?: string;
}

/** A match in context: `text[start, start + length)` is the match. */
export interface GridSearchSnippet {
  role: GridSearchRole;
  text: string;
  start: number;
  length: number;
  ts?: string;
}

export interface GridSearchHit {
  chatId: string;
  /** Every occurrence across the chat. */
  count: number;
  /** The newest few, newest first. */
  snippets: GridSearchSnippet[];
}

const SNIPPETS_PER_CHAT = 3;
const BEFORE = 48;
const AFTER = 96;
export const MAX_QUERY = 200;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The searchable lines of a chat, oldest first. */
export function searchLines(record: Pick<ChatRecord, "title" | "events">): SearchLine[] {
  const lines: SearchLine[] = [];
  if (record.title) lines.push({ role: "title", text: squash(record.title) });
  for (const e of record.events) {
    if (e.type === "user_message") {
      const text = squash(e.text);
      if (text) lines.push({ role: "user", text, ts: e.ts });
    } else if (e.type === "assistant") {
      for (const b of e.content) {
        if (b.type !== "text") continue;
        const text = squash(b.text);
        if (text) lines.push({ role: "assistant", text, ts: e.ts });
      }
    }
  }
  return lines;
}

/** A match with up to BEFORE/AFTER characters round it, cut at word edges. */
function snippetAt(line: SearchLine, at: number, length: number): GridSearchSnippet {
  let from = Math.max(0, at - BEFORE);
  let to = Math.min(line.text.length, at + length + AFTER);
  if (from > 0) {
    const sp = line.text.indexOf(" ", from);
    if (sp !== -1 && sp < at) from = sp + 1;
  }
  if (to < line.text.length) {
    const sp = line.text.lastIndexOf(" ", to);
    if (sp > at + length) to = sp;
  }
  const lead = from > 0 ? "…" : "";
  const tail = to < line.text.length ? "…" : "";
  return {
    role: line.role,
    text: lead + line.text.slice(from, to) + tail,
    start: lead.length + at - from,
    length,
    ...(line.ts && { ts: line.ts }),
  };
}

/** Every case-insensitive occurrence of `query` in the lines: how many, and
 *  the newest few in context. Null when there are none. */
export function matchLines(
  lines: SearchLine[],
  query: string,
): Omit<GridSearchHit, "chatId"> | null {
  const q = squash(query).toLowerCase();
  if (!q) return null;
  let count = 0;
  const snippets: GridSearchSnippet[] = [];
  // Newest first, so the snippets are the latest; the title always leads.
  const order = lines.length > 0 && lines[0].role === "title"
    ? [lines[0], ...lines.slice(1).reverse()]
    : [...lines].reverse();
  for (const line of order) {
    const hay = line.text.toLowerCase();
    let at = hay.indexOf(q);
    while (at !== -1) {
      count++;
      if (snippets.length < SNIPPETS_PER_CHAT) snippets.push(snippetAt(line, at, q.length));
      at = hay.indexOf(q, at + q.length);
    }
  }
  return count > 0 ? { count, snippets } : null;
}

/** Searchable lines per chat, kept while its updatedAt doesn't move. */
const cache = new Map<string, { updatedAt: string; lines: SearchLine[] }>();

/** Every chat on the grid that mentions `query`, in grid order. */
export async function searchGridChats(query: string): Promise<GridSearchHit[]> {
  const q = query.slice(0, MAX_QUERY);
  if (!squash(q)) return [];
  const entries = await listGridChats();
  const live = new Set(entries.map((e) => e.chatId));
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);

  const hits: GridSearchHit[] = [];
  await Promise.all(
    entries.map(async (e) => {
      let doc = cache.get(e.chatId);
      if (!doc || doc.updatedAt !== e.chat.updatedAt) {
        const record = await readChat(e.repoPath, e.chatId).catch(() => null);
        if (!record) return;
        doc = { updatedAt: e.chat.updatedAt, lines: searchLines(record) };
        cache.set(e.chatId, doc);
      }
      const m = matchLines(doc.lines, q);
      if (m) hits.push({ chatId: e.chatId, ...m });
    }),
  );
  const order = new Map(entries.map((e, i) => [e.chatId, i]));
  return hits.sort((a, b) => order.get(a.chatId)! - order.get(b.chatId)!);
}
