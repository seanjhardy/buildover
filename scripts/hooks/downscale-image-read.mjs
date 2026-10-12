#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher: "Read"): when the agent Reads a large
// image, point it at a copy whose long edge is ≤ IMAGE_MAX_EDGE (default 1024).
// A 1920×1080 screenshot costs ~2.7k tokens on current models and is re-read on
// every later call in the session; at 1024px it is ~0.8k. macOS only (sips).
// Install it globally: buildover no longer applies this in-process (every SDK
// session loads ~/.claude/settings.json, so a second copy would double-process).
//
// ~/.claude/settings.json:
//   "hooks": { "PreToolUse": [{ "matcher": "Read", "hooks": [{ "type": "command",
//     "command": "node /path/to/buildover/scripts/hooks/downscale-image-read.mjs" }] }] }
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

const MAX_EDGE = Number(process.env.IMAGE_MAX_EDGE ?? 1024);
const EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff", ".bmp"]);
const CACHE = join(homedir(), ".buildover", "image-cache");

function passThrough() {
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  passThrough();
}
const filePath = input?.tool_input?.file_path;
if (input?.tool_name !== "Read" || !filePath || !MAX_EDGE || process.platform !== "darwin") passThrough();
const ext = extname(filePath).toLowerCase();
if (!EXTS.has(ext) || filePath.startsWith(CACHE) || !existsSync(filePath)) passThrough();

try {
  const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath], { encoding: "utf8" });
  const w = Number(/pixelWidth:\s*(\d+)/.exec(info)?.[1]);
  const h = Number(/pixelHeight:\s*(\d+)/.exec(info)?.[1]);
  if (!w || !h || Math.max(w, h) <= MAX_EDGE) passThrough();

  const st = statSync(filePath);
  const key = createHash("sha1").update(`${filePath}:${st.mtimeMs}:${st.size}:${MAX_EDGE}`).digest("hex").slice(0, 16);
  const outExt = ext === ".jpg" || ext === ".jpeg" ? ext : ".png";
  const out = join(CACHE, key + outExt);
  if (!existsSync(out)) {
    mkdirSync(CACHE, { recursive: true });
    execFileSync("sips", ["-Z", String(MAX_EDGE), "-s", "format", outExt === ".png" ? "png" : "jpeg", filePath, "--out", out], { stdio: "ignore" });
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...input.tool_input, file_path: out },
        additionalContext: `Image downscaled from ${w}×${h} to ≤${MAX_EDGE}px to save context (original: ${filePath}). Read the original only if fine detail is essential.`,
      },
    }),
  );
} catch {
  passThrough();
}
