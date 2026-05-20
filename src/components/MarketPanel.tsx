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
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type PluginType = "mcp" | "skill" | "integration";

interface Plugin {
  id: string;
  name: string;
  author: string;
  description: string;
  type: PluginType;
  installs: number;
  iconUrl: string | null;
  homepage: string;
  verified: boolean;
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
}

interface SmitheryResponse {
  servers: SmitheryServer[];
  pagination: {
    currentPage: number;
    pageSize: number;
    totalPages: number;
    totalCount: number;
  };
}

function mapServer(s: SmitheryServer): Plugin {
  return {
    id: s.qualifiedName || s.id,
    name: s.displayName || s.qualifiedName,
    author: s.owner || "Community",
    description: s.description || "",
    type: "mcp",
    installs: s.useCount ?? 0,
    iconUrl: s.iconUrl ?? null,
    homepage: s.homepage || `https://smithery.ai/server/${s.slug}`,
    verified: s.verified ?? false,
  };
}

async function fetchSmithery(
  query: string,
  page: number,
): Promise<{ plugins: Plugin[]; totalCount: number; totalPages: number }> {
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  const res = await fetch(`${SMITHERY_BASE}?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: SmitheryResponse = await res.json();
  return {
    plugins: data.servers.map(mapServer),
    totalCount: data.pagination.totalCount,
    totalPages: data.pagination.totalPages,
  };
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
  const initial = plugin.name.charAt(0).toUpperCase();

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
      {initial}
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

// ── Add plugin view ───────────────────────────────────────────────────────────

function AddPluginView({ onBack }: { onBack: () => void }) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  const handleInstall = () => {
    if (!url.trim()) return;
    setStatus("loading");
    // Placeholder — wire up to real MCP install logic
    setTimeout(() => setStatus("error"), 1500);
  };

  return (
    <div className="market-add-view">
      <div className="market-add-header">
        <button className="market-back-btn" onClick={onBack}>
          <ArrowLeft size={13} />
          Back
        </button>
        <h2 className="market-add-title">Add Plugin</h2>
        <p className="market-add-subtitle">
          Install an MCP server, skill, or integration by URL — or browse one of the registries below to find a plugin URL to paste here.
        </p>
      </div>

      <div className="market-add-section">
        <label className="market-add-label">Plugin URL or Package Name</label>
        <p className="market-add-hint">
          Paste an MCP server URL, npm package name (e.g. <code>@modelcontextprotocol/server-github</code>), or GitHub repo URL.
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
            <AlertCircle size={12} />
            Could not install from that URL. Check the address and try again.
          </p>
        )}
        {status === "success" && (
          <p className="market-url-feedback market-url-feedback--success">
            <CheckCircle size={12} />
            Plugin installed successfully.
          </p>
        )}
      </div>

      <div className="market-add-section">
        <label className="market-add-label">Online Registries</label>
        <p className="market-add-hint">Browse these directories, then copy a plugin URL and paste it above.</p>
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
          <div className="market-type-card">
            <Puzzle size={15} className="market-type-icon" />
            <div>
              <div className="market-type-name">MCP Servers</div>
              <div className="market-type-desc">Model Context Protocol servers that extend Claude with external tools and data sources.</div>
            </div>
          </div>
          <div className="market-type-card">
            <Zap size={15} className="market-type-icon" />
            <div>
              <div className="market-type-name">Claude Skills</div>
              <div className="market-type-desc">Reusable prompt templates and workflows that teach Claude specialised behaviours.</div>
            </div>
          </div>
          <div className="market-type-card">
            <Globe size={15} className="market-type-icon" />
            <div>
              <div className="market-type-name">Integrations</div>
              <div className="market-type-desc">Pre-built service connections with OAuth and configuration handled automatically.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Plugin card ───────────────────────────────────────────────────────────────

function PluginCard({
  plugin,
  installed,
  onToggle,
}: {
  plugin: Plugin;
  installed: boolean;
  onToggle: (plugin: Plugin) => void;
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
          onClick={() => onToggle(plugin)}
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

  // Live data from Smithery
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  // Installed plugins — persisted to localStorage so they survive unmounts
  const [installed, setInstalled] = useState<Map<string, Plugin>>(() => {
    try {
      const raw = localStorage.getItem("market-installed");
      if (raw) return new Map(JSON.parse(raw) as [string, Plugin][]);
    } catch {}
    return new Map();
  });

  useEffect(() => {
    try {
      localStorage.setItem("market-installed", JSON.stringify(Array.from(installed.entries())));
    } catch {}
  }, [installed]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Debounce search ──
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // ── Fetch first page whenever query changes ──
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
      if (e.name !== "AbortError") {
        setError("Could not reach the plugin registry. Check your internet connection.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "browse") loadPlugins(debouncedQuery);
  }, [debouncedQuery, view, loadPlugins]);

  // ── Load next page ──
  const loadMore = useCallback(async () => {
    if (loadingMore || loading || currentPage >= totalPages) return;
    const nextPage = currentPage + 1;
    setLoadingMore(true);
    try {
      const result = await fetchSmithery(debouncedQuery, nextPage);
      setPlugins((prev) => [...prev, ...result.plugins]);
      setCurrentPage(nextPage);
    } catch {
      // silently ignore load-more failures
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, loading, currentPage, totalPages, debouncedQuery]);

  // ── Infinite scroll sentinel ──
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

  // ── Install / remove ──
  const handleToggle = (plugin: Plugin) => {
    setInstalled((prev) => {
      const next = new Map(prev);
      if (next.has(plugin.id)) {
        next.delete(plugin.id);
      } else {
        next.set(plugin.id, plugin);
      }
      return next;
    });
  };

  const handleViewChange = (v: View) => {
    setView(v);
    setSearchQuery("");
  };

  const installedList = Array.from(installed.values());
  const installedCount = installedList.length;
  const hasMore = currentPage < totalPages;

  // ── Render browse grid ──
  const renderBrowse = () => {
    if (error) {
      return (
        <div className="market-empty">
          <AlertCircle size={28} />
          <p>{error}</p>
          <button className="market-empty-cta" onClick={() => loadPlugins(debouncedQuery)}>
            Retry
            <ChevronRight size={12} />
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

    if (!loading && plugins.length === 0) {
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
          {plugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              installed={installed.has(plugin.id)}
              onToggle={handleToggle}
            />
          ))}
          {loadingMore &&
            Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={`more-${i}`} />)
          }
        </div>
        {hasMore ? (
          <div ref={sentinelRef} className="market-sentinel" />
        ) : (
          <div className="market-end">
            {totalCount.toLocaleString()} plugins total · page {currentPage} of {totalPages}
          </div>
        )}
      </>
    );
  };

  const renderInstalled = () => {
    if (installedList.length === 0) {
      return (
        <div className="market-empty">
          <Package size={28} />
          <p>No plugins installed yet.</p>
          <button className="market-empty-cta" onClick={() => handleViewChange("browse")}>
            Browse marketplace
            <ChevronRight size={12} />
          </button>
        </div>
      );
    }
    return (
      <div className="market-grid">
        {installedList.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            installed
            onToggle={handleToggle}
          />
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
            {totalCount > 0 && view === "browse"
              ? `${totalCount.toLocaleString()} plugins`
              : "MCP Plugins & Skills"}
          </span>
        </div>
        <div className="market-header-right">
          <button className="market-add-plugin-btn" onClick={() => handleViewChange("add")}>
            <Plus size={12} />
            Add Plugin
          </button>
          <button className="market-close-btn" onClick={onClose} aria-label="Close marketplace">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ── Toolbar ── */}
      {view !== "add" && (
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
              {installedCount > 0 && (
                <span className="market-tab-badge">{installedCount}</span>
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
