import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { getModelProvider, type ModelProvider } from "./modelProvider.js";
import { chatsDir, indexPath } from "./repos.js";
import { pruneSnapshotsFrom, restoreFromCheckpoint } from "./snapshots.js";
import type {
  Attachment,
  ChatBranch,
  ChatCost,
  ChatEvent,
  ChatHandoffTo,
  ChatKind,
  ChatRecord,
  ChatStatus,
  ChatSummary,
  Model,
  PermissionMode,
  QueuedChatTurn,
} from "../src/types.js";
import {
  DEFAULT_MODEL,
  KEEP_WARM_BUDGET_HOURS,
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

// Atomic write: write to a sibling temp file, then rename over the target.
// Combined with a per-chat lock (below) this guarantees readers always see
// either the old contents or the new — never a half-written file. Without
// this, two concurrent writeFile calls on the same path can interleave and
// leave trailing garbage when one buffer is shorter than the other.
async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

// Per-chat write lock. Each operation chains onto the previous promise for
// the same chat so read-modify-write sequences serialize. The agent emits
// many events in quick succession; without this, fs.writeFile races corrupt
// the chat file.
const chatLocks = new Map<string, Promise<unknown>>();

export async function withChatLock<T>(
  repoPath: string,
  chatId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${repoPath}\0${chatId}`;
  const prev = chatLocks.get(key) ?? Promise.resolve();
  // Swallow the previous outcome so one failing op doesn't poison subsequent
  // ops on the same chat.
  const swallowed = prev.then(
    () => undefined,
    () => undefined,
  );
  const tail = swallowed.then(fn);
  const safeTail: Promise<unknown> = tail.then(
    () => undefined,
    () => undefined,
  );
  chatLocks.set(key, safeTail);
  try {
    return await tail;
  } finally {
    // Drop the entry only if nobody chained after us in the meantime.
    if (chatLocks.get(key) === safeTail) chatLocks.delete(key);
  }
}

function chatFilePath(repoPath: string, chatId: string): string {
  return join(chatsDir(repoPath), `${chatId}.json`);
}

// ---- Chat list index ----
//
// The sidebar only needs lightweight summaries, but historically `listChats`
// read and parsed *every* full chat file (including the entire events array)
// on each call — making the first page load scale with the total size of all
// transcripts. We keep an in-memory index of summaries instead, persisted to
// `index.json` so a fresh process can bootstrap without scanning. The map is
// kept fresh by writeChat/createChat/deleteChat; `index.json` is a convenience
// cache, never the source of truth (the per-chat files always are).
const indexCache = new Map<string, Map<string, ChatSummary>>();
const indexLoading = new Map<string, Promise<Map<string, ChatSummary>>>();
const indexPersistTimers = new Map<string, NodeJS.Timeout>();

// Bumped whenever the shape of a persisted ChatSummary changes so that an
// index.json written by an older build is discarded and rebuilt (rather than
// silently missing newly-added fields). v2 added queuedTurn / queuePaused,
// which the queue drainer reads instead of re-parsing every transcript. v3
// added lastApiAt, which list views use to show prompt-cache warmth.
const INDEX_VERSION = 3;

interface PersistedIndex {
  version?: number;
  chats: ChatSummary[];
}

// Full disk scan — the slow path, used only to (re)build the index from
// scratch when no usable `index.json` exists.
async function scanChatSummaries(repoPath: string): Promise<ChatSummary[]> {
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
    if (entry.includes(".tmp-")) continue; // skip in-flight atomic-write temp files
    const chatId = entry.slice(0, -".json".length);
    // A single corrupt file shouldn't take down listing — log and skip.
    let record: ChatRecord | null = null;
    try {
      record = await readChat(repoPath, chatId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[chats] skipping unreadable chat file ${entry}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (record) summaries.push(toSummary(record));
  }
  return summaries;
}

// Load (and memoize) the index for a repo. Prefers the persisted `index.json`;
// falls back to a one-time full scan when it's missing. Concurrent callers
// share a single in-flight load so we never scan twice.
async function ensureIndexLoaded(
  repoPath: string,
): Promise<Map<string, ChatSummary>> {
  const cached = indexCache.get(repoPath);
  if (cached) return cached;
  const inflight = indexLoading.get(repoPath);
  if (inflight) return inflight;
  const load = (async () => {
    const map = new Map<string, ChatSummary>();
    const persisted = await readJson<PersistedIndex>(indexPath(repoPath));
    if (persisted?.version === INDEX_VERSION && persisted.chats?.length) {
      for (const c of persisted.chats) map.set(c.id, c);
    } else {
      for (const s of await scanChatSummaries(repoPath)) map.set(s.id, s);
      schedulePersistIndex(repoPath, map);
    }
    indexCache.set(repoPath, map);
    indexLoading.delete(repoPath);
    return map;
  })();
  indexLoading.set(repoPath, load);
  return load;
}

// Cheap reconcile against the chats directory: a single `readdir` (filenames
// only — no file contents) lets us drop entries whose file is gone and pick up
// files not yet indexed. Only the unindexed files are read, so once the index
// is in sync this reads zero chat files. This is what keeps the index honest
// across out-of-band edits and crash-recovery gaps.
async function reconcileIndexWithDisk(
  repoPath: string,
  map: Map<string, ChatSummary>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(chatsDir(repoPath));
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      if (map.size > 0) {
        map.clear();
        schedulePersistIndex(repoPath, map);
      }
      return;
    }
    throw err;
  }
  const onDisk = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "index.json") continue;
    if (entry.includes(".tmp-")) continue;
    onDisk.add(entry.slice(0, -".json".length));
  }
  let dirty = false;
  for (const id of [...map.keys()]) {
    if (!onDisk.has(id)) {
      map.delete(id);
      dirty = true;
    }
  }
  for (const id of onDisk) {
    if (map.has(id)) continue;
    const record = await readChat(repoPath, id).catch(() => null);
    if (record) {
      map.set(id, toSummary(record));
      dirty = true;
    }
  }
  if (dirty) schedulePersistIndex(repoPath, map);
}

// Coalesced, non-blocking persist of the index to disk. writeChat runs on the
// hot path (once per streamed event), so we debounce rather than write on every
// mutation. Crash-in-window only risks stale per-entry content — the reconcile
// above always restores the correct *set* of chats from the files on disk.
function schedulePersistIndex(
  repoPath: string,
  map: Map<string, ChatSummary>,
): void {
  if (indexPersistTimers.has(repoPath)) return;
  const timer = setTimeout(() => {
    indexPersistTimers.delete(repoPath);
    void writeJson(indexPath(repoPath), {
      version: INDEX_VERSION,
      chats: [...map.values()],
    } satisfies PersistedIndex).catch((err) =>
      console.warn("[chats] failed to persist chat index:", err),
    );
  }, 500);
  // Don't keep the event loop alive just to flush the index.
  if (typeof timer.unref === "function") timer.unref();
  indexPersistTimers.set(repoPath, timer);
}

function makeChatId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `ch_${ts}${rand}`;
}

export interface NewChatOpts {
  id?: string;
  model: Model;
  permissionMode: PermissionMode;
  title?: string;
  kind?: ChatKind;
  parentChatId?: string;
  task?: string;
  /** Run in the same isolated worktree as another chat (handoff). */
  worktreePath?: string;
  worktreeBranch?: string;
  context1m?: boolean;
  handoffFrom?: ChatRecord["handoffFrom"];
}

export async function createChat(
  repoPath: string,
  opts: NewChatOpts,
): Promise<ChatRecord> {
  await mkdir(chatsDir(repoPath), { recursive: true });
  const now = new Date().toISOString();
  const record: ChatRecord = {
    id: opts.id ?? makeChatId(),
    title: opts.title ?? "New chat",
    titleAuto: false,
    status: "idle",
    userMarkedFinished: false,
    sessionId: undefined,
    model: opts.model,
    permissionMode: opts.permissionMode,
    createdAt: now,
    updatedAt: now,
    events: [],
    ...(opts.kind && opts.kind !== "user" ? { kind: opts.kind } : {}),
    ...(opts.parentChatId ? { parentChatId: opts.parentChatId } : {}),
    ...(opts.task ? { task: opts.task } : {}),
    ...(opts.worktreePath ? { worktreePath: opts.worktreePath } : {}),
    ...(opts.worktreeBranch ? { worktreeBranch: opts.worktreeBranch } : {}),
    ...(opts.context1m ? { context1m: true } : {}),
    ...(opts.handoffFrom ? { handoffFrom: opts.handoffFrom } : {}),
  };
  await writeJson(chatFilePath(repoPath, record.id), record);
  const index = await ensureIndexLoaded(repoPath);
  index.set(record.id, toSummary(record));
  schedulePersistIndex(repoPath, index);
  return record;
}

// Every repo has exactly one coordinator chat, pinned at the top of the
// sidebar and impossible to delete. Created lazily the first time the chat
// list is requested. Serialized through the chat lock (keyed on a sentinel id)
// so two concurrent listChats calls can't both create one.
export async function ensureCoordinatorChat(
  repoPath: string,
): Promise<ChatSummary> {
  return withChatLock(repoPath, "__coordinator_ensure__", async () => {
    const index = await ensureIndexLoaded(repoPath);
    await reconcileIndexWithDisk(repoPath, index);
    const coordinator = [...index.values()].find(
      (summary) => summary.kind === "coordinator",
    );
    if (coordinator) {
      // This is the normal list-chats path: the summary proves the coordinator
      // exists, and its canonical title needs no full-transcript read.
      if (coordinator.title === "Coordinator") return coordinator;
      // Read only the one transcript identified by the lightweight index. The
      // old implementation parsed every chat file on every sidebar request.
      // A read is only needed to self-heal a legacy renamed coordinator.
      const record = await readChat(repoPath, coordinator.id).catch(() => null);
      if (record?.kind === "coordinator") {
        // Self-heal: the coordinator is permanently titled "Coordinator".
        // Repairs chats renamed before setTitle learned to refuse renames.
        if (record.title !== "Coordinator") {
          record.title = "Coordinator";
          record.titleAuto = false;
          await writeChat(repoPath, record);
        }
        return toSummary(record);
      }
      // Do not let a stale/corrupt indexed entry prevent recreation.
      index.delete(coordinator.id);
      schedulePersistIndex(repoPath, index);
    }
    const created = await createChat(repoPath, {
      model: DEFAULT_MODEL,
      permissionMode: "bypassPermissions",
      title: "Coordinator",
      kind: "coordinator",
    });
    return toSummary(created);
  });
}

// Like ensureCoordinatorChat, but never creates one — returns the existing
// coordinator chat or null if the repo doesn't have one yet. Used by callers
// that only want to notify/broadcast to the coordinator when it already exists.
export async function findCoordinatorChat(
  repoPath: string,
): Promise<ChatRecord | null> {
  const index = await ensureIndexLoaded(repoPath);
  await reconcileIndexWithDisk(repoPath, index);
  const coordinator = [...index.values()].find(
    (summary) => summary.kind === "coordinator",
  );
  if (!coordinator) return null;
  const record = await readChat(repoPath, coordinator.id).catch(() => null);
  return record?.kind === "coordinator" ? record : null;
}

export async function readChat(
  repoPath: string,
  chatId: string,
): Promise<ChatRecord | null> {
  return readJson<ChatRecord>(chatFilePath(repoPath, chatId));
}

export function withComputedStatus(record: ChatRecord): ChatRecord {
  return { ...record, status: computeStatus(record) };
}

export async function writeChat(
  repoPath: string,
  record: ChatRecord,
): Promise<void> {
  record.updatedAt = new Date().toISOString();
  await writeJson(chatFilePath(repoPath, record.id), record);
  const index = await ensureIndexLoaded(repoPath);
  index.set(record.id, toSummary(record));
  schedulePersistIndex(repoPath, index);
}

export async function appendEvent(
  repoPath: string,
  chatId: string,
  event: ChatEvent,
  ensureOpenTurn = false,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    // Reconnect/replay races can deliver the exact same SDK event twice. Keep
    // persistence idempotent while still preserving legacy Codex events that
    // reused a UUID for different content.
    if (event.type === "assistant" || event.type === "user_tool_results") {
      const serializedContent = JSON.stringify(event.content);
      const duplicate = record.events.some(
        (existing) =>
          existing.type === event.type &&
          existing.uuid === event.uuid &&
          JSON.stringify(existing.content) === serializedContent,
      );
      if (duplicate) return record;
    } else if (
      event.type === "user_message" &&
      record.events.some(
        (existing) =>
          existing.type === "user_message" && existing.id === event.id,
      )
    ) {
      return record;
    }
    // A live provider is stronger evidence than a stale recovery marker. If
    // recovery closed the turn while the provider was still alive, reopen it
    // in the same locked write as the next provider event. This keeps replay
    // and a subsequent real server restart from mistaking active work for an
    // already-finished turn.
    if (ensureOpenTurn) {
      let openTurn = false;
      for (const existing of record.events) {
        if (existing.type === "turn_start") openTurn = true;
        else if (existing.type === "turn_end") openTurn = false;
      }
      if (!openTurn) {
        record.events.push({ type: "turn_start", ts: event.ts });
      }
    }
    record.events.push(event);
    applyEventToMeta(record, event);
    record.status = computeStatus(record);
    await writeChat(repoPath, record);
    return record;
  });
}

// Opens a turn in one locked read-modify-write: records the turn's model and
// permission mode and appends its opening events (user message, revert
// checkpoint). Chat files run to tens of MB, so each separate append costs a
// full parse + rewrite before the model is even called.
export async function beginChatTurn(
  repoPath: string,
  chatId: string,
  settings: Pick<ChatRecord, "model" | "permissionMode">,
  events: ChatEvent[],
): Promise<{ record: ChatRecord; isFirstUserTurn: boolean } | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    const isFirstUserTurn = !record.events.some((e) => e.type === "user_message");
    record.model = settings.model;
    record.permissionMode = settings.permissionMode;
    for (const event of events) {
      record.events.push(event);
      applyEventToMeta(record, event);
    }
    record.status = computeStatus(record);
    await writeChat(repoPath, record);
    return { record, isFirstUserTurn };
  });
}

export async function enqueueChatTurn(
  repoPath: string,
  chatId: string,
  turn: QueuedChatTurn,
  userEvent?: ChatEvent,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    if (userEvent) record.events.push(userEvent);
    // Claude replaces an existing dynamic-loop wakeup when the same loop
    // schedules its next tick. Mirror that behavior so a manually-triggered
    // turn cannot leave two copies of the same wakeup behind.
    const existing = turn.kind === "scheduled_wakeup"
      ? (record.queuedTurns ?? []).filter(
          (queued) =>
            queued.kind !== "scheduled_wakeup" || queued.text !== turn.text,
        )
      : (record.queuedTurns ?? []);
    if (turn.kind === "user") {
      // User messages run as soon as the chat is free, ahead of turns that are
      // waiting on a clock (wakeups, usage resets), but FIFO among themselves.
      // The drain timer follows the head's runAfter, so a delayed head would
      // otherwise hold the user's message back until it fired.
      const userTurns = existing.filter((queued) => queued.kind === "user");
      const delayed = existing.filter((queued) => queued.kind !== "user");
      record.queuedTurns = [...userTurns, turn, ...delayed];
    } else {
      record.queuedTurns = [...existing, turn];
    }
    record.model = turn.model;
    record.permissionMode = turn.permissionMode;
    record.status = computeStatus(record);
    await writeChat(repoPath, record);
    return record;
  });
}

export async function setQueuePaused(
  repoPath: string,
  chatId: string,
  paused: boolean,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    if (paused) record.queuePaused = true;
    else delete record.queuePaused;
    await writeChat(repoPath, record);
    return record;
  });
}

export async function removeQueuedChatTurn(
  repoPath: string,
  chatId: string,
  turnId: string,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    const filtered = (record.queuedTurns ?? []).filter((t) => t.id !== turnId);
    if (filtered.length > 0) record.queuedTurns = filtered;
    else delete record.queuedTurns;
    record.status = computeStatus(record);
    await writeChat(repoPath, record);
    return record;
  });
}

// Reorders the queued user messages to match `turnIds`. Ids that are missing
// from the list keep their relative order after the listed ones; delayed turns
// always stay behind the user messages.
export async function reorderQueuedChatTurns(
  repoPath: string,
  chatId: string,
  turnIds: string[],
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record?.queuedTurns) return record;
    const rank = new Map(turnIds.map((id, i) => [id, i]));
    const userTurns = record.queuedTurns
      .filter((t) => t.kind === "user")
      .map((t, i) => ({ t, key: rank.get(t.id) ?? turnIds.length + i }))
      .sort((a, b) => a.key - b.key)
      .map(({ t }) => t);
    const delayed = record.queuedTurns.filter((t) => t.kind !== "user");
    record.queuedTurns = [...userTurns, ...delayed];
    await writeChat(repoPath, record);
    return record;
  });
}

// Moves a queued turn to the head of the queue and resumes the queue, so the
// drainer runs it next. Returns null when the turn no longer exists.
export async function fastTrackQueuedChatTurn(
  repoPath: string,
  chatId: string,
  turnId: string,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    const turn = record?.queuedTurns?.find((t) => t.id === turnId);
    if (!record || !turn) return null;
    // A fast-tracked turn runs now, so it no longer waits on its clock.
    const promoted = { ...turn, runAfter: new Date().toISOString() };
    record.queuedTurns = [
      promoted,
      ...record.queuedTurns!.filter((t) => t.id !== turnId),
    ];
    delete record.queuePaused;
    await writeChat(repoPath, record);
    return record;
  });
}

export async function shiftQueuedChatTurn(
  repoPath: string,
  chatId: string,
): Promise<{ record: ChatRecord; turn: QueuedChatTurn } | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    const queue = record?.queuedTurns;
    const turn = queue?.[0];
    if (!record || !turn) return null;
    const rest = queue.slice(1);
    if (rest.length > 0) record.queuedTurns = rest;
    else delete record.queuedTurns;
    record.status = computeStatus(record);
    await writeChat(repoPath, record);
    return { record, turn };
  });
}

function applyEventToMeta(record: ChatRecord, event: ChatEvent): void {
  switch (event.type) {
    case "system_init":
      if (event.sessionId) {
        record.sessionId = event.sessionId;
        // Keep per-provider session ids so Claude ↔ Cursor switches are safe.
        const provider = event.model?.startsWith("cursor:")
          ? "cursor"
          : event.model?.startsWith("claude-")
            ? "claude"
            : "openai";
        record.providerSessions = {
          ...record.providerSessions,
          [provider]: event.sessionId,
        };
        // A new turn has started. If it was resuming a truncated history
        // (fork / branch switch / revert), the SDK has now forked the old
        // session into this fresh one, which already ends at the right
        // place — clear the one-shot resume marker.
        delete record.resumeSessionAt;
      }
      break;
    case "result":
      // A turn that failed before running anything (numTurns 0) reports the
      // id of a session that was never written, e.g. the fork of a resume
      // that failed; recording it would make every later turn resume it.
      if (event.sessionId && !(event.subtype !== "success" && event.numTurns === 0)) {
        record.sessionId = event.sessionId;
        const provider = record.model?.startsWith("cursor:")
            ? "cursor"
            : record.model?.startsWith("claude-")
              ? "claude"
              : "openai";
        // Prefer model field when available on the chat record.
        const resolved =
          record.model?.startsWith("cursor:")
            ? "cursor"
            : record.model?.startsWith("claude-")
              ? "claude"
              : provider;
        record.providerSessions = {
          ...record.providerSessions,
          [resolved]: event.sessionId,
        };
      }
      break;
  }
}

// The error message written by recoverStaleChat when a server restart interrupts
// a turn. Used by computeStatus to surface the "error" status to the sidebar.
export const SERVER_RESTART_ERROR_MSG =
  "Turn was interrupted by a server restart.";

// Status priority for sidebar grouping.
//   awaiting_input > running > agent_done > error > idle
// `finished` is set independently when the user marks the chat complete.
export function computeStatus(record: ChatRecord): ChatStatus {
  if (record.userMarkedFinished) return "finished";

  // Walk events from the end to find the most recent state-bearing signal.
  let lastTurnStartIndex = -1;
  let lastTurnEndIndex = -1;
  let lastResultIndex = -1;
  let lastUserMessageIndex = -1;
  const pendingPermissionIds = new Set<string>();
  let hasUserMessageAfterResult = false;
  // Track whether the most recently completed turn ended with a server-restart
  // error so we can surface the "error" status until the user retries/sends.
  let lastTurnWasServerRestartError = false;

  for (let i = 0; i < record.events.length; i++) {
    const ev = record.events[i];
    switch (ev.type) {
      case "turn_start":
        lastTurnStartIndex = i;
        lastTurnWasServerRestartError = false; // reset on each new turn
        break;
      case "turn_end":
        lastTurnEndIndex = i;
        // A turn cannot end while genuinely blocked on a prompt, so any
        // permission request still "open" at this point was actually resolved
        // (or the turn was interrupted) — its response just wasn't persisted.
        // Clearing here stops a lost permission_response from pinning the chat
        // to "awaiting_input" forever with no prompt to show.
        pendingPermissionIds.clear();
        break;
      case "result":
        lastResultIndex = i;
        hasUserMessageAfterResult = false;
        lastTurnWasServerRestartError = false;
        pendingPermissionIds.clear();
        break;
      case "assistant":
      case "user_tool_results":
        // Output arriving after a recovery marker proves the provider did not
        // actually die. Do not leave the chat permanently labelled "error".
        lastTurnWasServerRestartError = false;
        break;
      case "error":
        if (ev.message === SERVER_RESTART_ERROR_MSG) {
          lastTurnWasServerRestartError = true;
        } else {
          lastTurnWasServerRestartError = false;
        }
        break;
      case "permission_request":
        pendingPermissionIds.add(ev.requestId);
        break;
      case "permission_response":
        pendingPermissionIds.delete(ev.requestId);
        break;
      case "user_message":
        lastUserMessageIndex = i;
        if (lastResultIndex >= 0 && i > lastResultIndex)
          hasUserMessageAfterResult = true;
        // A new user message after the restart error means the user already
        // sent a follow-up; clear the error state.
        if (lastTurnWasServerRestartError && lastTurnEndIndex >= 0 && i > lastTurnEndIndex) {
          lastTurnWasServerRestartError = false;
        }
        break;
    }
  }

  if (pendingPermissionIds.size > 0) return "awaiting_input";
  if (lastTurnStartIndex > lastTurnEndIndex) return "running";
  if ((record.queuedTurns?.length ?? 0) > 0) return "queued";
  // Surface "error" only when the restart error is the latest thing that
  // happened in the chat (no user message has come in after the turn_end).
  if (
    lastTurnWasServerRestartError &&
    (lastUserMessageIndex < 0 || lastUserMessageIndex < lastTurnEndIndex)
  ) {
    return "error";
  }
  if (lastResultIndex >= 0 && !hasUserMessageAfterResult) return "agent_done";
  return "idle";
}

export async function listChats(repoPath: string): Promise<ChatSummary[]> {
  const index = await ensureIndexLoaded(repoPath);
  // Cheap readdir-based reconcile so externally added/removed chats still show
  // up without re-reading every transcript.
  await reconcileIndexWithDisk(repoPath, index);
  return [...index.values()].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

// Force a full rescan into the index and flush it to disk immediately. Used by
// recovery paths that rewrite chat files out-of-band.
export async function rebuildIndex(repoPath: string): Promise<void> {
  const map = new Map<string, ChatSummary>();
  for (const s of await scanChatSummaries(repoPath)) map.set(s.id, s);
  indexCache.set(repoPath, map);
  await writeJson(indexPath(repoPath), {
    version: INDEX_VERSION,
    chats: [...map.values()],
  } satisfies PersistedIndex);
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
    status: computeStatus(record),
    userMarkedFinished: record.userMarkedFinished,
    sessionId: record.sessionId,
    model: record.model,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    preview: previewParts.join(" ").slice(0, 600),
    ...(record.starred ? { starred: true } : {}),
    ...(record.kind ? { kind: record.kind } : {}),
    ...(record.parentChatId ? { parentChatId: record.parentChatId } : {}),
    ...(record.task ? { task: record.task } : {}),
    ...(record.queuedTurns?.[0]
      ? { queuedTurn: { runAfter: record.queuedTurns[0].runAfter } }
      : {}),
    ...(record.queuePaused ? { queuePaused: true } : {}),
    ...(record.keepWarm ? { keepWarm: true } : {}),
    ...(record.keepWarmUntil ? { keepWarmUntil: record.keepWarmUntil } : {}),
    ...(record.cost?.lastApiAt ? { lastApiAt: record.cost.lastApiAt } : {}),
    ...(record.handoffTo ? { continuedInChatId: record.handoffTo.chatId } : {}),
  };
}

export async function setUserFinished(
  repoPath: string,
  chatId: string,
  finished: boolean,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    record.userMarkedFinished = finished;
    record.status = computeStatus(record);
    await writeChat(repoPath, record);
    return record;
  });
}

export async function setTitle(
  repoPath: string,
  chatId: string,
  title: string,
  auto: boolean,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    // The coordinator chat is permanently titled "Coordinator".
    if (record.kind === "coordinator") return record;
    record.title = title;
    record.titleAuto = auto;
    await writeChat(repoPath, record);
    return record;
  });
}

export async function setStarred(
  repoPath: string,
  chatId: string,
  starred: boolean,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    if (starred) record.starred = true;
    else delete record.starred;
    await writeChat(repoPath, record);
    return record;
  });
}

// Records (or clears, when passed null) the isolated git worktree a code-editing
// subagent runs in. Kept on the chat record so it survives a backend restart and
// can be merged back / cleaned up later.
export async function setWorktreeInfo(
  repoPath: string,
  chatId: string,
  info: { path: string; branch: string } | null,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    if (info) {
      record.worktreePath = info.path;
      record.worktreeBranch = info.branch;
    } else {
      delete record.worktreePath;
      delete record.worktreeBranch;
    }
    await writeChat(repoPath, record);
    return record;
  });
}

export async function setModel(
  repoPath: string,
  chatId: string,
  model: string,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    record.model = model as Model;
    await writeChat(repoPath, record);
    return record;
  });
}

// Persists a mode change made from the composer, so a later replay (chat
// switch, reconnect) restores the mode the user picked rather than the one the
// last turn started with.
export async function setChatPermissionMode(
  repoPath: string,
  chatId: string,
  permissionMode: PermissionMode,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    if (record.permissionMode === permissionMode) return record;
    record.permissionMode = permissionMode;
    await writeChat(repoPath, record);
    return record;
  });
}

// Persists the chat's running cost (see ChatCost). The session owns the
// numbers in memory and writes whole snapshots, so a stale write can never
// double-count.
export async function saveChatCost(
  repoPath: string,
  chatId: string,
  cost: ChatCost,
): Promise<void> {
  await withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return;
    record.cost = cost;
    await writeChat(repoPath, record);
  });
}

/** Warmth is a budget with a deadline, not a switch (see ChatRecord.keepWarmUntil):
 *    - `false` spends it immediately: pings stop now.
 *    - `true` starts a fresh KEEP_WARM_BUDGET_HOURS budget, or leaves a running
 *      one alone (it's the idempotent "make sure this is on").
 *    - `{ addHours }` tops the budget up, from now if it had already run out.
 *  Always writes keepWarm and keepWarmUntil together so nothing downstream can
 *  see one without the other. */
export async function setKeepWarm(
  repoPath: string,
  chatId: string,
  update: boolean | { addHours: number },
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    if (update === false) {
      delete record.keepWarm;
      delete record.keepWarmUntil;
    } else {
      const now = Date.now();
      const current = Date.parse(record.keepWarmUntil ?? "");
      const live = Number.isFinite(current) && current > now ? current : 0;
      const until =
        update === true
          ? live || now + KEEP_WARM_BUDGET_HOURS * 3_600_000
          : (live || now) + update.addHours * 3_600_000;
      record.keepWarm = true;
      record.keepWarmUntil = new Date(until).toISOString();
    }
    await writeChat(repoPath, record);
    return record;
  });
}

// Links an old chat to the fresh one that continues it (handoff).
export async function setHandoffTo(
  repoPath: string,
  chatId: string,
  handoffTo: ChatHandoffTo,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    record.handoffTo = handoffTo;
    await writeChat(repoPath, record);
    return record;
  });
}

export async function setContext1m(
  repoPath: string,
  chatId: string,
  enabled: boolean,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;
    if (enabled) record.context1m = true;
    else delete record.context1m;
    await writeChat(repoPath, record);
    return record;
  });
}

// On server startup, any chat persisted as `running` or `awaiting_input` is
// lying — the process owning that turn died with the previous server, and
// no one is listening on its permission resolvers. Patch the transcript:
// deny outstanding permission requests and close any open turn so
// computeStatus() resolves the chat to `idle`/`agent_done` instead.
export async function recoverStaleChat(
  repoPath: string,
  chatId: string,
): Promise<boolean> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return false;

    const pendingPermissionIds = new Set<string>();
    let openTurn = false;
    for (const ev of record.events) {
      if (ev.type === "permission_request") pendingPermissionIds.add(ev.requestId);
      else if (ev.type === "permission_response") pendingPermissionIds.delete(ev.requestId);
      else if (ev.type === "turn_start") openTurn = true;
      else if (ev.type === "turn_end") openTurn = false;
    }

    if (pendingPermissionIds.size === 0 && !openTurn) {
      // Older recovery races could leave a closed transcript's stored status
      // at "error" even though later provider output proves the turn survived.
      // Recompute and persist that metadata so the sidebar index self-heals as
      // well as the full replay.
      const correctedStatus = computeStatus(record);
      if (correctedStatus === record.status) return false;
      record.status = correctedStatus;
      await writeChat(repoPath, record);
      return true;
    }

    const ts = new Date().toISOString();
    for (const requestId of pendingPermissionIds) {
      record.events.push({
        type: "permission_response",
        requestId,
        result: { behavior: "deny", message: "Server restarted", interrupt: true },
        ts,
      });
    }
    if (openTurn) {
      record.events.push({
        type: "error",
        message: "Turn was interrupted by a server restart.",
        ts,
      });
      record.events.push({ type: "turn_end", ts });
    }
    record.status = computeStatus(record);
    await writeChat(repoPath, record);
    return true;
  });
}

export async function recoverStaleChatsForRepo(repoPath: string): Promise<number> {
  const ids = await recoverStaleChatsForRepoWithIds(repoPath);
  return ids.length;
}

/** Like recoverStaleChatsForRepo but returns the chatIds that were healed. */
export async function recoverStaleChatsForRepoWithIds(repoPath: string): Promise<string[]> {
  const dir = chatsDir(repoPath);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const recovered: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "index.json") continue;
    if (entry.includes(".tmp-")) continue;
    const chatId = entry.slice(0, -".json".length);
    try {
      if (await recoverStaleChat(repoPath, chatId)) recovered.push(chatId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[chats] failed to recover ${entry}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  // Always rebuild the index from disk after a recovery sweep. The startup
  // queue drainer (scheduleQueuedTurnsForRepo) now reads queued-turn scheduling
  // metadata from the summary index instead of every transcript, and a crash
  // can leave index.json lagging the per-chat files by up to the persist
  // debounce window. A fresh rebuild guarantees wakeups/retries persisted just
  // before the crash are rescheduled on boot. This sweep already read every
  // chat file, so the extra scan is startup-only and off the hot path.
  await rebuildIndex(repoPath);
  return recovered;
}

export class CoordinatorDeleteError extends Error {
  constructor() {
    super("The coordinator chat cannot be deleted");
    this.name = "CoordinatorDeleteError";
  }
}

export async function deleteChat(
  repoPath: string,
  chatId: string,
): Promise<boolean> {
  // The coordinator chat is permanent — refuse deletion at the lowest level
  // so no API path can remove it.
  const record = await readChat(repoPath, chatId).catch(() => null);
  if (record?.kind === "coordinator") throw new CoordinatorDeleteError();
  try {
    await unlink(chatFilePath(repoPath, chatId));
    const index = await ensureIndexLoaded(repoPath);
    if (index.delete(chatId)) schedulePersistIndex(repoPath, index);
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

export type AttachmentForEvent = Attachment;

// ---- Branching / forking ----

/**
 * Find the most recent SDK message in `events` — assistant or
 * user_tool_results, the only event types carrying SDK message uuids — so
 * fork / branch-switch / revert can re-point the next turn's session resume
 * at it.
 */
function lastSdkMessageRef(
  events: ChatEvent[],
): { uuid: string; sessionId: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      (e.type === "assistant" || e.type === "user_tool_results") &&
      e.uuid &&
      e.sessionId
    ) {
      return { uuid: e.uuid, sessionId: e.sessionId };
    }
  }
  return null;
}

/**
 * Re-anchor the record's SDK session at the last message still present in
 * its (just truncated / spliced) trunk. Without this, the next turn would
 * `resume` the old SDK session in full and the model would see every message
 * the truncation was supposed to remove. The next turn passes
 * `resumeSessionAt` (+ forkSession) to the SDK so the resumed history is cut
 * at exactly this message; if no SDK message remains (e.g. the very first
 * user message was edited), the session is cleared so a fresh one starts.
 */
function reanchorSession(record: ChatRecord): void {
  const ref = lastSdkMessageRef(record.events);
  if (ref) {
    record.sessionId = ref.sessionId;
    record.resumeSessionAt = ref.uuid;
  } else {
    delete record.sessionId;
    delete record.resumeSessionAt;
  }
}

// ---- Resuming Claude after other providers ----

export interface ClaudeResumePlan {
  /** Claude SDK session to resume; undefined starts a fresh one. */
  sessionId?: string;
  /** Cut the resumed session at this SDK message uuid (forks it). */
  resumeSessionAt?: string;
  /**
   * Transcript of what happened in the chat that the Claude session never
   * saw: turns run by Cursor / Codex since Claude's last message, or the
   * whole chat when there is no Claude session to resume. Prepended to the
   * prompt.
   */
  history?: string;
}

const nonClaudeSessionPrefix = /^(appserver:|codex-|cursor-|openai-)/;

/**
 * Works out how the next Claude turn resumes. A chat can move between
 * providers, and every provider's message uuids and session ids live in the
 * same event list, so the record's top-level `sessionId` / `resumeSessionAt`
 * can point at a Cursor or Codex message. Passing one of those to the Claude
 * SDK fails before the turn starts ("error during execution"). Instead, the
 * Claude session is anchored at the last message Claude itself produced, and
 * the other providers' turns after it are handed over as a transcript.
 */
export function planClaudeResume(record: ChatRecord): ClaudeResumePlan {
  const events = record.events;
  let turnProvider: ModelProvider = "claude";
  const claudeUuids = new Set<string>();
  let lastClaude = -1;
  let foreignAfterLastClaude = false;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === "system_init") {
      turnProvider = e.model ? getModelProvider(e.model) : "claude";
    } else if ((e.type === "assistant" || e.type === "user_tool_results") && e.uuid && e.sessionId) {
      if (turnProvider === "claude") {
        claudeUuids.add(e.uuid);
        lastClaude = i;
        foreignAfterLastClaude = false;
      } else {
        foreignAfterLastClaude = true;
      }
    }
  }

  if (lastClaude >= 0 && foreignAfterLastClaude) {
    const anchor = events[lastClaude] as { uuid: string; sessionId: string };
    return {
      sessionId: anchor.sessionId,
      resumeSessionAt: anchor.uuid,
      history: chatTranscript(events.slice(lastClaude + 1), 40_000),
    };
  }

  // Prefer the Claude-specific session id so a prior Cursor / Codex turn
  // cannot poison Claude SDK resume. Fall back to the legacy top-level
  // sessionId only when it is genuinely a Claude handle: it must not equal
  // either other provider's stored id (robust for current records) and must
  // not carry a known non-Claude id prefix (covers legacy records written
  // before per-provider tracking). Codex ids are `appserver:` / `codex-`,
  // Cursor ids may be `cursor-`.
  const sessionId =
    record.providerSessions?.claude ??
    (record.sessionId &&
    !nonClaudeSessionPrefix.test(record.sessionId) &&
    record.providerSessions?.cursor !== record.sessionId &&
    record.providerSessions?.openai !== record.sessionId
      ? record.sessionId
      : undefined);
  // The one-shot marker set by fork / branch-switch / revert only applies
  // when it names a message in a Claude session.
  const resumeSessionAt =
    sessionId && record.resumeSessionAt && claudeUuids.has(record.resumeSessionAt)
      ? record.resumeSessionAt
      : undefined;
  const history =
    !sessionId && events.some((e) => e.type === "user_message" || e.type === "assistant")
      ? chatTranscript(events, 12_000)
      : undefined;
  return { sessionId, resumeSessionAt, history };
}

/**
 * Plain-text transcript of user messages, assistant replies and the tools the
 * assistant ran, keeping the most recent `maxChars`.
 */
function chatTranscript(events: ChatEvent[], maxChars: number): string | undefined {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.type === "user_message") lines.push(`User: ${ev.text}`);
    else if (ev.type === "assistant") {
      const parts: string[] = [];
      for (const b of ev.content) {
        if (b.type === "text" && b.text.trim()) parts.push(b.text);
        else if (b.type === "tool_use") {
          const input = b.input as Record<string, unknown> | undefined;
          const detail =
            typeof input?.command === "string" ? input.command : JSON.stringify(input ?? {});
          parts.push(`[${b.name}: ${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}]`);
        }
      }
      if (parts.length) lines.push(`Assistant: ${parts.join("\n")}`);
    }
  }
  if (!lines.length) return undefined;
  const body = lines.join("\n\n");
  return body.length > maxChars ? body.slice(-maxChars) : body;
}

function makeBranchId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `br_${ts}${rand}`;
}

export interface ForkResult {
  record: ChatRecord;
  branchId: string;    // ID of the branch that now holds the old trunk events
  newMessageId: string; // ID of the new user_message appended to the trunk
}

/**
 * Fork the conversation at the given user_message event. All events from
 * that message onwards are moved into a new ChatBranch (saved in
 * record.branches). A fresh user_message with newText is then appended to
 * the trunk (record.events) so the caller can kick off a new agent turn.
 *
 * Returns null when the chat or message is not found.
 */
export async function forkAtMessage(
  repoPath: string,
  chatId: string,
  userMessageId: string,
  newText: string,
  attachments?: Attachment[],
): Promise<ForkResult | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;

    const splitIdx = record.events.findIndex(
      (e) => e.type === "user_message" && e.id === userMessageId,
    );
    if (splitIdx === -1) return null; // message not found / already branched away

    // Slice the old trunk from the fork point onwards into a new branch.
    const branchedEvents = record.events.slice(splitIdx);
    const branchId = makeBranchId();
    const now = new Date().toISOString();
    const newBranch: ChatBranch = {
      id: branchId,
      parentMessageId: userMessageId,
      events: branchedEvents,
      createdAt: now,
    };

    // Truncate the trunk and append the edited user message.
    const newMessageId = `u-${Date.now()}`;
    const newUserEvent: ChatEvent = {
      type: "user_message",
      id: newMessageId,
      text: newText,
      attachments,
      ts: now,
    };
    record.events = [...record.events.slice(0, splitIdx), newUserEvent];
    record.branches = [...(record.branches ?? []), newBranch];
    // Cut the SDK session at the last message still in the trunk so the
    // model doesn't see the edited-away events on the next turn.
    reanchorSession(record);
    record.status = computeStatus(record);

    await writeChat(repoPath, record);
    return { record, branchId, newMessageId };
  });
}

/**
 * Fork a whole chat into a new one: copies its history (trunk and branches)
 * and anchors the copy's next turn at the source's last SDK message, so the
 * SDK forks the session instead of both chats appending to the same one.
 * Non-Claude chats (no SDK message uuids) start a fresh provider session.
 *
 * Returns null when the source chat is not found.
 */
export async function forkChat(
  repoPath: string,
  chatId: string,
): Promise<ChatRecord | null> {
  const source = await readChat(repoPath, chatId);
  if (!source) return null;
  const fork = await createChat(repoPath, {
    model: source.model,
    permissionMode: source.permissionMode,
    title: `Fork: ${source.title}`.slice(0, 60),
    worktreePath: source.worktreePath,
    worktreeBranch: source.worktreeBranch,
    context1m: source.context1m,
  });
  return withChatLock(repoPath, fork.id, async () => {
    fork.events = structuredClone(source.events);
    if (source.branches) fork.branches = structuredClone(source.branches);
    if (source.lastContextUsage) fork.lastContextUsage = source.lastContextUsage;
    reanchorSession(fork);
    if (fork.sessionId) fork.providerSessions = { claude: fork.sessionId };
    fork.status = computeStatus(fork);
    await writeChat(repoPath, fork);
    return fork;
  });
}

/**
 * Switch the active branch at a fork point. The current trunk events from
 * parentMessageId onwards are saved as a new branch, and the target branch's
 * events replace them in record.events.
 *
 * Returns null when the chat or branch is not found.
 */
export async function switchBranch(
  repoPath: string,
  chatId: string,
  parentMessageId: string,
  targetBranchId: string,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;

    const splitIdx = record.events.findIndex(
      (e) => e.type === "user_message" && e.id === parentMessageId,
    );
    // If the parentMessageId is not in the current trunk, it might be that the
    // branch's first event IS the parentMessageId — look it up there.
    // Either way we need the split index relative to current record.events.
    // When switching, the parentMessageId may not be in the trunk at all if
    // the trunk already diverged at an earlier point. Tolerate this by
    // searching branches for context.
    if (splitIdx === -1) return null;

    const targetBranch = (record.branches ?? []).find((b) => b.id === targetBranchId);
    if (!targetBranch) return null;

    // Save the current trunk slice as a new branch.
    const currentTrunkSlice = record.events.slice(splitIdx);
    const newBranchId = makeBranchId();
    const now = new Date().toISOString();
    const currentAsBranch: ChatBranch = {
      id: newBranchId,
      parentMessageId,
      events: currentTrunkSlice,
      createdAt: now,
    };

    // Swap: remove target branch, add current-as-branch, splice target events in.
    record.branches = [
      ...(record.branches ?? []).filter((b) => b.id !== targetBranchId),
      currentAsBranch,
    ];
    record.events = [...record.events.slice(0, splitIdx), ...targetBranch.events];
    // Re-point the SDK session at the last message of the branch we just
    // switched to — its events carry the sessionId/uuid they were produced
    // under. Otherwise the next turn would resume the other branch's session.
    reanchorSession(record);
    record.status = computeStatus(record);

    await writeChat(repoPath, record);
    return record;
  });
}

// ---- Checkpoint revert ----

/**
 * Revert the conversation to just before the given checkpoint.
 *
 * 1. Truncates record.events to everything before the revert_checkpoint event.
 * 2. Restores all snapshotted files for this checkpoint and every later one
 *    (so multi-turn file changes are all undone together).
 * 3. Deletes the now-stale snapshot directories.
 *
 * Returns the updated ChatRecord, or null if the chat / checkpoint is missing.
 */
export async function revertToCheckpoint(
  repoPath: string,
  chatId: string,
  checkpointId: string,
): Promise<ChatRecord | null> {
  return withChatLock(repoPath, chatId, async () => {
    const record = await readChat(repoPath, chatId);
    if (!record) return null;

    // Find the revert_checkpoint event with the matching id.
    const idx = record.events.findIndex(
      (e) => e.type === "revert_checkpoint" &&
        (e as Extract<typeof e, { type: "revert_checkpoint" }>).checkpointId === checkpointId,
    );
    if (idx === -1) return null;

    // Drop the checkpoint event and everything that came after it.
    record.events = record.events.slice(0, idx);
    // Cut the SDK session at the last surviving message so the next turn
    // doesn't resume the full pre-revert history.
    reanchorSession(record);
    record.status = computeStatus(record);
    await writeChat(repoPath, record);

    // Restore files — best-effort so a missing snapshot dir never blocks the
    // chat truncation that already succeeded above.
    await restoreFromCheckpoint(repoPath, chatId, checkpointId).catch((err) => {
      console.warn("[revert] restoreFromCheckpoint failed:", err);
    });
    await pruneSnapshotsFrom(repoPath, chatId, checkpointId).catch((err) => {
      console.warn("[revert] pruneSnapshotsFrom failed:", err);
    });

    return record;
  });
}
