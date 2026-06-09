/**
 * schedules.ts — Cron-style scheduled tasks.
 *
 * Tasks are persisted in ~/.buildover/schedules.json. On each trigger,
 * a message is sent to the specified chat (or a new chat is created) using
 * the same runTurn path as a regular user message.
 *
 * Uses node-cron for scheduling. The scheduler must be started once via
 * startScheduler() after the server is ready.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import cron from "node-cron";
import { createChat } from "./chats.js";
import { getSession } from "./sessions.js";
import { getRepoMeta } from "./repos.js";
import type { Model, PermissionMode } from "../src/types.js";

const BUILDOVER_DIR = join(homedir(), ".buildover");
const SCHEDULES_FILE = join(BUILDOVER_DIR, "schedules.json");

// ── Types ──────────────────────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  label: string;
  /** Standard 5-field cron expression, e.g. "0 9 * * 1-5" */
  cronExpression: string;
  prompt: string;
  repoPath: string;
  /** If set, sends to this existing chat. If omitted, creates a new chat. */
  chatId?: string;
  model: Model;
  permissionMode: PermissionMode;
  enabled: boolean;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleList {
  tasks: ScheduledTask[];
  updatedAt: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `sched_${ts}${rand}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

let writeLock: Promise<unknown> = Promise.resolve();
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve!: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  await prev.catch(() => undefined);
  try { return await fn(); } finally { resolve(); }
}

// ── Persistence ────────────────────────────────────────────────────────────

export async function readSchedules(): Promise<ScheduleList> {
  try {
    const raw = await readFile(SCHEDULES_FILE, "utf8");
    return JSON.parse(raw) as ScheduleList;
  } catch (err: any) {
    if (err?.code === "ENOENT") return { tasks: [], updatedAt: nowIso() };
    throw err;
  }
}

async function writeSchedules(list: ScheduleList): Promise<void> {
  await mkdir(BUILDOVER_DIR, { recursive: true });
  list.updatedAt = nowIso();
  await atomicWrite(SCHEDULES_FILE, list);
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export interface NewTaskOpts {
  label: string;
  cronExpression: string;
  prompt: string;
  repoPath: string;
  chatId?: string;
  model?: Model;
  permissionMode?: PermissionMode;
  enabled?: boolean;
}

export async function createTask(opts: NewTaskOpts): Promise<ScheduledTask> {
  if (!cron.validate(opts.cronExpression)) {
    throw new Error(`Invalid cron expression: "${opts.cronExpression}"`);
  }
  return withLock(async () => {
    const list = await readSchedules();
    const task: ScheduledTask = {
      id: makeId(),
      label: opts.label,
      cronExpression: opts.cronExpression,
      prompt: opts.prompt,
      repoPath: opts.repoPath,
      chatId: opts.chatId,
      model: opts.model ?? "claude-opus-4-8",
      permissionMode: opts.permissionMode ?? "default",
      enabled: opts.enabled ?? true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    list.tasks.push(task);
    await writeSchedules(list);
    // Register the new task immediately.
    registerTask(task);
    return task;
  });
}

export async function updateTask(
  id: string,
  patch: Partial<Omit<ScheduledTask, "id" | "createdAt">>,
): Promise<ScheduledTask | null> {
  if (patch.cronExpression && !cron.validate(patch.cronExpression)) {
    throw new Error(`Invalid cron expression: "${patch.cronExpression}"`);
  }
  return withLock(async () => {
    const list = await readSchedules();
    const task = list.tasks.find((t) => t.id === id);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: nowIso() });
    await writeSchedules(list);
    // Re-register so the new expression / enabled state takes effect.
    unregisterTask(id);
    registerTask(task);
    return task;
  });
}

export async function deleteTask(id: string): Promise<boolean> {
  return withLock(async () => {
    const list = await readSchedules();
    const before = list.tasks.length;
    list.tasks = list.tasks.filter((t) => t.id !== id);
    if (list.tasks.length === before) return false;
    unregisterTask(id);
    await writeSchedules(list);
    return true;
  });
}

// ── Scheduler ─────────────────────────────────────────────────────────────

/** Map of task id → active cron job */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeJobs = new Map<string, any>();

function unregisterTask(id: string): void {
  const job = activeJobs.get(id);
  if (job) {
    job.stop();
    activeJobs.delete(id);
  }
}

function registerTask(task: ScheduledTask): void {
  if (!task.enabled) return;
  if (!cron.validate(task.cronExpression)) return;

  const job = cron.schedule(task.cronExpression, () => {
    void runTask(task.id);
  });
  activeJobs.set(task.id, job);
}

async function runTask(id: string): Promise<void> {
  // Re-read from disk so we always get the latest prompt/model/etc.
  const list = await readSchedules();
  const task = list.tasks.find((t) => t.id === id);
  if (!task || !task.enabled) return;

  // eslint-disable-next-line no-console
  console.log(`[schedules] firing task "${task.label}" (${task.id})`);

  try {
    let chatId = task.chatId;

    // If no specific chat is configured, create a new one.
    if (!chatId) {
      const meta = await getRepoMeta(task.repoPath);
      if (!meta) {
        console.error(`[schedules] repo not found: ${task.repoPath}`);
        return;
      }
      const record = await createChat(task.repoPath, {
        model: task.model,
        permissionMode: task.permissionMode,
      });
      chatId = record.id;
    }

    const session = getSession(task.repoPath, chatId);
    await session.runTurn({
      text: task.prompt,
      model: task.model,
      permissionMode: task.permissionMode,
    });

    // Persist the lastRunAt timestamp.
    await withLock(async () => {
      const current = await readSchedules();
      const t = current.tasks.find((x) => x.id === id);
      if (t) {
        t.lastRunAt = nowIso();
        t.updatedAt = nowIso();
        await writeSchedules(current);
      }
    });
  } catch (err) {
    console.error(
      `[schedules] task "${task.label}" failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Call once on server startup to register all persisted enabled tasks. */
export async function startScheduler(): Promise<void> {
  const list = await readSchedules();
  for (const task of list.tasks) {
    if (task.enabled) registerTask(task);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[schedules] started — ${list.tasks.filter((t) => t.enabled).length} active task(s)`,
  );
}
