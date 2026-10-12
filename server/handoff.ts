/**
 * Handoff to a fresh chat: when a chat's context has grown large (or gone
 * cold), continue the work in a new chat seeded with a short note instead of
 * re-sending the whole history on every call.
 *
 * Two ways to produce the note, chosen by whether the prompt cache is warm:
 *  - warm (last API call < 55 min ago): ask the agent itself in a silent turn;
 *    the context is cache-read, which is cheap (see AgentSession.handoff).
 *  - cold: DON'T wake the big chat (that would re-write its whole context at
 *    2x input price). Render the persisted transcript to plain text and let
 *    Haiku 5.5 write the note over the bare Messages API.
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { complete } from "./anthropicDirect.js";
import type { ChatRecord, ContentBlock } from "../src/types.js";

const run = promisify(execFile);

/** The cache is treated as warm up to this age (the TTL is 1h; 5 min margin). */
export const WARM_CACHE_MAX_AGE_MS = 55 * 60_000;

export const HANDOFF_MODEL = "claude-haiku-5-5";
// Haiku 5.5 always thinks, and thinking tokens count against max_tokens.
const HANDOFF_MAX_TOKENS = 6_000;
// ~100k tokens of transcript text at most.
const MAX_TRANSCRIPT_CHARS = 400_000;
const HEAD_CHARS = 24_000;

export const HANDOFF_SECTIONS = [
  "Goal",
  "Current state",
  "Decisions and why",
  "Open problems",
  "Next steps",
  "Key files (path:line)",
  "How to verify",
] as const;

const NOTE_INSTRUCTIONS = `Write a handoff note so a fresh agent with NO memory of this conversation can pick the work up and continue. It will be pasted as the first message of a new chat, so make it concrete, specific and compact (aim for under ~700 words; no filler, no pleasantries).

Use exactly these markdown sections, in this order:

${HANDOFF_SECTIONS.map((h) => `## ${h}`).join("\n")}

Guidance:
- Goal: what the user ultimately wants, in their terms.
- Current state: what is done and working, what is half-done, what branch/worktree it lives on if known.
- Decisions and why: choices made and the reason, including approaches that were tried and rejected.
- Open problems: bugs, unknowns, questions still waiting on the user.
- Next steps: an ordered, actionable list.
- Key files (path:line): the files and line numbers a newcomer should read first.
- How to verify: the exact commands or manual steps that show the work is correct.`;

/** Prompt for the warm path: the chat's own agent writes the note. */
export const HANDOFF_WARM_PROMPT = `${NOTE_INSTRUCTIONS}

Do not call any tools and do not do any further work. Reply with the note only.`;

/** Whether the prompt cache for this chat is probably still warm. */
export function chatCacheIsWarm(record: ChatRecord, now = Date.now()): boolean {
  const last = Date.parse(record.cost?.lastApiAt ?? lastEventTs(record) ?? record.updatedAt);
  return Number.isFinite(last) && now - last < WARM_CACHE_MAX_AGE_MS;
}

function lastEventTs(record: ChatRecord): string | undefined {
  for (let i = record.events.length - 1; i >= 0; i--) {
    const ev = record.events[i];
    if (ev.type === "assistant" || ev.type === "result" || ev.type === "user_message") return ev.ts;
  }
  return undefined;
}

function shortArgs(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const main =
    pick("file_path") ?? pick("path") ?? pick("command") ?? pick("pattern") ?? pick("query") ?? pick("url") ?? pick("description");
  const text = main ?? JSON.stringify(o);
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}...` : oneLine;
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Plain-text view of a chat for the note writer: user and assistant text plus
 * tool-call names with short args. Tool RESULTS and thinking are dropped.
 */
