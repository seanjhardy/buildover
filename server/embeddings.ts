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
  getAllEmbeddings,
  getIndexedChatIds,
  markChatIndexed,
  removeChat,
  upsertEmbedding,
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

/** Extract all user messages from a chat record. */
function userMessages(record: ChatRecord): { text: string; eventIndex: number; ts: string }[] {
  const out: { text: string; eventIndex: number; ts: string }[] = [];
  for (let i = 0; i < record.events.length; i++) {
    const ev = record.events[i];
    if (ev.type === "user_message" && ev.text.trim()) {
      out.push({ text: ev.text.trim(), eventIndex: i, ts: ev.ts });
    }
  }
  return out;
}

/** Index a single chat (called after new user messages arrive). */
export async function indexChat(repoPath: string, record: ChatRecord): Promise<void> {
  const messages = userMessages(record);
  if (messages.length === 0) return;
  for (const msg of messages) {
    const id = `${record.id}:${msg.eventIndex}`;
    const embedding = await generateEmbedding(msg.text);
    upsertEmbedding({ id, chatId: record.id, repoPath, messageText: msg.text, eventIndex: msg.eventIndex, embedding, ts: msg.ts });
  }
  markChatIndexed(record.id, repoPath, messages.length);
}

/** Remove a chat's embeddings (call on delete). */
export function removeIndexedChat(repoPath: string, chatId: string): void {
  removeChat(chatId, repoPath);
}

/** Kick off background indexing of all un-indexed chats. No-op if already running. */
export function ensureIndexedBackground(repoPath: string): void {
  if (_indexing) return;
  _indexing = true;
  (async () => {
    try {
      const allChats = await listChats(repoPath);
      const indexed = getIndexedChatIds(repoPath);
      const pending = allChats.filter((c) => !indexed.has(c.id));
      _totalCount = allChats.length;
      _indexedCount = indexed.size;
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
  score: number;
  ts: string;
}

const SCORE_THRESHOLD = 0.25;

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

  // Score every stored message.
  const scored = stored.map((e) => ({ ...e, score: cosine(queryVec, e.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit).filter((r) => r.score >= SCORE_THRESHOLD);

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
        score: r.score,
        ts: r.ts,
      };
    });

  return { results, status: getIndexStatus() };
}
