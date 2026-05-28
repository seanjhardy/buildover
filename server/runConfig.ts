import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import net from "node:net";
import { chatsDir } from "./repos.js";

export interface RunConfig {
  repoPath: string;
  previewUrl?: string;
  devPort?: number;
  createdAt: string;
  updatedAt: string;
}

function runConfigDir(repoPath: string): string {
  return dirname(chatsDir(repoPath));
}

export function runPanelHtmlPath(repoPath: string): string {
  return join(runConfigDir(repoPath), "run-panel.html");
}

export async function readRunConfig(repoPath: string): Promise<RunConfig | null> {
  try {
    const raw = await readFile(join(runConfigDir(repoPath), "run-config.json"), "utf8");
    return JSON.parse(raw) as RunConfig;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function readRunPanelHtml(repoPath: string): Promise<string | null> {
  try {
    return await readFile(runPanelHtmlPath(repoPath), "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeRunConfig(
  repoPath: string,
  panelHtml: string,
  previewUrl?: string,
  devPort?: number,
): Promise<RunConfig> {
  const dir = runConfigDir(repoPath);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run-panel.html"), panelHtml, "utf8");
  const now = new Date().toISOString();
  let createdAt = now;
  try {
    const existing = await readRunConfig(repoPath);
    if (existing?.createdAt) createdAt = existing.createdAt;
  } catch { /* ok */ }
  const config: RunConfig = { repoPath, previewUrl, devPort, createdAt, updatedAt: now };
  await writeFile(join(dir, "run-config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
  return config;
}

function tryConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => resolve(false));
    socket.connect(port, host);
  });
}

export function checkPortListening(port: number): Promise<boolean> {
  // Try both IPv4 and IPv6 — the server may bind to either depending on the OS/runtime.
  return Promise.all([tryConnect(port, "127.0.0.1"), tryConnect(port, "::1")])
    .then(([v4, v6]) => v4 || v6);
}

export function killPort(port: number): Promise<void> {
  return new Promise((resolve) => {
    // lsof -ti :<port> prints PIDs; xargs kill -9 terminates them.
    // Resolves regardless of exit code — nothing listening is fine.
    // -sTCP:LISTEN restricts to the process *listening* on the port (the dev
    // server), so we don't accidentally kill browser processes that merely have
    // an open connection to that port (e.g. the preview iframe).
    execFile(
      "sh",
      ["-c", `lsof -ti TCP:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null; true`],
      () => resolve(),
    );
  });
}
