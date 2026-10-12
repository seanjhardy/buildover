/**
 * Token-economy defaults for every Claude chat buildover starts.
 *
 * Measured on a week of real transcripts (Oct 2026): ~90% of spend was
 * re-reading context (cache reads + writes), not output. Cost per call scales
 * with context size, so the levers here all shrink context or move bulk work
 * to cheaper models:
 *
 *  - autoCompactWindow: compact at 200k instead of letting chats run to
 *    400k–700k. Simulated against that week this cut cost ~25%.
 *  - Explore / researcher agents on Haiku 5.5: read-only search and web
 *    research don't need Opus. Haiku 5.5 cache reads cost 1/20th of Opus 5.5's.
 *  - Image downscale on Read: a 1920×1080 screenshot is ~2.7k tokens on
 *    current models and is re-read on every later call; 1024px is ~0.8k.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentDefinition, HookCallback } from "@anthropic-ai/claude-agent-sdk";

const run = promisify(execFile);

export const DEFAULT_AUTO_COMPACT_WINDOW = 200_000;

/** Long-edge cap for images the agent Reads. 0 disables downscaling. */
const IMAGE_MAX_EDGE = Number(process.env.BUILDOVER_IMAGE_MAX_EDGE ?? 1024);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff", ".bmp"]);
const IMAGE_CACHE_DIR = join(homedir(), ".buildover", "image-cache");

async function imageSize(path: string): Promise<[number, number] | null> {
  try {
    const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
    const w = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
    return w && h ? [w, h] : null;
  } catch {
    return null;
  }
}

/**
 * Returns a path to a copy of `path` whose long edge is at most `maxEdge`, or
 * null when the image is already small enough or can't be resized (non-macOS,
 * unreadable file). Copies are cached by path + mtime + size.
 */
export async function downscaledImagePath(path: string, maxEdge = IMAGE_MAX_EDGE): Promise<string | null> {
  if (!maxEdge || process.platform !== "darwin") return null;
  const ext = extname(path).toLowerCase();
  if (!IMAGE_EXTS.has(ext) || path.startsWith(IMAGE_CACHE_DIR)) return null;
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  const dims = await imageSize(path);
  if (!dims || Math.max(...dims) <= maxEdge) return null;
  const key = createHash("sha1").update(`${path}:${st.mtimeMs}:${st.size}:${maxEdge}`).digest("hex").slice(0, 16);
  // sips can't write webp/bmp everywhere; emit PNG for anything but JPEG.
  const outExt = ext === ".jpg" || ext === ".jpeg" ? ext : ".png";
  const out = join(IMAGE_CACHE_DIR, `${key}${outExt}`);
  try {
    await stat(out);
    return out;
  } catch {
    // not cached yet
  }
  try {
    await mkdir(IMAGE_CACHE_DIR, { recursive: true });
    const format = outExt === ".png" ? "png" : "jpeg";
    await run("sips", ["-Z", String(maxEdge), "-s", "format", format, path, "--out", out]);
    return out;
  } catch {
    return null;
  }
}

/** PreToolUse hook: point Read at a downscaled copy of large images. */
export const downscaleImageReads: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Read") return {};
  const toolInput = input.tool_input as { file_path?: string } | undefined;
  const filePath = toolInput?.file_path;
  if (!filePath) return {};
  const smaller = await downscaledImagePath(filePath);
  if (!smaller) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...toolInput, file_path: smaller },
      additionalContext: `Image downscaled to ≤${IMAGE_MAX_EDGE}px to save context (original: ${filePath}). Read the original only if fine detail is essential.`,
    },
  };
};

/**
 * Read-only agents pinned to Haiku 5.5. Defining `Explore` here overrides the
 * built-in one, which otherwise inherits the (usually Opus) main model.
 */
export const TOKEN_SAVING_AGENTS: Record<string, AgentDefinition> = {
  Explore: {
    description:
      "Fast read-only codebase search. Use to locate files, symbols, call sites or conventions when you only need the conclusion, not the file dumps.",
    prompt:
      "You are a read-only code search agent. Find what was asked using Grep, Glob and targeted Reads (read line ranges, not whole large files). " +
      "Do not modify anything. Reply with a compact answer: the relevant file paths with line numbers and a short explanation of each. " +
      "Quote only the few lines that matter. Never paste whole files.",
    model: "claude-haiku-5-5",
    tools: ["Read", "Grep", "Glob", "Bash"],
    omitClaudeMd: true,
  },
  researcher: {
    description:
      "Web research on a focused question (docs, papers, reference facts). Returns a short sourced summary instead of raw pages. Use for anything that needs several WebSearch/WebFetch calls.",
    prompt:
      "You research a focused question on the web. Use WebSearch and WebFetch, then reply with a concise, structured summary of the facts asked for, " +
      "each with its source URL. Do not paste page contents. If sources disagree, say so briefly.",
    model: "claude-haiku-5-5",
    tools: ["WebSearch", "WebFetch", "Read", "Write"],
    omitClaudeMd: true,
  },
};
