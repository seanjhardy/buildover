import { spawn, type ChildProcess } from "node:child_process";

// Keeps the Mac awake using the built-in `caffeinate` utility. A single child
// process is managed here: each "add hour" extends the wake deadline and the
// process is (re)spawned with the remaining seconds via `-t`. When the deadline
// elapses `caffeinate` exits on its own and we clear our state.

const HOUR_SECONDS = 3600;

let proc: ChildProcess | null = null;
let deadline: number | null = null; // epoch ms when sleep is allowed again
let keepDisplayAwake = true; // -d flag: also prevent the display from sleeping

function killProc(): void {
  if (proc) {
    proc.removeAllListeners();
    try { proc.kill(); } catch { /* already gone */ }
    proc = null;
  }
}

function remainingSeconds(): number {
  if (deadline == null) return 0;
  return Math.max(0, Math.round((deadline - Date.now()) / 1000));
}

/** Spawn caffeinate for the time left until the deadline. */
function respawn(): void {
  killProc();
  const secs = remainingSeconds();
  if (secs <= 0) {
    deadline = null;
    return;
  }
  // -i: prevent idle system sleep. -d: also keep the display awake (optional).
  // -t <secs>: caffeinate exits after this many seconds.
  const args = ["-i", ...(keepDisplayAwake ? ["-d"] : []), "-t", String(secs)];
  proc = spawn("caffeinate", args, { stdio: "ignore" });
  proc.on("exit", () => {
    // Process ended (timer elapsed or killed) — only clear if it was the timer.
    if (deadline != null && remainingSeconds() <= 0) deadline = null;
    proc = null;
  });
  proc.on("error", () => { proc = null; deadline = null; });
}

export interface CaffeineStatus {
  active: boolean;
  secondsRemaining: number;
  keepDisplayAwake: boolean;
  supported: boolean;
}

export function getCaffeineStatus(): CaffeineStatus {
  return {
    active: remainingSeconds() > 0,
    secondsRemaining: remainingSeconds(),
    keepDisplayAwake,
    supported: process.platform === "darwin",
  };
}

/** Extend the wake deadline by one hour and (re)spawn caffeinate. */
export function addCaffeineHour(): CaffeineStatus {
  const base = Math.max(Date.now(), deadline ?? Date.now());
  deadline = base + HOUR_SECONDS * 1000;
  respawn();
  return getCaffeineStatus();
}

export function stopCaffeine(): CaffeineStatus {
  deadline = null;
  killProc();
  return getCaffeineStatus();
}

export function setCaffeineDisplay(on: boolean): CaffeineStatus {
  keepDisplayAwake = on;
  if (remainingSeconds() > 0) respawn(); // apply the flag change immediately
  return getCaffeineStatus();
}
