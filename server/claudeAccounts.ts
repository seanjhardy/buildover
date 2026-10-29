/**
 * Multiple Claude Code accounts, so Buildover can automatically switch to a
 * second account when the active one runs out of usage. Each account is a
 * separate Claude config dir (CLAUDE_CONFIG_DIR): the "primary" account is
 * whatever the environment already points at (configDir: null — no override,
 * so existing single-account behavior / keychain lookups are untouched).
 * Additional accounts live under ~/.buildover/claude-accounts/<id>.
 *
 * Persisted as a small JSON file in ~/.buildover, independent of prefs.ts (whose
 * AppPrefs shape is a poor fit for an array of accounts with live usage).
 */
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getClaudeAuthStatus, type ClaudeLoginAttempt } from "./claudeAuth.js";
import { getUsage, type UsageBucket } from "./usage.js";

export interface ClaudeAccount {
  id: string;
  label: string;
  /** null = primary/default account: no CLAUDE_CONFIG_DIR override. */
  configDir: string | null;
}

interface StoreShape {
  accounts: ClaudeAccount[];
  activeId: string;
  autoSwitch: boolean;
  /** Why auto-pick chose the active account, in plain words (also read by Decisions). */
  autoReason?: string;
}

interface SwitchInfo {
  at: string;
  reason: "manual" | "usage-limit" | "usage-limit-midturn" | "pace";
  from: string;
  to: string;
}

const BUILDOVER_HOME = join(homedir(), ".buildover");
export const PRIMARY_ACCOUNT_ID = "primary";
const STORE_PATH = join(BUILDOVER_HOME, "claude-accounts.json");
// Auto-switch away from an account once it's this close to its limit, not
// only once it's fully blocked — avoids starting a turn that is likely to
// get cut off mid-way.
const AUTO_SWITCH_THRESHOLD = 98;
// Never start a turn on an account whose 5-hour window is this full.
const SESSION_CAP = 90;
// Only move off the current account when another is this many points further
// behind its weekly pace: a switch costs a prompt-cache rewrite per chat.
const SWITCH_MARGIN = 10;
const WEEK_MS = 7 * 24 * 3600_000;

let cache: StoreShape | null = null;
let lastSwitch: SwitchInfo | null = null;
let loadPromise: Promise<StoreShape> | null = null;

function defaultStore(): StoreShape {
  return {
    accounts: [{ id: PRIMARY_ACCOUNT_ID, label: "Primary", configDir: null }],
    activeId: PRIMARY_ACCOUNT_ID,
    autoSwitch: true,
  };
}

async function load(): Promise<StoreShape> {
  if (cache) return cache;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = JSON.parse(await readFile(STORE_PATH, "utf8")) as Partial<StoreShape>;
        const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
        const next: StoreShape = {
          accounts: accounts.some((a) => a.id === PRIMARY_ACCOUNT_ID)
            ? accounts
            : [{ id: PRIMARY_ACCOUNT_ID, label: "Primary", configDir: null }, ...accounts],
          activeId: raw.activeId ?? PRIMARY_ACCOUNT_ID,
          autoSwitch: raw.autoSwitch ?? true,
        };
        if (!next.accounts.some((a) => a.id === next.activeId)) {
          next.activeId = PRIMARY_ACCOUNT_ID;
        }
        cache = next;
      } catch {
        cache = defaultStore();
      }
      return cache!;
    })();
  }
  return loadPromise;
}

