/**
 * dashboard.ts — Global dashboard persistence.
 *
 * Stores notes and todos in ~/.buildover/dashboard.json. Uses the same
 * atomic-write pattern as chats.ts so the file is never left half-written.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BUILDOVER_DIR = join(homedir(), ".buildover");
const DASHBOARD_FILE = join(BUILDOVER_DIR, "dashboard.json");

// ── Types ──────────────────────────────────────────────────────────────────

export interface DashboardNote {
  id: string;
  content: string;   // Markdown
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  priority: "low" | "medium" | "high";
  createdAt: string;
  updatedAt: string;
}

export interface Dashboard {
  notes: DashboardNote[];
  todos: TodoItem[];
  updatedAt: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}${rand}`;
}

function now(): string {
  return new Date().toISOString();
}

function emptyDashboard(): Dashboard {
  return { notes: [], todos: [], updatedAt: now() };
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

// ── Serialised write lock ──────────────────────────────────────────────────

let writeLock: Promise<unknown> = Promise.resolve();

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve!: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    resolve();
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function readDashboard(): Promise<Dashboard> {
  try {
    const raw = await readFile(DASHBOARD_FILE, "utf8");
    return JSON.parse(raw) as Dashboard;
  } catch (err: any) {
    if (err?.code === "ENOENT") return emptyDashboard();
    throw err;
  }
}

async function writeDashboard(db: Dashboard): Promise<void> {
  await mkdir(BUILDOVER_DIR, { recursive: true });
  db.updatedAt = now();
  await atomicWrite(DASHBOARD_FILE, db);
}

// ── Notes ──────────────────────────────────────────────────────────────────

export async function addNote(
  content: string,
  pinned = false,
): Promise<DashboardNote> {
  return withLock(async () => {
    const db = await readDashboard();
    const note: DashboardNote = {
      id: makeId("note"),
      content,
      pinned,
      createdAt: now(),
      updatedAt: now(),
    };
    db.notes.unshift(note);
    await writeDashboard(db);
    return note;
  });
}

export async function updateNote(
  id: string,
  patch: Partial<Pick<DashboardNote, "content" | "pinned">>,
): Promise<DashboardNote | null> {
  return withLock(async () => {
    const db = await readDashboard();
    const note = db.notes.find((n) => n.id === id);
    if (!note) return null;
    if (patch.content !== undefined) note.content = patch.content;
    if (patch.pinned !== undefined) note.pinned = patch.pinned;
    note.updatedAt = now();
    await writeDashboard(db);
    return note;
  });
}

export async function deleteNote(id: string): Promise<boolean> {
  return withLock(async () => {
    const db = await readDashboard();
    const before = db.notes.length;
    db.notes = db.notes.filter((n) => n.id !== id);
    if (db.notes.length === before) return false;
    await writeDashboard(db);
    return true;
  });
}

// ── Todos ──────────────────────────────────────────────────────────────────

export async function addTodo(
  text: string,
  priority: TodoItem["priority"] = "medium",
): Promise<TodoItem> {
  return withLock(async () => {
    const db = await readDashboard();
    const todo: TodoItem = {
      id: makeId("todo"),
      text,
      done: false,
      priority,
      createdAt: now(),
      updatedAt: now(),
    };
    db.todos.unshift(todo);
    await writeDashboard(db);
    return todo;
  });
}

export async function updateTodo(
  id: string,
  patch: Partial<Pick<TodoItem, "text" | "done" | "priority">>,
): Promise<TodoItem | null> {
  return withLock(async () => {
    const db = await readDashboard();
    const todo = db.todos.find((t) => t.id === id);
    if (!todo) return null;
    if (patch.text !== undefined) todo.text = patch.text;
    if (patch.done !== undefined) todo.done = patch.done;
    if (patch.priority !== undefined) todo.priority = patch.priority;
    todo.updatedAt = now();
    await writeDashboard(db);
    return todo;
  });
}

export async function deleteTodo(id: string): Promise<boolean> {
  return withLock(async () => {
    const db = await readDashboard();
    const before = db.todos.length;
    db.todos = db.todos.filter((t) => t.id !== id);
    if (db.todos.length === before) return false;
    await writeDashboard(db);
    return true;
  });
}
