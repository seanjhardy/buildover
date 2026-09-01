import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  clearCredsCache,
  readCreds,
  resolveClaudeCli,
} from "./anthropicAuth.js";

const execFileAsync = promisify(execFile);

export type ClaudeLoginState = "idle" | "running" | "succeeded" | "failed";

export interface ClaudeLoginAttempt {
  state: ClaudeLoginState;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
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

let loginProcess: ChildProcess | null = null;
let loginAttempt: ClaudeLoginAttempt = { state: "idle" };

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

export async function getClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
  try {
    const { stdout } = await execFileAsync(
      resolveClaudeCli(),
      ["auth", "status", "--json"],
      { timeout: 10_000, maxBuffer: 256 * 1024 },
    );
    const status = parseStatus(stdout);
    if (!status) throw new Error("Claude returned an unreadable auth status");

    let expiresAt: string | undefined;
    try {
      const creds = await readCreds(true);
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
      login: { ...loginAttempt },
    };
  } catch (err) {
    const stdout = String(
      (err as { stdout?: string | Buffer })?.stdout ?? "",
    );
    const status = parseStatus(stdout);
    return {
      loggedIn: status?.loggedIn === true,
      ...status,
      login: { ...loginAttempt },
      error: status
        ? undefined
        : "Buildover could not read Claude Code's authentication status.",
    };
  }
}

/**
 * Start the official Claude CLI browser login without blocking the API request.
 * Only one login process may run at once. On native desktop the OAuth callback
 * returns directly to the CLI; no token ever passes through the renderer.
 */
export function startClaudeLogin(): ClaudeLoginAttempt {
  if (loginProcess && loginAttempt.state === "running") {
    return { ...loginAttempt };
  }

  const startedAt = new Date().toISOString();
  loginAttempt = { state: "running", startedAt };

  try {
    const child = spawn(
      resolveClaudeCli(),
      ["auth", "login", "--claudeai"],
      {
        env: process.env,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    loginProcess = child;

    child.once("error", (err) => {
      if (loginProcess !== child) return;
      loginProcess = null;
      loginAttempt = {
        state: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: `Could not start Claude login: ${err.message}`,
      };
    });

    child.once("exit", (code, signal) => {
      if (loginProcess !== child) return;
      loginProcess = null;
      clearCredsCache();
      const succeeded = code === 0;
      loginAttempt = {
        state: succeeded ? "succeeded" : "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(!succeeded
          ? {
              error: signal
                ? `Claude login was interrupted (${signal}).`
                : "Claude login did not complete. Try again or run `claude auth login` in a terminal.",
            }
          : {}),
      };
    });
  } catch (err) {
    loginProcess = null;
    loginAttempt = {
      state: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { ...loginAttempt };
}
