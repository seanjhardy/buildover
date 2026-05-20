import { useState, useEffect, useRef, useCallback } from "react";
import {
  X,
  Search,
  Package,
  Download,
  CheckCircle,
  Plus,
  ExternalLink,
  Puzzle,
  Zap,
  Globe,
  ChevronRight,
  ArrowLeft,
  BadgeCheck,
  AlertCircle,
  Loader2,
  Trash2,
} from "lucide-react";
import type { InstalledMcpServer, McpServerType } from "../types";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Plugin {
  id: string;
  name: string;
  author: string;
  description: string;
  installs: number;
  iconUrl: string | null;
  homepage: string;
  verified: boolean;
  isDeployed: boolean;
}

type View = "browse" | "installed" | "add";

interface Props {
  onClose: () => void;
}

// ── Smithery API ──────────────────────────────────────────────────────────────

const SMITHERY_BASE = "https://registry.smithery.ai/servers";
const PAGE_SIZE = 20;

interface SmitheryServer {
  id: string;
  qualifiedName: string;
  displayName: string;
  description: string;
  iconUrl: string | null;
  verified: boolean;
  useCount: number;
  owner: string;
  homepage: string;
  slug: string;
  isDeployed: boolean;
}

function mapServer(s: SmitheryServer): Plugin {
  return {
    id: s.qualifiedName || s.id,
    name: s.displayName || s.qualifiedName,
    author: s.owner || "Community",
    description: s.description || "",
    installs: s.useCount ?? 0,
    iconUrl: s.iconUrl ?? null,
    homepage: s.homepage || `https://smithery.ai/server/${s.slug}`,
    verified: s.verified ?? false,
    isDeployed: s.isDeployed ?? false,
  };
}

async function fetchSmithery(query: string, page: number) {
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  const res = await fetch(`${SMITHERY_BASE}?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    plugins: (data.servers as SmitheryServer[]).map(mapServer),
    totalCount: data.pagination.totalCount as number,
    totalPages: data.pagination.totalPages as number,
  };
}

// ── Local API helpers ─────────────────────────────────────────────────────────

async function apiGetInstalled(): Promise<InstalledMcpServer[]> {
  const res = await fetch("/api/mcp-servers");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiInstall(server: InstalledMcpServer): Promise<void> {
  const res = await fetch("/api/mcp-servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(server),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function apiRemove(id: string): Promise<void> {
  const res = await fetch(`/api/mcp-servers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── Registries ────────────────────────────────────────────────────────────────

const REGISTRIES = [
  { name: "Smithery", description: "5,000+ MCP servers — the source used above", url: "https://smithery.ai", icon: "⚒️" },
  { name: "mcp.so", description: "Official MCP plugin registry", url: "https://mcp.so", icon: "🌐" },
  { name: "Glama", description: "Open MCP server catalogue", url: "https://glama.ai/mcp/servers", icon: "✨" },
  { name: "PulseMCP", description: "Community-driven plugin index", url: "https://pulsemcp.com", icon: "💡" },
];

// ── Plugin icon ───────────────────────────────────────────────────────────────

function PluginIcon({ plugin }: { plugin: Plugin }) {
  const [imgFailed, setImgFailed] = useState(false);
  if (plugin.iconUrl && !imgFailed) {
    return (
      <img
        className="market-plugin-icon-img"
        src={plugin.iconUrl}
        alt=""
        onError={() => setImgFailed(true)}
      />
    );
  }
  return (
    <span className="market-plugin-icon-fallback" aria-label={plugin.name}>
      {plugin.name.charAt(0).toUpperCase()}
    </span>
  );
}

// ── Skeleton card ─────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="market-plugin-card market-skeleton-card">
      <div className="market-plugin-card-top">
        <div className="market-skel market-skel-icon" />
        <div className="market-plugin-meta">
          <div className="market-skel market-skel-title" />
          <div className="market-skel market-skel-author" />
        </div>
      </div>
      <div className="market-skel market-skel-desc" />
      <div className="market-skel market-skel-desc market-skel-desc--short" />
    </div>
  );
}

// ── Configure & install view ──────────────────────────────────────────────────

interface KVPair { key: string; value: string }

