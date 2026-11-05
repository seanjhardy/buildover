import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { listAccounts } from "./claudeAccounts.js";
import { getUsage } from "./usage.js";

// What 1% of a subscription's weekly limit is worth in API dollars. The SDK
// prices every turn in API dollars; each account's weekly utilization moves as
// it's used. Recording both side by side gives the rate. Other use of the same
// account (the CLI, claude.ai) also moves the utilization, which only makes the
// rate, and so any budget built on it, smaller: the safe direction.

const FILE = join(homedir(), ".buildover", "spend-ledger.json");
const SAMPLE_EVERY_MS = 10 * 60_000;
const MAX_SAMPLES = 300;
/** Ignore a rate until the utilization has moved at least this much. */
const MIN_POINTS = 3;

export interface UsageSample {
  at: string;
  /** buildover's running API-dollar total on this account. */
  usd: number;
  /** Weekly utilization, 0-100. */
  util: number;
  resetsAt: string | null;
}

interface Ledger {
  accounts: Record<string, { usd: number; samples: UsageSample[] }>;
}

let ledger: Ledger | null = null;
let dirty = false;
let lastSample = 0;

async function load(): Promise<Ledger> {
  if (ledger) return ledger;
  try {
    ledger = JSON.parse(await readFile(FILE, "utf8")) as Ledger;
  } catch {
    ledger = { accounts: {} };
  }
  ledger.accounts ??= {};
  return ledger;
}

async function save(): Promise<void> {
  if (!ledger || !dirty) return;
  dirty = false;
  await mkdir(join(homedir(), ".buildover"), { recursive: true });
  const tmp = `${FILE}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(ledger) + "\n", "utf8");
  await rename(tmp, FILE);
}

/** Count a turn's API-dollar cost against the account it ran on. */
export function noteSpend(accountId: string | undefined, usd: number): void {
  if (!accountId || !(usd > 0)) return;
  void load().then((l) => {
    const a = (l.accounts[accountId] ??= { usd: 0, samples: [] });
    a.usd += usd;
    dirty = true;
  });
}

/** Record each account's utilization next to its running spend (at most every 10 minutes). */
export async function sampleUsage(): Promise<void> {
  if (Date.now() - lastSample < SAMPLE_EVERY_MS) return;
  lastSample = Date.now();
  const l = await load();
  for (const account of await listAccounts()) {
    const week = await getUsage(account.configDir ?? undefined)
      .then((u) => u.sevenDay)
      .catch(() => null);
    if (!week) continue;
    const a = (l.accounts[account.id] ??= { usd: 0, samples: [] });
    const last = a.samples[a.samples.length - 1];
    if (last && last.util === week.utilization && last.usd === a.usd) continue;
    a.samples.push({ at: new Date().toISOString(), usd: a.usd, util: week.utilization, resetsAt: week.resetsAt });
    if (a.samples.length > MAX_SAMPLES) a.samples.splice(0, a.samples.length - MAX_SAMPLES);
    dirty = true;
  }
  await save();
}

/**
 * Dollars per utilization point from consecutive samples in the same weekly
 * window (a reset makes utilization drop, so pairs across it are skipped).
 */
export function estimateRate(samplesByAccount: UsageSample[][]): number | null {
  let usd = 0;
  let points = 0;
  for (const samples of samplesByAccount) {
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const dUtil = b.util - a.util;
      if (a.resetsAt !== b.resetsAt || dUtil < 0) continue;
      usd += Math.max(0, b.usd - a.usd);
      points += dUtil;
    }
  }
  return points >= MIN_POINTS && usd > 0 ? usd / points : null;
}

/** `share` (e.g. 0.02) of one subscription's week in API dollars, or null until known. */
export async function weeklyShareUsd(share: number): Promise<number | null> {
  const l = await load();
  const rate = estimateRate(Object.values(l.accounts).map((a) => a.samples));
  return rate === null ? null : rate * share * 100;
}
