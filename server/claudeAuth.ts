import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  clearCredsCache,
  readCreds,
  resolveClaudeCli,
} from "./anthropicAuth.js";
import { forgetUsageError } from "./usage.js";

const execFileAsync = promisify(execFile);

export type ClaudeLoginState = "idle" | "running" | "succeeded" | "failed";

export interface ClaudeLoginAttempt {
  state: ClaudeLoginState;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /**
   * The claude.ai sign-in page the CLI printed. On a desktop the CLI opens it
   * itself and catches the callback; on the server nothing can open it, so
   * the UI links to it and sends back the code the page shows (see
   * submitClaudeLoginCode).
   */
  url?: string;
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  expiresAt?: string;
  login: ClaudeLoginAttempt;
  error?: string;
}

// Login attempts and the status they're reflected in are tracked per
// configDir (`""` = the default/primary account) so two accounts can log in
// independently without one clobbering the other's in-flight attempt.
const loginProcesses = new Map<string, ChildProcess>();
const loginAttempts = new Map<string, ClaudeLoginAttempt>();

function key(configDir?: string): string {
  return configDir ?? "";
}

function getLoginAttempt(configDir?: string): ClaudeLoginAttempt {
  return loginAttempts.get(key(configDir)) ?? { state: "idle" };
}

function parseStatus(value: string): Partial<ClaudeAuthStatus> | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod:
        typeof parsed.authMethod === "string" ? parsed.authMethod : undefined,
      apiProvider:
        typeof parsed.apiProvider === "string" ? parsed.apiProvider : undefined,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      orgName: typeof parsed.orgName === "string" ? parsed.orgName : undefined,
      subscriptionType:
        typeof parsed.subscriptionType === "string"
          ? parsed.subscriptionType
          : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * configDir, when provided, is passed to the CLI as CLAUDE_CONFIG_DIR so the
 * status reflects that account rather than the default/primary one.
 */
export async function getClaudeAuthStatus(
  configDir?: string,
): Promise<ClaudeAuthStatus> {
  const env = configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env;
  try {
    const { stdout } = await execFileAsync(
      resolveClaudeCli(),
      ["auth", "status", "--json"],
      { timeout: 10_000, maxBuffer: 256 * 1024, env },
    );
    const status = parseStatus(stdout);
    if (!status) throw new Error("Claude returned an unreadable auth status");

    let expiresAt: string | undefined;
    try {
      const creds = await readCreds(true, configDir);
      if (Number.isFinite(creds.expiresAt)) {
        expiresAt = new Date(creds.expiresAt).toISOString();
      }
    } catch {
      // The CLI result remains authoritative if Keychain metadata is unavailable.
    }

    return {
      loggedIn: status.loggedIn === true,
      ...status,
      expiresAt,
      login: { ...getLoginAttempt(configDir) },
    };
  } catch (err) {
    const stdout = String(
      (err as { stdout?: string | Buffer })?.stdout ?? "",
    );
    const status = parseStatus(stdout);
    return {
      loggedIn: status?.loggedIn === true,
      ...status,
      login: { ...getLoginAttempt(configDir) },
      error: status
        ? undefined
        : "Buildover could not read Claude Code's authentication status.",
    };
  }
}

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const AUTHORIZE_URL = /https:\/\/\S+\/oauth\/authorize\?\S+/;

/**
 * Start the official Claude CLI browser login without blocking the API request.
 * Only one login process may run at once per account (per configDir). On
 * native desktop the OAuth callback returns directly to the CLI; no token
 * ever passes through the renderer. When configDir is set, the login writes
 * that account's credentials instead of the default/primary account's.
 */
export function startClaudeLogin(configDir?: string): ClaudeLoginAttempt {
  const k = key(configDir);
  const existingProcess = loginProcesses.get(k);
  const existingAttempt = getLoginAttempt(configDir);
  if (existingProcess && existingAttempt.state === "running") {
    const age = Date.now() - new Date(existingAttempt.startedAt ?? 0).getTime();
    if (existingAttempt.url && age < LOGIN_TIMEOUT_MS) return { ...existingAttempt };
    // Abandoned or never printed a URL: start over rather than wait on it.
    loginProcesses.delete(k);
    existingProcess.kill();
  }

  const startedAt = new Date().toISOString();
  loginAttempts.set(k, { state: "running", startedAt });

  try {
    const child = spawn(
      resolveClaudeCli(),
      ["auth", "login", "--claudeai"],
      {
        env: configDir
          ? { ...process.env, CLAUDE_CONFIG_DIR: configDir }
          : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    loginProcesses.set(k, child);
    const killTimer = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);
    killTimer.unref();

    let output = "";
    const onOutput = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8_000);
      const attempt = loginAttempts.get(k);
      const url = output.match(AUTHORIZE_URL)?.[0];
      if (url && attempt?.state === "running" && !attempt.url && loginProcesses.get(k) === child) {
        loginAttempts.set(k, { ...attempt, url });
      }
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.stdin?.on("error", () => {});

    child.once("error", (err) => {
      if (loginProcesses.get(k) !== child) return;
      loginProcesses.delete(k);
      loginAttempts.set(k, {
        state: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: `Could not start Claude login: ${err.message}`,
      });
    });

    child.once("exit", (code, signal) => {
      clearTimeout(killTimer);
      if (loginProcesses.get(k) !== child) return;
      loginProcesses.delete(k);
      clearCredsCache(configDir);
      const succeeded = code === 0;
      if (succeeded) void forgetUsageError(configDir);
      loginAttempts.set(k, {
        state: succeeded ? "succeeded" : "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(!succeeded
          ? {
              error: signal
                ? "Claude login timed out or was interrupted. Please try again."
                : (output.match(/Login failed:[^\n]*/)?.[0] ??
                  "Claude login did not complete. Please try again."),
            }
          : {}),
      });
    });
  } catch (err) {
    loginProcesses.delete(k);
    loginAttempts.set(k, {
      state: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { ...getLoginAttempt(configDir) };
}

/**
 * Sends the code shown by claude.ai after signing in to the waiting
 * `claude auth login` process (it prompts "Paste code here").
 */
export function submitClaudeLoginCode(code: string, configDir?: string): ClaudeLoginAttempt {
  const k = key(configDir);
  const child = loginProcesses.get(k);
  const trimmed = code.trim();
  if (!child?.stdin || getLoginAttempt(configDir).state !== "running") {
    throw new Error("No Claude login is waiting for a code. Start the sign-in again.");
  }
  if (!trimmed) throw new Error("Paste the code shown after signing in.");
  child.stdin.write(`${trimmed}\n`);
  return { ...getLoginAttempt(configDir) };
}