export function renderTranscript(record: ChatRecord, maxChars = MAX_TRANSCRIPT_CHARS): string {
  const lines: string[] = [];
  for (const ev of record.events) {
    if (ev.type === "user_message") {
      const who = ev.origin && ev.origin !== "user" ? `[${ev.originLabel ?? ev.origin}]` : "User";
      lines.push(`${who}: ${clip(ev.text, 4_000)}`);
    } else if (ev.type === "assistant") {
      const text = textOf(ev.content);
      if (text) lines.push(`Assistant: ${clip(text, 3_000)}`);
      for (const b of ev.content) {
        if (b.type === "tool_use") lines.push(`  [tool] ${b.name}(${shortArgs(b.name, b.input)})`);
      }
    } else if (ev.type === "error") {
      lines.push(`[error] ${clip(ev.message, 300)}`);
    }
  }
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;
  const tail = full.slice(full.length - (maxChars - HEAD_CHARS));
  return `${full.slice(0, HEAD_CHARS)}\n\n[... ${full.length - maxChars} characters of middle history omitted ...]\n\n${tail}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function workingDirectory(record: ChatRecord, repoPath: string): string {
  for (let i = record.events.length - 1; i >= 0; i--) {
    const ev = record.events[i];
    if (ev.type === "system_init" && ev.cwd) return ev.cwd;
  }
  return record.worktreePath ?? repoPath;
}

/** Cold path: Haiku writes the note from the persisted transcript. */
export async function writeNoteWithHaiku(record: ChatRecord, repoPath: string): Promise<string> {
  const transcript = renderTranscript(record);
  if (!transcript.trim()) throw new Error("This chat has no messages to hand off.");
  const { text } = await complete({
    model: HANDOFF_MODEL,
    systemPrompt:
      "You write handoff notes that let a fresh coding agent continue another agent's work. You are given a condensed transcript of that conversation (tool results omitted).",
    userPrompt: `Chat title: ${record.title}\nWorking directory: ${workingDirectory(record, repoPath)}\n\n<transcript>\n${transcript}\n</transcript>\n\n${NOTE_INSTRUCTIONS}\n\nReply with the note only.`,
    maxTokens: HANDOFF_MAX_TOKENS,
    timeoutMs: 180_000,
  });
  const note = text.trim();
  if (!note) throw new Error("The note writer returned nothing.");
  return note;
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

// Keeps `.buildover/` out of `git status` without touching tracked files.
async function excludeFromGit(dir: string, entry: string): Promise<void> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: dir });
    const excludePath = resolve(dir, stdout.trim());
    const current = await readFile(excludePath, "utf8").catch(() => "");
    if (current.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === `/${entry}`)) return;
    await mkdir(dirname(excludePath), { recursive: true });
    await appendFile(excludePath, `${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
  } catch {
    // Not a git repo, or git unavailable: nothing to exclude.
  }
}

/**
 * Saves the note to `<cwd>/.buildover/handoffs/<chatId>-<timestamp>.md`, or to
 * the app data dir (~/.buildover/handoffs) when there is no usable working
 * directory. Returns the absolute path.
 */
export async function saveHandoffNote(
  record: ChatRecord,
  repoPath: string,
  note: string,
): Promise<string> {
  const file = `${record.id}-${timestampForFile()}.md`;
  const body = `# Handoff from "${record.title}" (chat ${record.id})\n\n${note}\n`;
  const cwd = record.worktreePath ?? repoPath;
  const candidates = [join(cwd, ".buildover", "handoffs"), join(homedir(), ".buildover", "handoffs")];
  let lastError: unknown;
  for (const dir of candidates) {
    try {
      await mkdir(dir, { recursive: true });
      const path = join(dir, file);
      await writeFile(path, body, "utf8");
      if (dir === candidates[0]) void excludeFromGit(cwd, ".buildover/");
      return path;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not save the handoff note");
}

/** The text prefilled (never auto-sent) into the fresh chat's composer. */
export function handoffPrefill(notePath: string, note: string): string {
  return `Continue from the handoff note at ${notePath}:\n\n${note}`;
}
