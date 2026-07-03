import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

// Keeps the Mac awake using the built-in `caffeinate` utility. A single child
// process is managed here: each "add hour" extends the wake deadline and the
// process is (re)spawned with the remaining seconds via `-t`. When the deadline
// elapses `caffeinate` exits on its own and we clear our state.
//
// Also prevents lid-closed sleep on battery by calling `sudo pmset disablesleep`.
// This requires a one-time sudoers setup (see error messages). On AC power,
// caffeinate's -s flag is sufficient.

const HOUR_SECONDS = 3600;

let proc: ChildProcess | null = null;
let deadline: number | null = null; // epoch ms when sleep is allowed again
let keepDisplayAwake = true; // -d flag: also prevent the display from sleeping
let pmsetDisabled = false; // whether we've set pmset disablesleep=1

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

async function enablePmsetSleep(): Promise<void> {
  if (!pmsetDisabled || process.platform !== "darwin") return;
  try {
    await execFileAsync("sudo", ["pmset", "-a", "disablesleep", "1"]);
    pmsetDisabled = true;
  } catch (err) {
    // Fail silently — pmset is best-effort. The user can set up passwordless
    // sudo via: echo 'user ALL=(ALL) NOPASSWD: /usr/bin/pmset' | sudo tee /etc/sudoers.d/pmset-caffeinate
    console.warn(
      "[caffeinate] Failed to set pmset disablesleep. To avoid password prompts, run:\n" +
      "  echo '$USER ALL=(ALL) NOPASSWD: /usr/bin/pmset' | sudo tee /etc/sudoers.d/pmset-caffeinate"
    );
  }
}

async function disablePmsetSleep(): Promise<void> {
  if (!pmsetDisabled || process.platform !== "darwin") return;
  try {
    await execFileAsync("sudo", ["pmset", "-a", "disablesleep", "0"]);
    pmsetDisabled = false;
  } catch {
    // Silently fail — already warned on enable
  }
}

/** Spawn caffeinate for the time left until the deadline. */
function respawn(): void {
  killProc();
  const secs = remainingSeconds();
  if (secs <= 0) {
    deadline = null;
    void disablePmsetSleep();
    return;
  }
  // -i: prevent idle system sleep. -s: prevent system sleep (even with lid closed on AC).
  // -d: also keep the display awake (optional). -t <secs>: caffeinate exits after this many seconds.
  const args = ["-i", "-s", ...(keepDisplayAwake ? ["-d"] : []), "-t", String(secs)];
  void enablePmsetSleep(); // try to disable sleep on battery too (needs sudo setup)
  proc = spawn("caffeinate", args, { stdio: "ignore" });
  proc.on("exit", () => {
    // Process ended (timer elapsed or killed) — only clear if it was the timer.
    if (deadline != null && remainingSeconds() <= 0) {
      deadline = null;
      void disablePmsetSleep();
    }
    proc = null;
  });
  proc.on("error", () => { proc = null; deadline = null; void disablePmsetSleep(); });
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
  void disablePmsetSleep();
  return getCaffeineStatus();
}

export function setCaffeineDisplay(on: boolean): CaffeineStatus {
  keepDisplayAwake = on;
  if (remainingSeconds() > 0) respawn(); // apply the flag change immediately
  return getCaffeineStatus();
}
