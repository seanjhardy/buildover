#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher: "Read|Bash|WebFetch|WebSearch") that
// steers agents away from the habits that burned most tokens in a measured
// week of transcripts. Every call re-reads the whole context, so the cheap
// fix is fewer calls in big contexts and smaller things kept in them:
//
//  - Read of an image in the main thread: denied once per file with a pointer
//    to the Haiku `visual-check` subagent (a retry of the same file is let
//    through, downscaled). Subagents always get the downscaled copy.
//  - Images are read through a cached copy whose long edge is ≤ IMAGE_MAX_EDGE
//    (default 1024): a 1920×1080 PNG is ~2.7k tokens, 1024×576 is ~0.8k.
//  - Bash commands that start with `sleep N` (turn-by-turn polling) are denied
//    with a pointer to run_in_background + Monitor or a single `until` loop.
//  - After WEB_BUDGET WebFetch/WebSearch calls in the main thread within 30
//    minutes, further ones are denied with a pointer to the Haiku
//    `researcher` subagent.
//
// ~/.claude/settings.json:
//   "hooks": { "PreToolUse": [{ "matcher": "Read|Bash|WebFetch|WebSearch",
//     "hooks": [{ "type": "command", "command": "node /path/to/token-guard.mjs" }] }] }
//
// Set TOKEN_GUARD=off to disable the denials (downscaling still applies).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";

const MAX_EDGE = Number(process.env.IMAGE_MAX_EDGE ?? 1024);
const WEB_BUDGET = Number(process.env.TOKEN_GUARD_WEB_BUDGET ?? 3);
const GUARD = process.env.TOKEN_GUARD !== "off";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff", ".bmp"]);
const CACHE = join(homedir(), ".buildover", "image-cache");

const done = () => process.exit(0);
const reply = (hookSpecificOutput) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...hookSpecificOutput } }));
  process.exit(0);
};
const deny = (reason) => reply({ permissionDecision: "deny", permissionDecisionReason: reason });

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  done();
}
const tool = input?.tool_name;
const args = input?.tool_input ?? {};
// Subagent tool calls carry agent_id / agent_type; main-thread calls don't.
const inSubagent = Boolean(input?.agent_id || input?.agent_type);

// Small per-session state so the guards can allow a deliberate retry.
const statePath = join(tmpdir(), `claude-token-guard-${String(input?.session_id ?? "x").replace(/[^\w-]/g, "")}.json`);
function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { deniedImages: {}, web: [] };
  }
}
const saveState = (s) => {
  try {
    writeFileSync(statePath, JSON.stringify(s));
  } catch {}
};

function downscaled(path) {
  if (!MAX_EDGE || process.platform !== "darwin" || path.startsWith(CACHE)) return null;
  try {
    const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
    const w = Number(/pixelWidth:\s*(\d+)/.exec(info)?.[1]);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(info)?.[1]);
    if (!w || !h || Math.max(w, h) <= MAX_EDGE) return null;
    const st = statSync(path);
    const ext = extname(path).toLowerCase();
    const key = createHash("sha1").update(`${path}:${st.mtimeMs}:${st.size}:${MAX_EDGE}`).digest("hex").slice(0, 16);
    const outExt = ext === ".jpg" || ext === ".jpeg" ? ext : ".png";
    const out = join(CACHE, key + outExt);
    if (!existsSync(out)) {
      mkdirSync(CACHE, { recursive: true });
      execFileSync("sips", ["-Z", String(MAX_EDGE), "-s", "format", outExt === ".png" ? "png" : "jpeg", path, "--out", out], { stdio: "ignore" });
    }
    return { out, w, h };
  } catch {
    return null;
  }
}

if (tool === "Read") {
  const path = args.file_path;
  if (!path || !IMAGE_EXTS.has(extname(path).toLowerCase()) || !existsSync(path)) done();
  if (GUARD && !inSubagent) {
    const s = loadState();
    const at = s.deniedImages[path];
    if (!at || Date.now() - at > 30 * 60e3) {
      s.deniedImages[path] = Date.now();
      saveState(s);
      deny(
        `Images stay in this conversation's context and are re-read on every later turn. Delegate looking at it to the ` +
          `\`visual-check\` subagent with a specific question (batch several images into one call) and keep only its text answer. ` +
          `Only if you truly need to see it yourself (e.g. the user asked you to look), Read it again and it will be allowed, downscaled.`,
      );
    }
  }
  const small = downscaled(path);
  if (!small) done();
  reply({
    updatedInput: { ...args, file_path: small.out },
    additionalContext: `Image downscaled from ${small.w}×${small.h} to ≤${MAX_EDGE}px to save context (original: ${path}).`,
  });
}

if (tool === "Bash" && GUARD && !args.run_in_background) {
  const m = /^\s*(?:cd [^;&]+(?:&&|;)\s*)?sleep\s+(\d+(?:\.\d+)?)/.exec(args.command ?? "");
  if (m && Number(m[1]) >= 5) {
    deny(
      `Don't poll with sleep: every check is a full model call over the whole context. Instead either (a) run the long job with ` +
        `run_in_background and use the Monitor tool to wake on its output or exit, or (b) wait in ONE command, e.g. ` +
        `\`timeout 600 bash -c 'until <check>; do sleep 5; done'\`.`,
    );
  }
}

if ((tool === "WebFetch" || tool === "WebSearch") && GUARD && !inSubagent && WEB_BUDGET > 0) {
  const s = loadState();
  s.web = (s.web ?? []).filter((t) => Date.now() - t < 30 * 60e3);
  if (s.web.length >= WEB_BUDGET) {
    deny(
      `Web research in this thread re-reads every fetched page on each later turn. Hand the remaining research to the ` +
        `\`researcher\` subagent (cheap model, returns a short sourced summary), batching all open questions into one brief.`,
    );
  }
  s.web.push(Date.now());
  saveState(s);
}

done();
