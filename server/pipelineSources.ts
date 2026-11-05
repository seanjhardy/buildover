import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PIPELINES_DIR } from "./pageTools.js";

// Pipeline sources: where work items come from. The engine is generic; what a
// source queries (SQL, a script) lives in the private config file
// <pipelines dir>/sources.json, never in this repo.

export const SOURCES_FILE = join(PIPELINES_DIR, "sources.json");
export const SETTINGS_FILE = join(PIPELINES_DIR, "config.json");

/** One work item as a source reports it. */
export interface SourceRow {
  id: string;
  title: string;
  url?: string;
  data?: unknown;
}

/** Read-only SQL on a Supabase project through the Management API. */
export interface SupabaseFetch {
  kind: "supabase";
  ref: string;
  /** Returns SourceRow columns. Rolling sources get {seen} (a text[] of every key it has
   *  ever produced) and {room} (how many to add). */
  query: string;
  /** Rolling sources: returns {id, closed} for {ids} (a text[] of the open keys).
   *  A key missing from the result counts as closed. */
  checkQuery?: string;
  token?: TokenSource;
}

/** A command printing a JSON array of rows. Gets SEEN/ROOM (or IDS for the check) as JSON env vars. */
export interface CommandFetch {
  kind: "command";
  command: string;
  checkCommand?: string;
}

export interface TokenSource {
  env?: string;
  /** A file holding the token; `pattern` (one capture group) picks it out, else the whole file. */
  file?: string;
  pattern?: string;
}

export interface SourceConfig {
  id: string;
  name: string;
  /** The buildover repo its chats live in. */
  repoPath: string;
  everyMinutes?: number;
  fetch: SupabaseFetch | CommandFetch;
  /** Absent: the query returns every open item and one that drops out is closed.
   *  Set: keep `active` items open at a time, topping up from the query. */
  rolling?: { active: number };
  /** Fields of `data` shown to the ranker, e.g. ["priority", "type", "due"]. */
  facts?: string[];
  /** Extra instructions for this source's agents. */
  prompt?: string;
  model?: string;
}

export interface PipelineSettings {
  sweeps?: string[];
  /** Background research agents at once, across all sources. */
  maxAgents?: number;
  /** Needs-you windows per source on the canvas. */
  slots?: number;
  model?: string;
  rankModel?: string;
  budget?: {
    /** Weekly cap in API dollars. Absent: `share` of one subscription's weekly limit. */
    weeklyUsd?: number;
    share?: number;
    warnAt?: number;
  };
}

const home = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function loadSources(file = SOURCES_FILE): SourceConfig[] {
  const raw = readJson<{ sources?: SourceConfig[] }>(file);
  return (raw?.sources ?? [])
    .filter((s) => s && typeof s.id === "string" && typeof s.repoPath === "string" && s.fetch)
    .map((s) => ({ ...s, name: s.name || s.id, repoPath: home(s.repoPath) }));
}

export function loadSettings(file = SETTINGS_FILE): PipelineSettings {
  return readJson<PipelineSettings>(file) ?? {};
}

// ── Fetching ────────────────────────────────────────────────────────────────

const textArray = (keys: string[]) =>
  keys.length ? `array[${keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(",")}]::text[]` : "array[]::text[]";

/** Fill {seen}, {ids} and {room} in a query. */
export function fillQuery(query: string, vars: { seen?: string[]; ids?: string[]; room?: number }): string {
  return query
    .replace(/\{seen\}/g, textArray(vars.seen ?? []))
    .replace(/\{ids\}/g, textArray(vars.ids ?? []))
    .replace(/\{room\}/g, String(Math.max(0, Math.floor(vars.room ?? 0))));
}

function readToken(t: TokenSource | undefined): string | null {
  const envName = t?.env ?? "SUPABASE_ACCESS_TOKEN";
  if (process.env[envName]) return process.env[envName]!;
  if (!t?.file) return null;
  try {
    const text = readFileSync(home(t.file), "utf8");
    if (!t.pattern) return text.trim() || null;
    return text.match(new RegExp(t.pattern))?.[1] ?? null;
  } catch {
    return null;
  }
}

async function supabaseQuery<T>(f: SupabaseFetch, query: string): Promise<T[]> {
  const token = readToken(f.token);
  if (!token) throw new Error(`No Supabase management token for ${f.ref}`);
  const res = await fetch(`https://api.supabase.com/v1/projects/${f.ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, read_only: true }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Query on ${f.ref} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as T[];
}

function runCommand<T>(command: string, env: Record<string, string>): Promise<T[]> {
  return new Promise((resolve, reject) => {
    execFile("sh", ["-c", command], { env: { ...process.env, ...env }, timeout: 120_000, maxBuffer: 20 << 20 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout) as T[]);
      } catch (e) {
        reject(new Error(`Source command didn't print JSON: ${(e as Error).message}`));
      }
    });
  });
}

/** The source's items (all open ones, or for a rolling source up to `room` unseen ones). */
export function fetchRows(src: SourceConfig, vars: { seen: string[]; room: number }): Promise<SourceRow[]> {
  const f = src.fetch;
  const rows =
    f.kind === "supabase"
      ? supabaseQuery<SourceRow>(f, fillQuery(f.query, vars))
      : runCommand<SourceRow>(f.command, { SEEN: JSON.stringify(vars.seen), ROOM: String(vars.room) });
  return rows.then((list) => list.filter((r) => r && r.id != null).map((r) => ({ ...r, id: String(r.id), title: String(r.title ?? r.id) })));
}

/** For a rolling source: which of its open keys are closed (or gone) at the source. */
export async function checkClosed(src: SourceConfig, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const f = src.fetch;
  const query = f.kind === "supabase" ? f.checkQuery : f.checkCommand;
  if (!query) return new Set();
  const rows =
    f.kind === "supabase"
      ? await supabaseQuery<{ id: unknown; closed: unknown }>(f, fillQuery(query, { ids }))
      : await runCommand<{ id: unknown; closed: unknown }>(query, { IDS: JSON.stringify(ids) });
  return closedKeys(ids, rows);
}

/** Keys missing from the check, or reported closed. */
export function closedKeys(ids: string[], rows: Array<{ id: unknown; closed: unknown }>): Set<string> {
  const open = new Set(rows.filter((r) => !r.closed).map((r) => String(r.id)));
  return new Set(ids.filter((id) => !open.has(id)));
}
