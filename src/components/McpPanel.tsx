import { useEffect, useState } from "react";
import type { McpServerInfo } from "../types.js";
import { api } from "../lib/api.js";
import { openExternalUrl } from "../lib/openExternalUrl.js";

interface Props {
  tools: string[];
  mcpServers: McpServerInfo[];
  cwd?: string;
  onClose: () => void;
}

// Sidebar panel that lists the harness's available tools and connected MCP
// servers. The system_init event from the SDK gives us both at session start.
// MCP tool names are conventionally prefixed `mcp__<server>__<tool>`, so we
// group native (un-prefixed) tools separately.
export function McpPanel({ tools, mcpServers, cwd, onClose }: Props) {
  const [filter, setFilter] = useState("");
  const filterLc = filter.toLowerCase();

  const grouped = groupTools(tools);
  const nativeMatches = grouped.native.filter((t) =>
    t.toLowerCase().includes(filterLc),
  );

  return (
    <aside className="mcp-panel">
      <div className="mcp-panel-head">
        <span>Tools & MCP</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {cwd && <div className="mcp-cwd">cwd · {cwd}</div>}
      <input
        className="mcp-filter"
        placeholder="Filter tools…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <section className="mcp-section">
        <div className="mcp-section-title">
          Built-in tools <span className="mcp-count">{nativeMatches.length}</span>
        </div>
        <ul className="mcp-list">
          {nativeMatches.map((t) => (
            <li key={t}>
              <span className="mcp-tool-name">{t}</span>
            </li>
          ))}
          {nativeMatches.length === 0 && (
            <li className="mcp-empty">No matches</li>
          )}
        </ul>
      </section>

      <section className="mcp-section">
        <div className="mcp-section-title">
          MCP servers <span className="mcp-count">{mcpServers.length}</span>
        </div>
        {mcpServers.length === 0 && (
          <div className="mcp-empty">No MCP servers configured.</div>
        )}
        {mcpServers.map((srv) => {
          const srvTools = (grouped.byServer.get(srv.name) ?? []).filter((t) =>
            t.toLowerCase().includes(filterLc),
          );
          return (
            <div key={srv.name} className="mcp-server">
              <div className="mcp-server-head">
                <span
                  className={`mcp-status mcp-status-${srv.status}`}
                  title={srv.status}
                />
                <span className="mcp-server-name">{srv.name}</span>
                <span className="mcp-count">{srvTools.length}</span>
              </div>
              {srv.status === "needs-auth" && <McpConnect server={srv.name} />}
              <ul className="mcp-list">
                {srvTools.map((t) => (
                  <li key={t}>
                    <span className="mcp-tool-name">
                      {stripPrefix(t, srv.name)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>
    </aside>
  );
}

// Sign-in for a remote server that reported `needs-auth`. The server opens the
// provider's page in the browser and stores the token globally once the user
// approves, so the server works from the next turn in every repo.
function McpConnect({ server }: { server: string }) {
  const [state, setState] = useState<"idle" | "pending" | "connected" | "failed">(
    "idle",
  );
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (state !== "pending") return;
    const timer = setInterval(async () => {
      try {
        const r = await api.getMcpAuthState(server);
        if (r.state === "connected" || r.state === "failed") {
          setState(r.state);
          setError(r.error);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(timer);
  }, [state, server]);

  const connect = async () => {
    setError(undefined);
    setState("pending");
    try {
      const r = await api.startMcpAuth(server);
      if (r.connected) setState("connected");
      else if (r.authUrl) openExternalUrl(r.authUrl);
    } catch (err) {
      setState("failed");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (state === "connected") {
    return <div className="mcp-auth-note">Signed in — available from your next message.</div>;
  }
  return (
    <div className="mcp-auth">
      <button className="mcp-auth-btn" onClick={connect} disabled={state === "pending"}>
        {state === "pending" ? "Waiting for sign-in…" : "Sign in"}
      </button>
      {state === "pending" && (
        <button className="mcp-auth-link" onClick={connect}>
          Retry
        </button>
      )}
      {error && <div className="mcp-auth-error">{error}</div>}
    </div>
  );
}

function groupTools(tools: string[]) {
  const native: string[] = [];
  const byServer = new Map<string, string[]>();
  for (const t of tools) {
    const m = t.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
    if (m) {
      const server = m[1];
      const list = byServer.get(server) ?? [];
      list.push(t);
      byServer.set(server, list);
    } else {
      native.push(t);
    }
  }
  return { native, byServer };
}

function stripPrefix(tool: string, server: string): string {
  const prefix = `mcp__${server}__`;
  return tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
}
