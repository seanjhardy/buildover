/**
 * Embedding generation + semantic search service.
 *
 * Uses @xenova/transformers with the lightweight all-MiniLM-L6-v2 model
 * (384-dim, ~25 MB download, cached in ~/.cache/huggingface after first run).
 * No API key required — runs fully locally.
 *
 * Indexing is done lazily in the background so search calls never block a
 * chat turn. A call to searchMessages() will kick off indexing for any
 * un-indexed chats while still returning results from already-indexed ones.
 */
import { listChats, readChat } from "./chats.js";
import {
  deleteEmbeddings,
  getAllEmbeddings,
  getChatEmbeddingTexts,
  getIndexedChats,
  markChatIndexed,
  removeChat,
  upsertEmbedding,
  type MessageRole,
  type StoredEmbedding,
} from "./searchDb.js";
import type { ChatRecord } from "../src/types.js";

// ── Lazy pipeline loader ──────────────────────────────────────────────────────

type EmbeddingPipeline = (
  text: string,
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let _pipelinePromise: Promise<EmbeddingPipeline> | null = null;
let _modelReady = false;
let _modelLoading = false;
let _modelError: string | null = null;

async function getPipeline(): Promise<EmbeddingPipeline> {
  if (!_pipelinePromise) {
    _modelLoading = true;
    _pipelinePromise = (async () => {
      try {
        // Dynamic import keeps this off the startup hot path.
        const { pipeline } = await import("@xenova/transformers");
        const pipe = await (pipeline as Function)(
          "feature-extraction",
          "Xenova/all-MiniLM-L6-v2",
        ) as EmbeddingPipeline;
        _modelReady = true;
        _modelLoading = false;
        console.log("[embeddings] model ready");
        return pipe;
      } catch (err) {
        _modelLoading = false;
        _modelError = err instanceof Error ? err.message : String(err);
        console.error("[embeddings] model load failed:", _modelError);
        throw err;
      }
    })();
  }
  return _pipelinePromise;
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const pipe = await getPipeline();
  const out = await pipe(text, { pooling: "mean", normalize: true });
  return out.data;
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── Indexing ──────────────────────────────────────────────────────────────────

let _indexing = false;
let _indexedCount = 0;
let _totalCount = 0;

export interface IndexStatus {
  isModelLoading: boolean;
  isIndexing: boolean;
  modelError: string | null;
  indexed: number;
  total: number;
}

export function getIndexStatus(): IndexStatus {
  return {
    isModelLoading: _modelLoading,
    isIndexing: _indexing,
    modelError: _modelError,
    indexed: _indexedCount,
    total: _totalCount,
  };
}

interface IndexableMessage {
  text: string;
  eventIndex: number;
  role: MessageRole;
  ts: string;
}

/**
 * Extract the searchable messages from a chat record: every user message,
 * plus the agent's final message of each finished turn. That's the `result`
 * event's text when present; turns without one (interrupted, some providers)
 * fall back to the last assistant text block before `turn_end`. Turns still
 * in progress are skipped.
 */
function indexableMessages(record: ChatRecord): IndexableMessage[] {
  const out: IndexableMessage[] = [];
  let lastText: IndexableMessage | null = null;
  let turnDone = false;
  for (let i = 0; i < record.events.length; i++) {
    const ev = record.events[i];
    if (ev.type === "user_message") {
      // A user message after a finished turn starts the next one (older chats
      // have no turn_start events).
      if (turnDone) { lastText = null; turnDone = false; }
      if (ev.text.trim()) out.push({ text: ev.text.trim(), eventIndex: i, role: "user", ts: ev.ts });
    } else if (ev.type === "turn_start") {
      lastText = null;
      turnDone = false;
    } else if (ev.type === "assistant" && !turnDone) {
      const text = ev.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim();
      if (text) lastText = { text, eventIndex: i, role: "agent", ts: ev.ts };
    } else if (ev.type === "result" && !turnDone) {
      const text = ev.result?.trim();
      if (text) out.push({ text, eventIndex: i, role: "agent", ts: ev.ts });
      else if (lastText) out.push(lastText);
      turnDone = true;
    } else if (ev.type === "turn_end" && !turnDone) {
      if (lastText) out.push(lastText);
      turnDone = true;
    }
  }
  return out;
}

/**
 * Index a single chat. Incremental: only messages that are new or whose text
 * changed get embedded, and rows for messages no longer in the chat (e.g.
 * after a checkpoint revert) are dropped.
 */
export async function indexChat(repoPath: string, record: ChatRecord): Promise<void> {
  const messages = indexableMessages(record);
  const existing = getChatEmbeddingTexts(record.id, repoPath);
  const keep = new Set<string>();
  for (const msg of messages) {
    const id = `${record.id}:${msg.eventIndex}`;
    keep.add(id);
    if (existing.get(id) === msg.text) continue;
    const embedding = await generateEmbedding(msg.text);
    upsertEmbedding({ id, chatId: record.id, repoPath, messageText: msg.text, eventIndex: msg.eventIndex, role: msg.role, embedding, ts: msg.ts });
  }
  deleteEmbeddings([...existing.keys()].filter((id) => !keep.has(id)), repoPath);
  markChatIndexed(record.id, repoPath, messages.length);
}

/** Remove a chat's embeddings (call on delete). */
export function removeIndexedChat(repoPath: string, chatId: string): void {
  removeChat(chatId, repoPath);
}

/**
 * Kick off background indexing of chats that are un-indexed or have been
 * updated since they were last indexed. No-op if already running.
 */
export function ensureIndexedBackground(repoPath: string): void {
  if (_indexing) return;
  _indexing = true;
  (async () => {
    try {
      const allChats = await listChats(repoPath);
      const indexed = getIndexedChats(repoPath);
      const pending = allChats.filter((c) => {
        const indexedAt = indexed.get(c.id);
        return !indexedAt || new Date(c.updatedAt).getTime() > new Date(indexedAt).getTime();
      });
      _totalCount = allChats.length;
      _indexedCount = allChats.length - pending.length;
      if (pending.length === 0) { _indexing = false; return; }
      console.log(`[embeddings] indexing ${pending.length} chats in background…`);
      for (const summary of pending) {
        const record = await readChat(repoPath, summary.id);
        if (record) await indexChat(repoPath, record);
        _indexedCount++;
      }
      console.log("[embeddings] background indexing complete");
    } catch (err) {
      console.error("[embeddings] background indexing error:", err);
    } finally {
      _indexing = false;
    }
  })();
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  chatId: string;
  chatTitle: string;
  chatUpdatedAt: string;
  messageText: string;
  eventIndex: number;
  role: MessageRole;
  score: number;
  /** Message contains the query verbatim (case/whitespace-insensitive). */
  exactMatch: boolean;
  ts: string;
}

const SCORE_THRESHOLD = 0.25;
/** Max boost added to the cosine score when a message contains query terms. */
const KEYWORD_WEIGHT = 0.15;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Fraction of the query's terms (2+ chars) that appear somewhere in the text. */
function keywordCoverage(normText: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  let hits = 0;
  for (const t of terms) if (normText.includes(t)) hits++;
  return hits / terms.length;
}

export async function searchMessages(
  repoPath: string,
  query: string,
  limit = 12,
): Promise<{ results: SearchResult[]; status: IndexStatus }> {
  // Warm up the model and kick off any pending indexing in parallel.
  getPipeline().catch(() => {});
  ensureIndexedBackground(repoPath);

  const status = getIndexStatus();

  if (!query.trim()) return { results: [], status };

  // Wait for query embedding (model must be ready for this).
  const queryVec = await generateEmbedding(query);
  const stored: StoredEmbedding[] = getAllEmbeddings(repoPath);
  if (stored.length === 0) return { results: [], status: getIndexStatus() };

  const normQuery = normalize(query);
  const terms = [...new Set(normQuery.split(" ").filter((t) => t.length >= 2))];

  // Score every stored message. Exact phrase matches are pinned to the top
  // (ordered among themselves by embedding similarity); everything else is
  // ranked by cosine similarity plus a small boost for matching query terms.
  const exact: (StoredEmbedding & { score: number })[] = [];
  const semantic: (StoredEmbedding & { score: number; rank: number })[] = [];
  for (const e of stored) {
    const score = cosine(queryVec, e.embedding);
    const normText = normalize(e.messageText);
    if (normText.includes(normQuery)) {
      exact.push({ ...e, score });
    } else {
      const rank = score + KEYWORD_WEIGHT * keywordCoverage(normText, terms);
      if (rank >= SCORE_THRESHOLD) semantic.push({ ...e, score, rank });
    }
  }
  exact.sort((a, b) => b.score - a.score);
  semantic.sort((a, b) => b.rank - a.rank);
  const top = [
    ...exact.slice(0, limit).map((r) => ({ ...r, exactMatch: true })),
    ...semantic.slice(0, Math.max(0, limit - exact.length)).map((r) => ({ ...r, exactMatch: false })),
  ];

  // Resolve chat titles — batch by chat so we only read each file once.
  const chatMeta = new Map<string, { title: string; updatedAt: string }>();
  const allChats = await listChats(repoPath);
  for (const c of allChats) chatMeta.set(c.id, { title: c.title, updatedAt: c.updatedAt });

  const results: SearchResult[] = top
    .filter((r) => chatMeta.has(r.chatId))
    .map((r) => {
      const meta = chatMeta.get(r.chatId)!;
      return {
        chatId: r.chatId,
        chatTitle: meta.title,
        chatUpdatedAt: meta.updatedAt,
        messageText: r.messageText,
        eventIndex: r.eventIndex,
        role: r.role,
        score: r.score,
        exactMatch: r.exactMatch,
        ts: r.ts,
      };
    });

  return { results, status: getIndexStatus() };
}
