import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chatsDir, indexPath } from "./repos.js";
import type {
  Attachment,
  ChatEvent,
  ChatRecord,
  ChatStatus,
  ChatSummary,
  Model,
  PermissionMode,
} from "../src/types.js";

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function chatFilePath(repoPath: string, chatId: string): string {
  return join(chatsDir(repoPath), `${chatId}.json`);
}

function makeChatId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `ch_${ts}${rand}`;
}

export interface NewChatOpts {
  model: Model;
  permissionMode: PermissionMode;
}

export async function createChat(
  repoPath: string,
  opts: NewChatOpts,
): Promise<ChatRecord> {
  await mkdir(chatsDir(repoPath), { recursive: true });
  const now = new Date().toISOString();
  const record: ChatRecord = {
    id: makeChatId(),
    title: "New chat",
    titleAuto: false,
    status: "idle",
    userMarkedFinished: false,
    sessionId: undefined,
    model: opts.model,
    permissionMode: opts.permissionMode,
    createdAt: now,
    updatedAt: now,
    events: [],
  };
  await writeJson(chatFilePath(repoPath, record.id), record);
  await rebuildIndex(repoPath);
  return record;
}

export async function readChat(
  repoPath: string,
  chatId: string,
): Promise<ChatRecord | null> {
  return readJson<ChatRecord>(chatFilePath(repoPath, chatId));
}

export async function writeChat(
  repoPath: string,
  record: ChatRecord,
): Promise<void> {
  record.updatedAt = new Date().toISOString();
  await writeJson(chatFilePath(repoPath, record.id), record);
}

export async function appendEvent(
  repoPath: string,
  chatId: string,
  event: ChatEvent,
): Promise<ChatRecord | null> {
  const record = await readChat(repoPath, chatId);
  if (!record) return null;
  record.events.push(event);
  applyEventToMeta(record, event);
  record.status = computeStatus(record);
  await writeChat(repoPath, record);
  return record;
}

function applyEventToMeta(record: ChatRecord, event: ChatEvent): void {
  switch (event.type) {
    case "system_init":
      if (event.sessionId) record.sessionId = event.sessionId;
      break;
    case "result":
      if (event.sessionId) record.sessionId = event.sessionId;
      break;
  }
}

// Status priority for sidebar grouping.
//   awaiting_input > running > agent_done > idle
// `finished` is set independently when the user marks the chat complete.
export function computeStatus(record: ChatRecord): ChatStatus {
  if (record.userMarkedFinished) return "finished";

  // Walk events from the end to find the most recent state-bearing signal.
  let lastTurnStartIndex = -1;
  let lastTurnEndIndex = -1;
  let lastResultIndex = -1;
  const pendingPermissionIds = new Set<string>();
  let hasUserMessageAfterResult = false;

  for (let i = 0; i < record.events.length; i++) {
    const ev = record.events[i];
    switch (ev.type) {
      case "turn_start":
        lastTurnStartIndex = i;
        break;
      case "turn_end":
        lastTurnEndIndex = i;
        break;
      case "result":
        lastResultIndex = i;
        hasUserMessageAfterResult = false;
        break;
      case "permission_request":
        pendingPermissionIds.add(ev.requestId);
        break;
      case "permission_response":
        pendingPermissionIds.delete(ev.requestId);
        break;
      case "user_message":
        if (lastResultIndex >= 0 && i > lastResultIndex)
          hasUserMessageAfterResult = true;
        break;
    }
  }

  if (pendingPermissionIds.size > 0) return "awaiting_input";
  if (lastTurnStartIndex > lastTurnEndIndex) return "running";
  if (lastResultIndex >= 0 && !hasUserMessageAfterResult) return "agent_done";
  return "idle";
}

export async function listChats(repoPath: string): Promise<ChatSummary[]> {
  const dir = chatsDir(repoPath);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const summaries: ChatSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "index.json") continue;
    const chatId = entry.slice(0, -".json".length);
    const record = await readChat(repoPath, chatId);
    if (record) summaries.push(toSummary(record));
  }
  summaries.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return summaries;
}

export async function rebuildIndex(repoPath: string): Promise<void> {
  const summaries = await listChats(repoPath);
  await writeJson(indexPath(repoPath), { chats: summaries });
}

export function toSummary(record: ChatRecord): ChatSummary {
  // Build a small searchable preview from the first few user/assistant
  // messages, capped so the index file stays small.
  const previewParts: string[] = [];
  for (const ev of record.events) {
    if (ev.type === "user_message") {
      previewParts.push(ev.text);
    } else if (ev.type === "assistant") {
      for (const block of ev.content) {
        if (block.type === "text") previewParts.push(block.text);
      }
    }
    if (previewParts.join(" ").length > 600) break;
  }
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    userMarkedFinished: record.userMarkedFinished,
    sessionId: record.sessionId,
    model: record.model,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    preview: previewParts.join(" ").slice(0, 600),
  };
}

export async function setUserFinished(
  repoPath: string,
  chatId: string,
  finished: boolean,
): Promise<ChatRecord | null> {
  const record = await readChat(repoPath, chatId);
  if (!record) return null;
  record.userMarkedFinished = finished;
  record.status = computeStatus(record);
  await writeChat(repoPath, record);
  return record;
}

export async function setTitle(
  repoPath: string,
  chatId: string,
  title: string,
  auto: boolean,
): Promise<ChatRecord | null> {
  const record = await readChat(repoPath, chatId);
  if (!record) return null;
  record.title = title;
  record.titleAuto = auto;
  await writeChat(repoPath, record);
  return record;
}

export async function deleteChat(
  repoPath: string,
  chatId: string,
): Promise<boolean> {
  try {
    await unlink(chatFilePath(repoPath, chatId));
    await rebuildIndex(repoPath);
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

export type AttachmentForEvent = Attachment;
