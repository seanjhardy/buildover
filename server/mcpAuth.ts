/**
 * OAuth sign-in for user-installed remote MCP servers (e.g. Smithery-hosted
 * http servers). Without a token the CLI reports these as `needs-auth` and
 * exposes no tools, in every repo.
 *
 * The Agent SDK's Query has an (undocumented) `mcpAuthenticate` control
 * request: the CLI starts the OAuth flow, listens for the provider's redirect
 * on a localhost port, and stores the tokens in the same credential store the
 * Claude CLI uses. Tokens are keyed by server name + config, not by repo, so a
 * single sign-in makes the server work in every chat.
 *
 * Running that needs a live CLI process, so we spin up a throwaway session
 * whose prompt never yields (no model turn ever starts), keep it alive until
 * the server reports `connected` or we time out, then close it.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { readInstalledServers, toSdkMcpConfig } from "./mcp-config.js";

export type McpAuthState = "pending" | "connected" | "failed";

interface AuthSession {
  state: McpAuthState;
  error?: string;
  close: () => void;
}

const sessions = new Map<string, AuthSession>();
const AUTH_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 2_000;

export function getMcpAuthState(
  id: string,
): { state: McpAuthState; error?: string } | null {
  const s = sessions.get(id);
  return s ? { state: s.state, error: s.error } : null;
}

/**
 * Start sign-in for an installed server. Resolves with the URL the user must
 * open, or `{ connected: true }` when the server is already authorised.
 */
export async function startMcpAuth(
  id: string,
): Promise<{ authUrl?: string; connected: boolean }> {
  const server = readInstalledServers().find((s) => s.id === id);
  if (!server) throw new Error(`MCP server not installed: ${id}`);
  if (server.type === "stdio") {
    throw new Error("stdio servers don't use OAuth");
  }

  sessions.get(id)?.close();

  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  async function* idlePrompt() {
    // Never yields a message — the session only exists to service control
    // requests. Returning ends the input stream once we're done.
    await released;
  }

  const q = query({
    prompt: idlePrompt() as any,
    options: {
      cwd: homedir(),
      settingSources: [],
      mcpServers: toSdkMcpConfig([server]) as any,
    },
  });

  let closed = false;
  const session: AuthSession = {
    state: "pending",
    close: () => {
      if (closed) return;
      closed = true;
      release();
      try {
        q.close();
      } catch {}
      // The entry stays in `sessions` so status polling can read the final
      // state; the next startMcpAuth for this id overwrites it.
    },
  };
  sessions.set(id, session);
  // Drain the stream so the CLI isn't blocked on stdout backpressure.
  void (async () => {
    try {
      for await (const _ of q as AsyncIterable<unknown>) {
      }
    } catch {}
  })();

  const finish = (state: McpAuthState, error?: string) => {
    session.state = state;
    session.error = error;
    session.close();
  };

  let res: {
    authUrl?: string;
    requiresUserAction?: boolean;
  };
  try {
    res = (await (q as any).mcpAuthenticate(id)) ?? {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finish("failed", msg);
    throw new Error(msg);
  }

  if (!res.authUrl || res.requiresUserAction === false) {
    finish("connected");
    return { connected: true };
  }

  // Wait for the user to finish in the browser. The CLI handles the localhost
  // callback itself; we just watch for the server to come up.
  const deadline = Date.now() + AUTH_TIMEOUT_MS;
  void (async () => {
    while (!closed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (closed) return;
      try {
        const statuses: { name: string; status: string; error?: string }[] =
          await q.mcpServerStatus();
        const st = statuses.find((s) => s.name === id);
        if (st?.status === "connected") return finish("connected");
        if (st?.status === "failed") return finish("failed", st.error);
      } catch {}
    }
    if (!closed) finish("failed", "Timed out waiting for sign-in");
  })();

  return { authUrl: res.authUrl, connected: false };
}