function KVEditor({
  label,
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  pairs: KVPair[];
  onChange: (pairs: KVPair[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const add = () => onChange([...pairs, { key: "", value: "" }]);
  const remove = (i: number) => onChange(pairs.filter((_, j) => j !== i));
  const update = (i: number, field: "key" | "value", val: string) =>
    onChange(pairs.map((p, j) => (j === i ? { ...p, [field]: val } : p)));

  return (
    <div className="market-kv-editor">
      <div className="market-kv-header">
        <span className="market-add-label">{label}</span>
        <button className="market-kv-add-btn" onClick={add} type="button">
          <Plus size={10} /> Add
        </button>
      </div>
      {pairs.length > 0 && (
        <div className="market-kv-rows">
          {pairs.map((p, i) => (
            <div key={i} className="market-kv-row">
              <input
                className="market-cfg-input"
                placeholder={keyPlaceholder}
                value={p.key}
                onChange={(e) => update(i, "key", e.target.value)}
              />
              <input
                className="market-cfg-input"
                placeholder={valuePlaceholder}
                value={p.value}
                onChange={(e) => update(i, "value", e.target.value)}
              />
              <button className="market-kv-del-btn" onClick={() => remove(i)} type="button">
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigurePluginView({
  plugin,
  onInstall,
  onCancel,
}: {
  plugin: Plugin;
  onInstall: (server: InstalledMcpServer) => Promise<void>;
  onCancel: () => void;
}) {
  const [type, setType] = useState<McpServerType>(plugin.isDeployed ? "http" : "stdio");
  const [command, setCommand] = useState("npx");
  const [argsText, setArgsText] = useState(`-y\n${plugin.id}`);
  const [url, setUrl] = useState(
    plugin.isDeployed ? `https://server.smithery.ai/${plugin.id}` : ""
  );
  const [envPairs, setEnvPairs] = useState<KVPair[]>([]);
  const [headerPairs, setHeaderPairs] = useState<KVPair[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pairsToRecord = (pairs: KVPair[]) =>
    Object.fromEntries(pairs.filter((p) => p.key).map((p) => [p.key, p.value]));

  const handleInstall = async () => {
    setError(null);
    if (type === "stdio" && !command.trim()) {
      setError("Command is required for stdio servers.");
      return;
    }
    if ((type === "sse" || type === "http") && !url.trim()) {
      setError("URL is required.");
      return;
    }
    setSaving(true);
    try {
      const server: InstalledMcpServer = {
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        type,
        ...(type === "stdio"
          ? {
              command: command.trim(),
              args: argsText.split("\n").map((s) => s.trim()).filter(Boolean),
              env: pairsToRecord(envPairs),
            }
          : {
              url: url.trim(),
              headers: pairsToRecord(headerPairs),
            }),
      };
      await onInstall(server);
    } catch (e: any) {
      setError(e.message ?? "Install failed.");
      setSaving(false);
    }
  };

  return (
    <div className="market-cfg-view">
      <div className="market-cfg-plugin-header">
        <PluginIcon plugin={plugin} />
        <div>
          <div className="market-cfg-plugin-name">{plugin.name}</div>
          <div className="market-cfg-plugin-author">{plugin.author}</div>
        </div>
      </div>

      {plugin.description && (
        <p className="market-cfg-plugin-desc">{plugin.description}</p>
      )}

      {/* Connection type */}
      <div className="market-cfg-section">
        <span className="market-add-label">Connection Type</span>
        <div className="market-cfg-type-row">
          {(["stdio", "sse", "http"] as McpServerType[]).map((t) => (
            <button
              key={t}
              className={`market-cfg-type-btn ${type === t ? "active" : ""}`}
              onClick={() => setType(t)}
              type="button"
            >
              {t}
            </button>
          ))}
        </div>
        <p className="market-add-hint">
          {type === "stdio"
            ? "Runs a local subprocess (e.g. an npm package via npx)."
            : type === "sse"
            ? "Connects to a remote server over Server-Sent Events."
            : "Connects to a remote server over HTTP (Streamable HTTP)."}
        </p>
      </div>

      {/* stdio fields */}
      {type === "stdio" && (
        <>
          <div className="market-cfg-section">
            <label className="market-add-label">Command</label>
            <input
              className="market-cfg-input"
              placeholder="npx"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </div>
          <div className="market-cfg-section">
            <label className="market-add-label">Arguments <span className="market-cfg-hint-inline">(one per line)</span></label>
            <textarea
              className="market-cfg-textarea"
              placeholder={"-y\n@scope/my-mcp-server"}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              rows={3}
            />
          </div>
          <KVEditor
            label="Environment Variables"
            pairs={envPairs}
            onChange={setEnvPairs}
            keyPlaceholder="VARIABLE_NAME"
            valuePlaceholder="value"
          />
        </>
      )}

      {/* sse / http fields */}
      {(type === "sse" || type === "http") && (
        <>
          <div className="market-cfg-section">
            <label className="market-add-label">URL</label>
            <input
              className="market-cfg-input"
              placeholder="https://example.com/mcp"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <KVEditor
            label="Headers"
            pairs={headerPairs}
            onChange={setHeaderPairs}
            keyPlaceholder="Authorization"
            valuePlaceholder="Bearer token..."
          />
        </>
      )}

      {error && (
        <p className="market-url-feedback market-url-feedback--error">
          <AlertCircle size={12} /> {error}
        </p>
      )}

      <div className="market-cfg-actions">
        <button className="market-cfg-cancel-btn" onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className="market-cfg-install-btn"
          onClick={handleInstall}
          disabled={saving}
          type="button"
        >
          {saving ? <Loader2 size={12} className="market-spinner" /> : <Plus size={12} />}
          {saving ? "Installing…" : "Install"}
        </button>
      </div>
    </div>
  );
}

// ── Add-via-URL view ──────────────────────────────────────────────────────────

function AddPluginView({ onBack }: { onBack: () => void }) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  const handleInstall = () => {
    if (!url.trim()) return;
    setStatus("loading");
    setTimeout(() => setStatus("error"), 1500);
  };

  return (
    <div className="market-add-view">
      <div className="market-add-header">
        <button className="market-back-btn" onClick={onBack}>
          <ArrowLeft size={13} /> Back
        </button>
        <h2 className="market-add-title">Add Plugin</h2>
        <p className="market-add-subtitle">
          Install an MCP server by URL — or browse a registry below to find one.
        </p>
      </div>

      <div className="market-add-section">
        <label className="market-add-label">Plugin URL or Package Name</label>
        <p className="market-add-hint">
          Paste an MCP server URL, npm package name (e.g.{" "}
          <code>@modelcontextprotocol/server-github</code>), or GitHub repo URL.
        </p>
        <div className="market-url-row">
          <div className="market-url-input-wrap">
            <Globe size={13} className="market-url-icon" />
            <input
              className="market-url-input"
              type="text"
              placeholder="https://example.com/mcp.json  or  npm:my-mcp-server"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setStatus("idle"); }}
              onKeyDown={(e) => e.key === "Enter" && handleInstall()}
            />
          </div>
          <button
            className={`market-fetch-btn ${status === "loading" ? "loading" : ""}`}
            onClick={handleInstall}
            disabled={!url.trim() || status === "loading"}
          >
            {status === "loading" ? "Installing…" : "Install"}
          </button>
        </div>
        {status === "error" && (
          <p className="market-url-feedback market-url-feedback--error">
            <AlertCircle size={12} /> Could not install from that URL.
          </p>
        )}
        {status === "success" && (
          <p className="market-url-feedback market-url-feedback--success">
            <CheckCircle size={12} /> Plugin installed successfully.
          </p>
        )}
      </div>

      <div className="market-add-section">
        <label className="market-add-label">Online Registries</label>
        <p className="market-add-hint">Browse these directories, then copy a plugin URL to paste above.</p>
        <div className="market-registry-grid">
          {REGISTRIES.map((r) => (
            <a key={r.url} href={r.url} target="_blank" rel="noopener noreferrer" className="market-registry-card">
              <span className="market-registry-icon">{r.icon}</span>
              <div className="market-registry-info">
                <span className="market-registry-name">{r.name}</span>
                <span className="market-registry-desc">{r.description}</span>
              </div>
              <ExternalLink size={12} className="market-registry-link-icon" />
            </a>
          ))}
        </div>
      </div>

      <div className="market-add-section">
        <label className="market-add-label">Plugin Types</label>
        <div className="market-type-cards">
          {[
            { icon: <Puzzle size={15} />, name: "MCP Servers", desc: "Model Context Protocol servers that extend Claude with external tools and data sources." },
            { icon: <Zap size={15} />, name: "Claude Skills", desc: "Reusable prompt templates and workflows that teach Claude specialised behaviours." },
            { icon: <Globe size={15} />, name: "Integrations", desc: "Pre-built service connections with OAuth and configuration handled automatically." },
          ].map((t) => (
            <div key={t.name} className="market-type-card">
              <span className="market-type-icon">{t.icon}</span>
              <div>
                <div className="market-type-name">{t.name}</div>
                <div className="market-type-desc">{t.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Plugin card ───────────────────────────────────────────────────────────────

function PluginCard({
  plugin,
  installed,
  onInstallClick,
  onRemove,
}: {
  plugin: Plugin;
  installed: boolean;
  onInstallClick: (plugin: Plugin) => void;
  onRemove: (plugin: Plugin) => void;
}) {
  return (
    <div className={`market-plugin-card ${installed ? "installed" : ""}`}>
      <div className="market-plugin-card-top">
        <PluginIcon plugin={plugin} />
        <div className="market-plugin-meta">
          <div className="market-plugin-name-row">
            <span className="market-plugin-name">{plugin.name}</span>
            {plugin.verified && <BadgeCheck size={11} className="market-plugin-verified" />}
            {installed && <CheckCircle size={11} className="market-plugin-check" />}
          </div>
          <span className="market-plugin-author">{plugin.author}</span>
        </div>
        {plugin.homepage && (
          <a
            href={plugin.homepage}
            target="_blank"
            rel="noopener noreferrer"
            className="market-plugin-ext-link"
            onClick={(e) => e.stopPropagation()}
            title="View on registry"
          >
            <ExternalLink size={11} />
          </a>
        )}
      </div>

      {plugin.description && (
        <p className="market-plugin-description">{plugin.description}</p>
      )}

      <div className="market-plugin-footer">
        <div className="market-plugin-stats">
          {plugin.installs > 0 && (
            <span title="Installs">
              <Download size={10} />
              {plugin.installs >= 1000
                ? `${(plugin.installs / 1000).toFixed(1)}k`
                : plugin.installs}
            </span>
          )}
        </div>
        <button
          className={`market-plugin-btn ${installed ? "remove" : "install"}`}
          onClick={() => installed ? onRemove(plugin) : onInstallClick(plugin)}
        >
          {installed ? "Remove" : "Install"}
        </button>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function MarketPanel({ onClose }: Props) {
  const [view, setView] = useState<View>("browse");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Smithery browse data
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  // Installed servers (from disk via API)
  const [installedServers, setInstalledServers] = useState<InstalledMcpServer[]>([]);
  const installedIds = new Set(installedServers.map((s) => s.id));

  // Config form
  const [configuringPlugin, setConfiguringPlugin] = useState<Plugin | null>(null);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load installed servers on mount
  useEffect(() => {
    apiGetInstalled().then(setInstalledServers).catch(console.error);
  }, []);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Fetch first page when query changes
  const loadPlugins = useCallback(async (query: string) => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    setError(null);
    setPlugins([]);
    setCurrentPage(1);
    if (contentRef.current) contentRef.current.scrollTop = 0;
    try {
      const result = await fetchSmithery(query, 1);
      setPlugins(result.plugins);
      setTotalPages(result.totalPages);
      setTotalCount(result.totalCount);
    } catch (e: any) {
      if (e.name !== "AbortError")
        setError("Could not reach the plugin registry. Check your internet connection.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "browse") loadPlugins(debouncedQuery);
  }, [debouncedQuery, view, loadPlugins]);

  // Load next page
  const loadMore = useCallback(async () => {
    if (loadingMore || loading || currentPage >= totalPages) return;
    const nextPage = currentPage + 1;
    setLoadingMore(true);
    try {
      const result = await fetchSmithery(debouncedQuery, nextPage);
      setPlugins((prev) => [...prev, ...result.plugins]);
      setCurrentPage(nextPage);
    } catch {
      // silently ignore
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, loading, currentPage, totalPages, debouncedQuery]);

  // Infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: "150px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  // Install: save to disk via API
  const handleInstall = async (server: InstalledMcpServer) => {
    await apiInstall(server);
    setInstalledServers(await apiGetInstalled());
    setConfiguringPlugin(null);
  };

  // Remove: delete from disk via API
  const handleRemove = async (plugin: Plugin) => {
    await apiRemove(plugin.id);
    setInstalledServers(await apiGetInstalled());
  };

  const handleViewChange = (v: View) => {
    setView(v);
    setSearchQuery("");
    setConfiguringPlugin(null);
  };

  const hasMore = currentPage < totalPages;

  // ── Render helpers ──

  const renderBrowse = () => {
    if (error) {
      return (
        <div className="market-empty">
          <AlertCircle size={28} />
          <p>{error}</p>
          <button className="market-empty-cta" onClick={() => loadPlugins(debouncedQuery)}>
            Retry <ChevronRight size={12} />
          </button>
        </div>
      );
    }
    if (loading) {
      return (
        <div className="market-grid">
          {Array.from({ length: PAGE_SIZE }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      );
    }
    if (plugins.length === 0) {
      return (
        <div className="market-empty">
          <Package size={28} />
          <p>No plugins found for "{debouncedQuery}"</p>
        </div>
      );
    }
    return (
      <>
        <div className="market-grid">
          {plugins.map((p) => (
            <PluginCard
              key={p.id}
              plugin={p}
              installed={installedIds.has(p.id)}
              onInstallClick={setConfiguringPlugin}
              onRemove={handleRemove}
            />
          ))}
          {loadingMore && Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={`more-${i}`} />)}
        </div>
        {hasMore
          ? <div ref={sentinelRef} className="market-sentinel" />
          : <div className="market-end">{totalCount.toLocaleString()} plugins total · page {currentPage} of {totalPages}</div>
        }
      </>
    );
  };

  const renderInstalled = () => {
    if (installedServers.length === 0) {
      return (
        <div className="market-empty">
          <Package size={28} />
          <p>No plugins installed yet.</p>
          <button className="market-empty-cta" onClick={() => handleViewChange("browse")}>
            Browse marketplace <ChevronRight size={12} />
          </button>
        </div>
      );
    }
    return (
      <div className="market-installed-list">
        {installedServers.map((s) => (
          <div key={s.id} className="market-installed-row">
            <div className="market-installed-row-left">
              <span className="market-plugin-icon-fallback market-installed-icon">
                {s.name.charAt(0).toUpperCase()}
              </span>
              <div className="market-installed-info">
                <span className="market-installed-name">{s.name}</span>
                <span className="market-installed-meta">
                  <span className={`market-installed-type market-installed-type--${s.type}`}>{s.type}</span>
                  <span className="market-installed-detail">
                    {s.type === "stdio" ? `${s.command} ${(s.args ?? []).join(" ")}` : s.url}
                  </span>
                </span>
              </div>
            </div>
            <button
              className="market-plugin-btn remove"
              onClick={() => handleRemove({ id: s.id, name: s.name, author: "", description: s.description ?? "", installs: 0, iconUrl: null, homepage: "", verified: false, isDeployed: false })}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="market-panel">
      {/* ── Header ── */}
      <div className="market-header">
        <div className="market-header-left">
          <Package size={14} className="market-header-icon" />
          <span className="market-header-title">Marketplace</span>
          <span className="market-header-sep">·</span>
          <span className="market-header-subtitle">
            {totalCount > 0 && view === "browse" && !configuringPlugin
              ? `${totalCount.toLocaleString()} plugins`
              : "MCP Plugins & Skills"}
          </span>
        </div>
        <div className="market-header-right">
          <button className="market-add-plugin-btn" onClick={() => handleViewChange("add")}>
            <Plus size={12} /> Add Plugin
          </button>
          <button className="market-close-btn" onClick={onClose} aria-label="Close marketplace">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ── Toolbar ── */}
      {view !== "add" && !configuringPlugin && (
        <div className="market-toolbar">
          <div className="market-tabs">
            <button
              className={`market-tab ${view === "browse" ? "active" : ""}`}
              onClick={() => handleViewChange("browse")}
            >
              Browse
            </button>
            <button
              className={`market-tab ${view === "installed" ? "active" : ""}`}
              onClick={() => handleViewChange("installed")}
            >
              Installed
              {installedServers.length > 0 && (
                <span className="market-tab-badge">{installedServers.length}</span>
              )}
            </button>
          </div>
          {view === "browse" && (
            <div className="market-toolbar-right">
              {loading && <Loader2 size={12} className="market-spinner" />}
              <div className="market-search-wrap">
                <Search size={12} className="market-search-icon" />
                <input
                  className="market-search-input"
                  type="text"
                  placeholder="Search 5,000+ plugins…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Content ── */}
      {view === "add" ? (
        <AddPluginView onBack={() => handleViewChange("browse")} />
      ) : configuringPlugin ? (
        <div className="market-content">
          <div className="market-cfg-wrap">
            <button className="market-back-btn" onClick={() => setConfiguringPlugin(null)}>
              <ArrowLeft size={13} /> Back
            </button>
            <ConfigurePluginView
              plugin={configuringPlugin}
              onInstall={handleInstall}
              onCancel={() => setConfiguringPlugin(null)}
            />
          </div>
        </div>
      ) : (
        <div className="market-content" ref={contentRef}>
          <div className="market-content-inner">
            {view === "browse" ? renderBrowse() : renderInstalled()}
          </div>
        </div>
      )}
    </div>
  );
}
