import { spawn, type ChildProcess } from "node:child_process";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { ProxyAgent, type Dispatcher } from "undici";

// "US VPN" toggle. Routes Claude/Anthropic traffic through an HTTP proxy
// (tinyproxy) running on a remote VM in the United States, reached over an
// SSH tunnel so nothing is exposed on the public internet.
//
// When enabled we:
//   1. Open `ssh -N -L <local>:127.0.0.1:<remote> user@host` — forwarding the
//      VM's localhost-only proxy to a local port on this machine.
//   2. Set HTTPS_PROXY/HTTP_PROXY in process.env so the `claude` CLI subprocess
//      spawned by the agent SDK egresses through the tunnel.
//   3. Build an undici ProxyAgent so our own direct fetch() calls to
//      api.anthropic.com (which ignore the proxy env vars) route through it too.
//
// Disabling tears all of that back down.

// ── Config (read from env, set via the SetupPanel UI) ───────────────────────
function readConfig() {
  const host = (process.env.VPN_SSH_HOST ?? "").trim();
  const user = (process.env.VPN_SSH_USER ?? "ubuntu").trim() || "ubuntu";
  let key = (process.env.VPN_SSH_KEY ?? "~/.ssh/id_ed25519").trim() || "~/.ssh/id_ed25519";
  if (key.startsWith("~")) key = key.replace(/^~/, homedir());
  const remotePort = Number(process.env.VPN_REMOTE_PROXY_PORT ?? 8888) || 8888;
  const localPort = Number(process.env.VPN_LOCAL_PORT ?? 8889) || 8889;
  return { host, user, key, remotePort, localPort };
}

export interface VpnStatus {
  enabled: boolean;
  connecting: boolean;
  host: string | null;
  egressIp: string | null;
  error: string | null;
  configured: boolean;
}

// ── In-memory state ─────────────────────────────────────────────────────────
let sshProc: ChildProcess | null = null;
let dispatcher: ProxyAgent | null = null;
let connecting = false;
let egressIp: string | null = null;
let lastError: string | null = null;
let activeHost: string | null = null;

// The dispatcher our direct Anthropic fetch() calls should use, or undefined
// when the VPN is off (so fetch falls back to its default global dispatcher).
export function getProxyDispatcher(): Dispatcher | undefined {
  return dispatcher ?? undefined;
}

export function isVpnEnabled(): boolean {
  return sshProc !== null && dispatcher !== null;
}

export function getVpnStatus(): VpnStatus {
  const cfg = readConfig();
  return {
    enabled: isVpnEnabled(),
    connecting,
    host: activeHost,
    egressIp,
    error: lastError,
    configured: Boolean(cfg.host),
  };
}

// Resolve once the local forwarded port accepts a TCP connection, or reject
// after `timeoutMs`. Used to confirm the SSH tunnel actually came up.
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = netConnect({ host: "127.0.0.1", port });
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`SSH tunnel did not open on port ${port} in time`));
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

// Confirm traffic actually egresses through the proxy and report the public IP.
async function probeEgressIp(d: ProxyAgent): Promise<string | null> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const res = await fetch("https://api.ipify.org?format=json", {
      dispatcher: d,
      signal: ac.signal,
    } as RequestInit & { dispatcher: Dispatcher });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = (await res.json()) as { ip?: string };
    return json.ip ?? null;
  } catch {
    return null;
  }
}

function applyProxyEnv(proxyUrl: string | null) {
  if (proxyUrl) {
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.HTTP_PROXY = proxyUrl;
    process.env.ALL_PROXY = proxyUrl;
    // Never proxy connections to ourselves / loopback.
    process.env.NO_PROXY = "localhost,127.0.0.1,::1";
  } else {
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NO_PROXY;
  }
}

function teardown() {
  applyProxyEnv(null);
  if (dispatcher) {
    void dispatcher.close().catch(() => {});
    dispatcher = null;
  }
  if (sshProc) {
    const p = sshProc;
    sshProc = null;
    try {
      p.removeAllListeners("exit");
      p.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  egressIp = null;
  activeHost = null;
}

// Turn the VPN on. Idempotent-ish: if already enabled, returns current status.
export async function enableVpn(): Promise<VpnStatus> {
  if (isVpnEnabled()) return getVpnStatus();
  const cfg = readConfig();
  if (!cfg.host) {
    lastError = "VPN not configured — set the VM host in Settings first.";
    throw new Error(lastError);
  }

  connecting = true;
  lastError = null;
  egressIp = null;
  activeHost = cfg.host;

  try {
    const args = [
      "-N", // no remote command, just forward
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      "-o", "BatchMode=yes", // never prompt — fail fast if the key isn't accepted
      "-i", cfg.key,
      "-L", `${cfg.localPort}:127.0.0.1:${cfg.remotePort}`,
      `${cfg.user}@${cfg.host}`,
    ];

    const proc = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
    sshProc = proc;

    // Capture stderr so a connection failure surfaces a useful message.
    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });

    // If ssh dies later (dropped tunnel), clean up so status reflects reality.
    proc.on("exit", (code) => {
      if (sshProc === proc) {
        lastError = `SSH tunnel closed unexpectedly${
          code != null ? ` (exit ${code})` : ""
        }${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`;
        teardown();
      }
    });

    await waitForPort(cfg.localPort, 10_000).catch((e) => {
      const detail = stderr.trim().split("\n").pop();
      throw new Error(detail ? `${e.message} — ${detail}` : e.message);
    });

    const proxyUrl = `http://127.0.0.1:${cfg.localPort}`;
    dispatcher = new ProxyAgent(proxyUrl);
    applyProxyEnv(proxyUrl);

    // Best-effort egress confirmation — failure here doesn't disable the VPN,
    // it just leaves egressIp null (the tunnel/port check already passed).
    egressIp = await probeEgressIp(dispatcher);

    connecting = false;
    return getVpnStatus();
  } catch (err) {
    connecting = false;
    teardown();
    lastError = err instanceof Error ? err.message : String(err);
    throw new Error(lastError);
  }
}

export function disableVpn(): VpnStatus {
  teardown();
  connecting = false;
  lastError = null;
  return getVpnStatus();
}
