/**
 * claudeConnectors.ts — reads the claude.ai account "connectors" (hosted MCP
 * cloud servers) the Claude Code CLI auto-fetches, so Buildover can show the
 * same list the Claude app shows.
 *
 * The CLI already auto-connects these at session init (it omits
 * `disableClaudeAiConnectors`), so this module does NOT mirror them into
 * ~/.buildover/mcp-servers.json — doing so would attempt a fresh, un-authed
 * connection to each URL. It is purely for visibility: list what each account
 * exposes, keyed by Buildover account, before a chat starts.
 *
 * Endpoint discovered from the bundled CLI binary:
 *   GET https://api.anthropic.com/v1/mcp_servers?limit=1000
 *   headers: anthropic-beta: mcp-servers-2025-12-04, anthropic-version: 2023-06-01
 * Authenticated with the per-account OAuth token (scope user:mcp_servers) via
 * fetchWithClaudeAuth, which also handles the 401-refresh dance.
 */

import { fetchWithClaudeAuth } from "./anthropicAuth.js";
import { listAccounts } from "./claudeAccounts.js";
import { getClaudeAuthStatus } from "./claudeAuth.js";

const MCP_SERVERS_URL = "https://api.anthropic.com/v1/mcp_servers?limit=1000";
const MCP_HEADERS = {
  "anthropic-beta": "mcp-servers-2025-12-04",
  "anthropic-version": "2023-06-01",
};

export interface ClaudeConnector {
  id: string;
  name: string;
  url: string;
  iconUrl?: string;
}

export interface AccountConnectors {
  accountId: string;
  label: string;
  email?: string;
  connectors: ClaudeConnector[];
  /** Set when the account's connector list could not be fetched. */
  error?: string;
}

interface RawServer {
  id?: string;
  display_name?: string;
  url?: string;
  icon_url?: string | null;
}

/** Fetch the claude.ai connectors registered for one account (config dir). */
export async function listAccountConnectors(
  configDir?: string,
): Promise<ClaudeConnector[]> {
  const res = await fetchWithClaudeAuth(
    MCP_SERVERS_URL,
    { headers: MCP_HEADERS },
    configDir,
  );
  if (!res.ok) {
    throw new Error(`claude.ai mcp_servers returned ${res.status}`);
  }
  const body = (await res.json()) as { data?: RawServer[] };
  const data = Array.isArray(body.data) ? body.data : [];
  return data
    .filter((s): s is RawServer & { id: string; url: string } =>
      Boolean(s.id && s.url),
    )
    .map((s) => ({
      id: s.id,
      name: s.display_name || s.url,
      url: s.url,
      ...(s.icon_url ? { iconUrl: s.icon_url } : {}),
    }));
}

/**
 * The same list grouped by Buildover account, so the UI can show "Primary has
 * Claude Docs; Worldover has Engineering Priorities, Slack, …". Logged-out or
 * unreachable accounts come back with an `error` and an empty list.
 */
export async function listConnectorsByAccount(): Promise<AccountConnectors[]> {
  const accounts = await listAccounts();
  return Promise.all(
    accounts.map(async (account): Promise<AccountConnectors> => {
      const configDir = account.configDir ?? undefined;
      let email: string | undefined;
      try {
        const status = await getClaudeAuthStatus(configDir);
        email = status.email;
        if (!status.loggedIn) {
          return {
            accountId: account.id,
            label: account.label,
            email,
            connectors: [],
            error: "Not signed in",
          };
        }
      } catch {
        // Fall through and still try the connector fetch.
      }
      try {
        const connectors = await listAccountConnectors(configDir);
        return { accountId: account.id, label: account.label, email, connectors };
      } catch (err) {
        return {
          accountId: account.id,
          label: account.label,
          email,
          connectors: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
