/**
 * Small global preferences file at ~/.buildover/prefs.json, for choices that
 * should persist across repos and app restarts but aren't worth a dedicated
 * store (same location as templates.json / recents.json).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppPrefs } from "../src/types.js";

const PREFS_PATH = join(homedir(), ".buildover", "prefs.json");

export async function readPrefs(): Promise<AppPrefs> {
  try {
    return JSON.parse(await readFile(PREFS_PATH, "utf8")) as AppPrefs;
  } catch {
    return {};
  }
}

export async function patchPrefs(patch: Partial<AppPrefs>): Promise<AppPrefs> {
  const next = { ...(await readPrefs()), ...patch };
  await mkdir(join(homedir(), ".buildover"), { recursive: true });
  await writeFile(PREFS_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}
