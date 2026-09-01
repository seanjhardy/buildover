import webpush, { type PushSubscription } from "web-push";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Web Push for the phone PWA ───────────────────────────────────────────────
// Lets the laptop notify the iPhone (installed PWA, iOS 16.4+) when an agent
// finishes a turn or needs input — but only while the Mac has been idle for a
// while, so we don't buzz the phone when the user is sitting right at the desk.

const DIR = join(homedir(), ".buildover");
const VAPID_PATH = join(DIR, "vapid.json");
const SUBS_PATH = join(DIR, "push-subscriptions.json");
// Apple (web.push.apple.com) validates the VAPID "sub" claim and rejects
// non-routable domains (e.g. *.local) with 403 BadJwtToken — so this must be a
// real mailto: or https: URL.
const CONTACT = "mailto:sean.hardy@worldover.io";

// Notify only once the Mac has had no keyboard/mouse input for this long.
export const IDLE_THRESHOLD_SECONDS = 5 * 60;

interface VapidKeys { publicKey: string; privateKey: string }

let vapid: VapidKeys | null = null;
let subscriptions: PushSubscription[] = [];
let loaded = false;

async function ensureDir(): Promise<void> {
  if (!existsSync(DIR)) await mkdir(DIR, { recursive: true });
}

// Load (or first-time generate) the VAPID keypair and the saved subscriptions.
async function init(): Promise<void> {
  if (loaded) return;
  await ensureDir();

  if (existsSync(VAPID_PATH)) {
    vapid = JSON.parse(await readFile(VAPID_PATH, "utf8")) as VapidKeys;
  } else {
    vapid = webpush.generateVAPIDKeys();
    await writeFile(VAPID_PATH, JSON.stringify(vapid, null, 2));
  }
  webpush.setVapidDetails(CONTACT, vapid.publicKey, vapid.privateKey);

  if (existsSync(SUBS_PATH)) {
    try {
      subscriptions = JSON.parse(await readFile(SUBS_PATH, "utf8")) as PushSubscription[];
    } catch {
      subscriptions = [];
    }
  }
  loaded = true;
}

async function persistSubs(): Promise<void> {
  await ensureDir();
  await writeFile(SUBS_PATH, JSON.stringify(subscriptions, null, 2));
}

export async function getVapidPublicKey(): Promise<string> {
  await init();
  return vapid!.publicKey;
}

export async function addSubscription(sub: PushSubscription): Promise<void> {
  await init();
  if (!subscriptions.some((s) => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
    await persistSubs();
  }
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await init();
  const before = subscriptions.length;
  subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
  if (subscriptions.length !== before) await persistSubs();
}

export function hasSubscriptions(): boolean {
  return subscriptions.length > 0;
}

// Seconds since the last HID (keyboard/mouse) input on this Mac. Returns 0 on
// non-darwin or if the value can't be read (so we never suppress on error in a
// way that hides notifications — callers decide via the threshold).
export async function getSystemIdleSeconds(): Promise<number> {
  if (process.platform !== "darwin") return Number.POSITIVE_INFINITY;
  try {
    const { stdout } = await execFileAsync("ioreg", ["-c", "IOHIDSystem"], {
      timeout: 4000,
    });
    const m = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (!m) return 0;
    // HIDIdleTime is in nanoseconds.
    return Number(m[1]) / 1_000_000_000;
  } catch {
    return 0;
  }
}

interface PushPayload {
  title: string;
  body: string;
  // A URL/identifier the SW can use to focus/open the right place.
  tag?: string;
  url?: string;
}

export interface SendResult {
  endpoint: string;
  ok: boolean;
  statusCode?: number;
  error?: string;
}

export async function sendToAll(payload: PushPayload): Promise<SendResult[]> {
  await init();
  if (subscriptions.length === 0) return [];
  const data = JSON.stringify(payload);
  return Promise.all(
    subscriptions.map(async (sub): Promise<SendResult> => {
      try {
        await webpush.sendNotification(sub, data);
        return { endpoint: sub.endpoint, ok: true };
      } catch (err: unknown) {
        const code = (err as { statusCode?: number })?.statusCode;
        const body = (err as { body?: string })?.body;
        const message = body || (err instanceof Error ? err.message : String(err));
        // eslint-disable-next-line no-console
        console.error(`[push] send failed (${code ?? "?"}): ${message}`);
        // 404/410 mean the subscription is dead — drop it so we don't keep trying.
        if (code === 404 || code === 410) await removeSubscription(sub.endpoint);
        return { endpoint: sub.endpoint, ok: false, statusCode: code, error: message };
      }
    }),
  );
}

// Called when an agent turn fully completes. Sends a push only if the Mac has
// been idle past the threshold (user is away) and there's a phone subscribed.
export async function notifyAgentFinished(
  chatTitle: string,
  repoName: string,
): Promise<void> {
  await init();
  if (subscriptions.length === 0) return;
  const idle = await getSystemIdleSeconds();
  if (idle < IDLE_THRESHOLD_SECONDS) return;
  await sendToAll({
    title: `✅ ${chatTitle || "Agent finished"}`,
    body: `Finished in ${repoName}`,
    tag: "agent-finished",
  });
}

// Called as soon as an agent blocks on a question, permission, or other user
// decision. Uses the same idle gate as completion notifications so a phone is
// only buzzed when the user appears to be away from the Mac.
export async function notifyAgentNeedsInput(
  chatTitle: string,
  repoName: string,
  message?: string,
): Promise<void> {
  await init();
  if (subscriptions.length === 0) return;
  const idle = await getSystemIdleSeconds();
  if (idle < IDLE_THRESHOLD_SECONDS) return;
  await sendToAll({
    title: `❓ ${chatTitle || "Agent needs your input"}`,
    body: message?.trim() || `Needs your input in ${repoName}`,
    tag: "agent-needs-input",
  });
}
