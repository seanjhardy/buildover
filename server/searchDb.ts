/**
 * SQLite-backed storage for chat message embeddings.
 * Uses better-sqlite3 (synchronous API) for simplicity.
 * DB lives at ~/.buildover/search.db alongside chat files.
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

const BUILDOVER_HOME = join(homedir(), ".buildover");
const DB_PATH = join(BUILDOVER_HOME, "search.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    mkdirSync(BUILDOVER_HOME, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("synchronous = NORMAL");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_embeddings (
      id           TEXT PRIMARY KEY,
      chat_id      TEXT NOT NULL,
      repo_path    TEXT NOT NULL,
      message_text TEXT NOT NULL,
      event_index  INTEGER NOT NULL,
      embedding    BLOB NOT NULL,
      ts           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_me_repo ON message_embeddings(repo_path);
    CREATE INDEX IF NOT EXISTS idx_me_chat ON message_embeddings(chat_id);

    CREATE TABLE IF NOT EXISTS indexed_chats (
      id            TEXT NOT NULL,
      repo_path     TEXT NOT NULL,
      indexed_at    TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, repo_path)
    );
  `);
}

// ── Write helpers ─────────────────────────────────────────────────────────────

export function upsertEmbedding(data: {
  id: string;
  chatId: string;
  repoPath: string;
  messageText: string;
  eventIndex: number;
  embedding: Float32Array;
  ts: string;
}): void {
  const db = getDb();
  // Store the Float32Array as a raw byte buffer
  const buf = Buffer.from(data.embedding.buffer);
  db.prepare(`
    INSERT OR REPLACE INTO message_embeddings
      (id, chat_id, repo_path, message_text, event_index, embedding, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(data.id, data.chatId, data.repoPath, data.messageText, data.eventIndex, buf, data.ts);
}

export function markChatIndexed(chatId: string, repoPath: string, messageCount: number): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO indexed_chats (id, repo_path, indexed_at, message_count)
    VALUES (?, ?, ?, ?)
  `).run(chatId, repoPath, new Date().toISOString(), messageCount);
}

export function removeChat(chatId: string, repoPath: string): void {
  const db = getDb();
  db.prepare("DELETE FROM message_embeddings WHERE chat_id = ? AND repo_path = ?").run(chatId, repoPath);
  db.prepare("DELETE FROM indexed_chats WHERE id = ? AND repo_path = ?").run(chatId, repoPath);
}

// ── Read helpers ──────────────────────────────────────────────────────────────

export interface StoredEmbedding {
  id: string;
  chatId: string;
  messageText: string;
  eventIndex: number;
  embedding: Float32Array;
  ts: string;
}

export function getIndexedChatIds(repoPath: string): Set<string> {
  const rows = getDb()
    .prepare("SELECT id FROM indexed_chats WHERE repo_path = ?")
    .all(repoPath) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export function getAllEmbeddings(repoPath: string): StoredEmbedding[] {
  const rows = getDb()
    .prepare("SELECT id, chat_id, message_text, event_index, embedding, ts FROM message_embeddings WHERE repo_path = ?")
    .all(repoPath) as {
      id: string;
      chat_id: string;
      message_text: string;
      event_index: number;
      embedding: Buffer;
      ts: string;
    }[];

  return rows.map((r) => {
    // Buffer.buffer may be larger than the data (shared ArrayBuffer pool),
    // so use byteOffset + byteLength to create the correct view.
    const embedding = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
    return {
      id: r.id,
      chatId: r.chat_id,
      messageText: r.message_text,
      eventIndex: r.event_index,
      embedding,
      ts: r.ts,
    };
  });
}
