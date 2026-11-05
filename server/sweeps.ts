import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PIPELINES_DIR } from "./pageTools.js";

// Sweeps: the times on weekdays when items that need the user are released.
// Between sweeps only urgent items break in. Times are local "HH:MM", read
// from <pipelines dir>/config.json { "sweeps": ["09:30", "14:00"] }.

export const DEFAULT_SWEEPS = ["09:30", "14:00"];

export function sweepTimes(file = join(PIPELINES_DIR, "config.json")): string[] {
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8")) as { sweeps?: unknown };
    const times = Array.isArray(cfg.sweeps)
      ? cfg.sweeps.filter((t): t is string => typeof t === "string" && /^\d{1,2}:\d{2}$/.test(t))
      : [];
    return times.length ? times : DEFAULT_SWEEPS;
  } catch {
    return DEFAULT_SWEEPS;
  }
}

/** The first sweep strictly after `from`, skipping Saturdays and Sundays. */
export function nextSweep(from: Date, times: string[] = sweepTimes()): Date {
  const minutes = times
    .map((t) => t.split(":").map(Number))
    .map(([h, m]) => h * 60 + m)
    .sort((a, b) => a - b);
  for (let day = 0; day < 8; day++) {
    const d = new Date(from);
    d.setDate(d.getDate() + day);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    for (const m of minutes) {
      d.setHours(Math.floor(m / 60), m % 60, 0, 0);
      if (d.getTime() > from.getTime()) return new Date(d);
    }
  }
  throw new Error("No sweep times configured");
}