async function save(): Promise<void> {
  if (!cache) return;
  await mkdir(BUILDOVER_HOME, { recursive: true }).catch(() => {});
  await writeFile(STORE_PATH, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

export async function listAccounts(): Promise<ClaudeAccount[]> {
  const s = await load();
  return s.accounts;
}

export async function getActiveAccount(): Promise<ClaudeAccount> {
  const s = await load();
  return s.accounts.find((a) => a.id === s.activeId) ?? s.accounts[0];
}

export async function getAccount(id: string): Promise<ClaudeAccount | undefined> {
  const s = await load();
  return s.accounts.find((a) => a.id === id);
}

export async function getAutoSwitch(): Promise<boolean> {
  return (await load()).autoSwitch;
}

export async function setAutoSwitch(enabled: boolean): Promise<void> {
  const s = await load();
  s.autoSwitch = enabled;
  await save();
}

export async function addAccount(label?: string): Promise<ClaudeAccount> {
  const s = await load();
  const id = randomUUID().slice(0, 8);
  const account: ClaudeAccount = {
    id,
    label: label?.trim() || `Account ${s.accounts.length + 1}`,
    configDir: join(BUILDOVER_HOME, "claude-accounts", id),
  };
  s.accounts.push(account);
  await save();
  await shareConfig(account.configDir!).catch((err) =>
    console.warn(`[claude-accounts] could not share config with ${id}:`, err),
  );
  return account;
}

function primaryConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

// Parts of the primary account's config dir every other account links to, so
// a chat behaves the same whichever account runs it: transcripts (a chat can
// resume under another account), CLAUDE.md, settings and hooks, skills,
// agents, commands and plugins. Credentials, .claude.json (the signed-in
// account) and org policy files stay per account.
const SHARED_CONFIG = [
  "projects",
  "CLAUDE.md",
  "settings.json",
  "agents",
  "skills",
  "commands",
  "plugins",
  "hooks",
  "output-styles",
  "plans",
  "todos",
  "file-history",
];

/**
 * Links an extra account's config dir to the primary account's shared config
 * (see SHARED_CONFIG) and copies over the user-scope MCP servers, which live in
 * .claude.json alongside the account itself. Anything the CLI already wrote
 * into a shared directory is merged into the primary's first.
 */
export function shareConfig(configDir: string): Promise<void> {
  // Turns starting together would race to merge the same directories.
  let pending = sharing.get(configDir);
  if (!pending) {
    pending = linkSharedConfig(configDir).finally(() => sharing.delete(configDir));
    sharing.set(configDir, pending);
  }
  return pending;
}

const sharing = new Map<string, Promise<void>>();

async function linkSharedConfig(configDir: string): Promise<void> {
  const primary = primaryConfigDir();
  await mkdir(join(primary, "projects"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  for (const name of SHARED_CONFIG) {
    const target = join(primary, name);
    const link = join(configDir, name);
    if (!(await lstat(target).catch(() => null))) continue;
    const existing = await lstat(link).catch(() => null);
    if (existing?.isSymbolicLink()) continue;
    if (existing?.isDirectory()) await cp(link, target, { recursive: true, force: false });
    if (existing) await rm(link, { recursive: true, force: true });
    await symlink(target, link).catch((err) => {
      // Another turn linked it first.
      if (err?.code !== "EEXIST") throw err;
    });
  }
  await shareMcpServers(configDir);
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function shareMcpServers(configDir: string): Promise<void> {
  const primaryGlobal = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homedir(), ".claude.json");
  const servers = (await readJson(primaryGlobal))?.mcpServers ?? {};
  const path = join(configDir, ".claude.json");
  const config = (await readJson(path)) ?? {};
  if (JSON.stringify(config.mcpServers ?? {}) === JSON.stringify(servers)) return;
  config.mcpServers = servers;
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
}

export async function removeAccount(id: string): Promise<boolean> {
  const s = await load();
  if (id === PRIMARY_ACCOUNT_ID) return false;
  const idx = s.accounts.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  s.accounts.splice(idx, 1);
  if (s.activeId === id) s.activeId = PRIMARY_ACCOUNT_ID;
  await save();
  return true;
}

export async function setActiveAccount(id: string): Promise<ClaudeAccount | null> {
  const s = await load();
  const account = s.accounts.find((a) => a.id === id);
  if (!account) return null;
  if (s.activeId !== id) {
    const from = s.activeId;
    s.activeId = id;
    lastSwitch = { at: new Date().toISOString(), reason: "manual", from, to: id };
    // Picking an account by hand pins it; ticking Auto-switch hands back.
    s.autoSwitch = false;
    console.log(`[claude-accounts] switched active account ${from} -> ${id} (manual)`);
    await save();
  }
  return account;
}

export function getLastSwitch(): SwitchInfo | null {
  return lastSwitch;
}

async function accountLoggedIn(account: ClaudeAccount): Promise<boolean> {
  try {
    const status = await getClaudeAuthStatus(account.configDir ?? undefined);
    return status.loggedIn;
  } catch {
    return false;
  }
}

/**
 * How far an account is behind its weekly pace, in percentage points: the
 * share of its week already elapsed minus the share of its allowance used.
 * Resets in 2 days (5/7 = 71% elapsed) at 20% used -> 51 points of allowance
 * that will expire unused unless spent. The account with the most is the one
 * to spend on. Null when the account can't take a turn right now.
 */
interface Standing {
  account: ClaudeAccount;
  slack: number;
  used: number;
  resetsAt: string | null;
}

async function standing(account: ClaudeAccount): Promise<Standing | null> {
  if (!(await accountLoggedIn(account))) return null;
  try {
    const usage = await getUsage(account.configDir ?? undefined);
    if (usage.fiveHour && usage.fiveHour.utilization >= SESSION_CAP) return null;
    const week = usage.sevenDay;
    if (week && week.utilization >= AUTO_SWITCH_THRESHOLD) return null;
    if (!week) return { account, slack: 0, used: 0, resetsAt: null };
    const left = week.resetsAt ? Date.parse(week.resetsAt) - Date.now() : WEEK_MS / 2;
    const elapsed = 100 * Math.min(1, Math.max(0, 1 - left / WEEK_MS));
    return { account, slack: elapsed - week.utilization, used: week.utilization, resetsAt: week.resetsAt };
  } catch {
    return null;
  }
}

function describe(st: Standing): string {
  const name = st.account.label;
  const days = st.resetsAt
    ? Math.max(0, (Date.parse(st.resetsAt) - Date.now()) / 86_400_000)
    : null;
  const when = days == null ? "" : `, resets in ${days < 1 ? `${Math.round(days * 24)}h` : `${days.toFixed(1)}d`}`;
  const pace = Math.round(st.slack);
  return `${name}: ${Math.round(st.used)}% of week used${when}; ${
    pace >= 0 ? `${pace} pts behind pace` : `${-pace} pts ahead of pace`
  }`;
}

/**
 * The auto-pick rule: among accounts that can take a turn (signed in, 5-hour
 * window under 90%, week under 98%), use the one furthest behind its weekly
 * pace. Stay on the current account while it can take turns unless another is
 * at least SWITCH_MARGIN points further behind.
 */
async function chooseAccount(
  s: StoreShape,
  exclude?: string,
): Promise<{ pick: ClaudeAccount; reason: string } | null> {
  const standings = (
    await Promise.all(s.accounts.filter((a) => a.id !== exclude).map(standing))
  ).filter((x): x is Standing => !!x);
  if (standings.length === 0) return null;
  const best = standings.reduce((a, b) => (b.slack > a.slack ? b : a));
  const current = standings.find((x) => x.account.id === s.activeId);
  if (current && best.slack - current.slack < SWITCH_MARGIN) {
    return { pick: current.account, reason: `Staying on ${describe(current)}` };
  }
  return { pick: best.account, reason: `Using ${describe(best)}` };
}

async function applyChoice(
  s: StoreShape,
  choice: { pick: ClaudeAccount; reason: string },
  reason: SwitchInfo["reason"],
): Promise<void> {
  const from = s.activeId;
  const changed = from !== choice.pick.id || s.autoReason !== choice.reason;
  if (from !== choice.pick.id) {
    s.activeId = choice.pick.id;
    lastSwitch = { at: new Date().toISOString(), reason, from, to: choice.pick.id };
    console.log(`[claude-accounts] auto-switched ${from} -> ${choice.pick.id} (${reason}): ${choice.reason}`);
  }
  s.autoReason = choice.reason;
  if (changed) await save();
}

/**
 * Picks the account to run the next Claude turn on (see chooseAccount) when
 * auto-switch is on; with it off the manually chosen account is used as is.
 * The caller is responsible for queueing if the returned account is blocked.
 */
export async function pickAccountForTurn(): Promise<ClaudeAccount> {
  const s = await load();
  const active = s.accounts.find((a) => a.id === s.activeId) ?? s.accounts[0];
  if (!s.autoSwitch || s.accounts.length < 2) return active;
  const choice = await chooseAccount(s);
  if (!choice) return active;
  const wasBlocked = !(await standing(active));
  await applyChoice(s, choice, wasBlocked ? "usage-limit" : "pace");
  return choice.pick;
}

/**
 * Called when a turn fails mid-flight on `accountId` with a usage/rate-limit
 * error. Switches to the best other account and returns it so the caller can
 * retry immediately; returns null if none is available.
 */
export async function switchAwayFromAccount(
  accountId: string,
): Promise<ClaudeAccount | null> {
  const s = await load();
  if (!s.autoSwitch) return null;
  const choice = await chooseAccount(s, accountId);
  if (!choice) return null;
  await applyChoice(s, choice, "usage-limit-midturn");
  return choice.pick;
}

export interface ClaudeAccountSummary {
  id: string;
  label: string;
  active: boolean;
  loggedIn: boolean;
  email?: string;
  fiveHour: UsageBucket | null;
  sevenDay: UsageBucket | null;
  error?: string;
  login?: ClaudeLoginAttempt;
}

/** Full per-account summary for the /api/usage response and the accounts UI. */
export async function listAccountSummaries(): Promise<{
  accounts: ClaudeAccountSummary[];
  autoSwitch: boolean;
  autoReason?: string;
  switchedAt?: string;
  switchReason?: string;
}> {
  const s = await load();
  if (s.autoSwitch && s.accounts.length >= 2) await pickAccountForTurn().catch(() => {});
  const accounts = await Promise.all(
    s.accounts.map(async (a): Promise<ClaudeAccountSummary> => {
      const status = await getClaudeAuthStatus(a.configDir ?? undefined).catch(
        () => null,
      );
      let fiveHour: UsageBucket | null = null;
      let sevenDay: UsageBucket | null = null;
      let error: string | undefined;
      if (status?.loggedIn) {
        try {
          const usage = await getUsage(a.configDir ?? undefined);
          fiveHour = usage.fiveHour;
          sevenDay = usage.sevenDay;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }
      return {
        id: a.id,
        label: a.label,
        active: a.id === s.activeId,
        loggedIn: status?.loggedIn ?? false,
        login: status?.login,
        email: status?.email,
        fiveHour,
        sevenDay,
        error,
      };
    }),
  );
  return {
    accounts,
    autoSwitch: s.autoSwitch,
    autoReason: s.autoSwitch ? s.autoReason : "Pinned by hand; tick Auto-switch to let Buildover choose",
    ...(lastSwitch ? { switchedAt: lastSwitch.at, switchReason: lastSwitch.reason } : {}),
  };
}
