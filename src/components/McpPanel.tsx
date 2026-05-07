import { useState } from "react";
import type { McpServerInfo } from "../types.js";

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
