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
  Palette,
} from "lucide-react";
import { useTheme } from "../hooks/useTheme.js";
import type { AppThemeId, CustomColors } from "../hooks/useTheme.js";
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

type View = "browse" | "installed" | "themes";

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

// ── Syntax code preview ───────────────────────────────────────────────────────

function SyntaxCodePreview({ colors, dark }: { colors: SyntaxThemeDef["colors"]; dark: boolean }) {
  const fg = dark ? "#c8c8d0" : "#2d2d35";
  const dim = dark ? "rgba(200,200,210,0.45)" : "rgba(30,30,40,0.4)";

  const K = (t: string) => <span style={{ color: colors.keyword }}>{t}</span>;
  const F = (t: string) => <span style={{ color: colors.fn }}>{t}</span>;
  const S = (t: string) => <span style={{ color: colors.string }}>{t}</span>;
  const C = (t: string) => <span style={{ color: colors.comment }}>{t}</span>;
  const D = (t: string) => <span style={{ color: dim }}>{t}</span>;

  return (
    <div className="market-syntax-preview-pane" style={{ background: colors.bg, color: fg }}>
      {C("// TypeScript — syntax preview")}{"\n"}
      {K("interface")} {F("Animal")} {D("{")}{"\n"}
      {"  "}{F("name")}{D(": ")}{F("string")}{D(";")}{"\n"}
      {"  "}{F("sound")}{D(": ")}{F("string")}{D(";")}{"\n"}
      {D("}")}{"\n\n"}
      {C("// Factory function")}{"\n"}
      {K("function")} {F("create")}{D("(")}{F("name")}{D(": ")}{F("string")}{D(", ")}{F("sound")}{D(": ")}{F("string")}{D("): ")}{F("Animal")} {D("{")}{"\n"}
      {"  "}{K("return")} {D("{ name, sound };")}{"\n"}
      {D("}")}{"\n\n"}
      {K("const")} {"cat"} {D("= ")}{F("create")}{D("(")}{S('"Whiskers"')}{D(", ")}{S('"meow"')}{D(");")}{"\n"}
      {K("const")} {"dog"} {D("= ")}{F("create")}{D("(")}{S('"Rex"')}{D(", ")}{S('"woof"')}{D(");")}{"\n\n"}
      {K("class")} {F("Zoo")} {D("{")}{"\n"}
      {"  "}{K("private")} {"list"}{D(": ")}{F("Animal")}{D("[] = [];")}{"\n\n"}
      {"  "}{F("add")}{D("(")}{F("animal")}{D(": ")}{F("Animal")}{D("): ")}{K("void")} {D("{")}{"\n"}
      {"    "}{"this.list."}{F("push")}{D("(animal);")}{"\n"}
      {"  "}{D("}")}{"\n\n"}
      {"  "}{F("greet")}{D("(): ")}{F("string")}{D("[] {")}{"\n"}
      {"    "}{K("return")} {"this.list."}{F("map")}{D("(")}{"\n"}
      {"      "}{D("(a) => ")}{S("`${a.name} says \"${a.sound}\"`")}{"\n"}
      {"    "}{D(");")}{"\n"}
      {"  "}{D("}")}{"\n"}
      {D("}")}{"\n\n"}
      {K("const")} {"zoo"} {D("= ")} {K("new")} {F("Zoo")}{D("();")}{"\n"}
      {"zoo."}{F("add")}{D("(cat);")} {"zoo."}{F("add")}{D("(dog);")}{"\n"}
      {C("// => [\"Whiskers says \\\"meow\\\"\", \"Rex says \\\"woof\\\"\"]")}
    </div>
  );
}

// ── Theme definitions ─────────────────────────────────────────────────────────

interface AppThemeDef {
  id: AppThemeId;
  name: string;
  description: string;
  accent: string;
  bg: string;
  secondary: string;
  foreground: string;
}

const APP_THEMES: AppThemeDef[] = [
  { id: "sunset", name: "Sunset", description: "Warm orange — the classic buildover style", accent: "#d97757", bg: "#181818", secondary: "#1e1e1e", foreground: "#cccccc" },
  { id: "arctic", name: "Arctic", description: "Cool silver steel, calm and minimal", accent: "#8aafc2", bg: "#1a1a1e", secondary: "#1f1f26", foreground: "#cfd4dc" },
  { id: "ocean", name: "Ocean", description: "Deep blue, GitHub-inspired dark mode", accent: "#4d8cc8", bg: "#0d1117", secondary: "#161b22", foreground: "#c9d1d9" },
];

interface SyntaxThemeDef {
  id: string;
  name: string;
  dark: boolean;
  colors: { bg: string; keyword: string; string: string; comment: string; fn: string };
}

const SYNTAX_THEMES: SyntaxThemeDef[] = [
  { id: "default", name: "VS Dark+ (default)", dark: true, colors: { bg: "#1e1e1e", keyword: "#569cd6", string: "#ce9178", comment: "#6a9955", fn: "#dcdcaa" } },
  { id: "atom-one-dark", name: "Atom One Dark", dark: true, colors: { bg: "#282c34", keyword: "#c678dd", string: "#98c379", comment: "#5c6370", fn: "#61afef" } },
  { id: "github-dark", name: "GitHub Dark", dark: true, colors: { bg: "#0d1117", keyword: "#ff7b72", string: "#a5d6ff", comment: "#8b949e", fn: "#d2a8ff" } },
  { id: "monokai-sublime", name: "Monokai", dark: true, colors: { bg: "#23241f", keyword: "#f92672", string: "#e6db74", comment: "#75715e", fn: "#a6e22e" } },
  { id: "nord", name: "Nord", dark: true, colors: { bg: "#2e3440", keyword: "#81a1c1", string: "#a3be8c", comment: "#4c566a", fn: "#88c0d0" } },
  { id: "night-owl", name: "Night Owl", dark: true, colors: { bg: "#011627", keyword: "#c792ea", string: "#addb67", comment: "#637777", fn: "#82aaff" } },
  { id: "dracula", name: "Dracula", dark: true, colors: { bg: "#282a36", keyword: "#ff79c6", string: "#f1fa8c", comment: "#6272a4", fn: "#50fa7b" } },
  { id: "tokyo-night-dark", name: "Tokyo Night", dark: true, colors: { bg: "#1a1b26", keyword: "#bb9af7", string: "#9ece6a", comment: "#565f89", fn: "#7aa2f7" } },
  { id: "an-old-hope", name: "An Old Hope", dark: true, colors: { bg: "#1c1c1c", keyword: "#eb6772", string: "#f99157", comment: "#666666", fn: "#5cb3fa" } },
  { id: "agate", name: "Agate", dark: true, colors: { bg: "#333", keyword: "#7ec699", string: "#e6db74", comment: "#998099", fn: "#cccccc" } },
  { id: "androidstudio", name: "Android Studio", dark: true, colors: { bg: "#282b2e", keyword: "#cc7832", string: "#6a8759", comment: "#808080", fn: "#ffc66d" } },
  { id: "github", name: "GitHub Light", dark: false, colors: { bg: "#fff", keyword: "#d73a49", string: "#032f62", comment: "#6a737d", fn: "#6f42c1" } },
  { id: "atom-one-light", name: "Atom One Light", dark: false, colors: { bg: "#fafafa", keyword: "#a626a4", string: "#50a14f", comment: "#a0a1a7", fn: "#4078f2" } },
  { id: "intellij-light", name: "IntelliJ Light", dark: false, colors: { bg: "#ffffff", keyword: "#0033b3", string: "#067d17", comment: "#8c8c8c", fn: "#7a7a43" } },
  { id: "xcode", name: "Xcode", dark: false, colors: { bg: "#fff", keyword: "#aa0d91", string: "#1c00cf", comment: "#236e25", fn: "#3900a0" } },
];

// ── Main panel ────────────────────────────────────────────────────────────────

export function MarketPanel({ onClose }: Props) {
  const { appTheme, syntaxTheme, customColors, setAppTheme, setSyntaxTheme, setCustomColor } = useTheme();
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedSyntaxId, setSelectedSyntaxId] = useState<string>(syntaxTheme ?? "default");

  // Keep syntax preview in sync with applied theme when view changes
  useEffect(() => {
    setSelectedSyntaxId(syntaxTheme ?? "default");
  }, [syntaxTheme]);

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

  const contentRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Infinite scroll ──────────────────────────────────────────────────────────
  //
  // Pattern: render-time function ref + callback ref on the sentinel element.
  //
  // loadMoreFn.current is reassigned on every render so it always closes over
  // the latest currentPage / totalPages / debouncedQuery — no stale values.
  //
  // sentinelRef is a callback ref: the browser calls it with the DOM node when
  // the sentinel mounts (hasMore → true) and with null when it unmounts.
  // We create / destroy the IntersectionObserver exactly then — never on
  // unrelated state changes like loadingMore or currentPage.
  const loadingMoreRef = useRef(false);
  const loadMoreFn = useRef<() => void>(() => {});
  loadMoreFn.current = async () => {
    if (loadingMoreRef.current || currentPage >= totalPages) return;
    const nextPage = currentPage + 1;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await fetchSmithery(debouncedQuery, nextPage);
      setPlugins((prev) => [...prev, ...result.plugins]);
      setCurrentPage(nextPage);
    } catch {
      // silently ignore
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  const ioRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    ioRef.current?.disconnect();
    ioRef.current = null;
    if (!node) return;
    ioRef.current = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMoreFn.current(); },
      { rootMargin: "150px" },
    );
    ioRef.current.observe(node);
  }, []); // stable — reads through loadMoreFn ref, never needs to be recreated

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
    setTotalPages(1);
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
    setShowAddModal(false);
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
    return (
      <>
        <div className="market-grid">
          {/* Add Plugin card — always first */}
          <button
            className="market-plugin-card market-add-plugin-card"
            onClick={() => setShowAddModal(true)}
          >
            <div className="market-add-plugin-icon-wrap">
              <Plus size={16} />
            </div>
            <span className="market-add-plugin-label">Add Plugin</span>
            <span className="market-add-plugin-sublabel">Connect an MCP server via URL or package</span>
          </button>

          {loading
            ? Array.from({ length: PAGE_SIZE }).map((_, i) => <SkeletonCard key={i} />)
            : plugins.map((p) => (
                <PluginCard
                  key={p.id}
                  plugin={p}
                  installed={installedIds.has(p.id)}
                  onInstallClick={setConfiguringPlugin}
                  onRemove={handleRemove}
                />
              ))
          }
          {loadingMore && Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={`more-${i}`} />)}
        </div>

        {!loading && plugins.length === 0 && (
          <div className="market-empty">
            <Package size={28} />
            <p>No plugins found for "{debouncedQuery}"</p>
          </div>
        )}

        {!loading && (hasMore
          ? <div ref={sentinelRef} className="market-sentinel" />
          : plugins.length > 0
            ? <div className="market-end">{totalCount.toLocaleString()} plugins total · page {currentPage} of {totalPages}</div>
            : null
        )}
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

  function getDefaultColor(theme: AppThemeId, key: keyof CustomColors): string {
    const defaults: Record<AppThemeId, Record<keyof CustomColors, string>> = {
      sunset:  { accent: "#d97757", accentHover: "#c6613f", background: "#181818", secondaryBackground: "#1e1e1e", foreground: "#cccccc", border: "#2b2b2b" },
      arctic:  { accent: "#8aafc2", accentHover: "#6a96b0", background: "#1a1a1e", secondaryBackground: "#1f1f26", foreground: "#cfd4dc", border: "#2e2e38" },
      ocean:   { accent: "#4d8cc8", accentHover: "#3c7ab8", background: "#0d1117", secondaryBackground: "#161b22", foreground: "#c9d1d9", border: "#21262d" },
    };
    return defaults[theme][key];
  }

  const renderThemes = () => {
    const activeSyntax = SYNTAX_THEMES.find((t) => t.id === selectedSyntaxId) ?? SYNTAX_THEMES[0]!;

    return (
      <div className="market-themes">
        {/* App Themes */}
        <div className="market-themes-section">
          <div className="market-themes-section-title">App Theme</div>
          <div className="market-themes-section-subtitle">Controls the background, sidebar, and accent color across the whole app.</div>
          <div className="market-app-themes-grid">
            {APP_THEMES.map((t) => (
              <button
                key={t.id}
                className={`market-app-theme-card ${appTheme === t.id ? "market-app-theme-card--active" : ""}`}
                onClick={() => setAppTheme(t.id)}
                style={{ "--theme-bg": t.bg, "--theme-secondary": t.secondary, "--theme-accent": t.accent, "--theme-fg": t.foreground } as React.CSSProperties}
              >
                <div className="market-app-theme-preview">
                  {/* Activity bar — thin strip of icon squares */}
                  <div className="market-app-theme-activity">
                    <div className="market-app-theme-activity-icon market-app-theme-activity-icon--active" />
                    <div className="market-app-theme-activity-icon" />
                    <div className="market-app-theme-activity-icon" />
                    <div className="market-app-theme-activity-icon" />
                  </div>
                  {/* Sidebar: search bar + new-chat button + session rows */}
                  <div className="market-app-theme-sidebar">
                    <div className="market-app-theme-sidebar-search" />
                    <div className="market-app-theme-sidebar-new" />
                    <div className="market-app-theme-sidebar-sessions">
                      <div className="market-app-theme-session" style={{ width: "90%" }} />
                      <div className="market-app-theme-session market-app-theme-session--active" style={{ width: "88%" }} />
                      <div className="market-app-theme-session" style={{ width: "75%" }} />
                      <div className="market-app-theme-session" style={{ width: "82%" }} />
                    </div>
                  </div>
                  {/* Main chat: message skeletons + composer with send button */}
                  <div className="market-app-theme-main">
                    <div className="market-app-theme-msg" style={{ width: "82%" }} />
                    <div className="market-app-theme-msg market-app-theme-msg--accent" style={{ width: "68%" }} />
                    <div className="market-app-theme-msg" style={{ width: "60%" }} />
                    <div className="market-app-theme-msg" style={{ width: "75%" }} />
                    <div className="market-app-theme-composer">
                      <div className="market-app-theme-composer-btn" />
                    </div>
                  </div>
                </div>
                <div className="market-app-theme-footer">
                  <span className="market-app-theme-name">{t.name}</span>
                  {appTheme === t.id && <CheckCircle size={12} className="market-app-theme-check" />}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Custom Colors */}
        <div className="market-themes-section">
          <div className="market-themes-section-title">Custom Colors</div>
          <div className="market-themes-section-subtitle">Override individual colors for the active theme.</div>
          <div className="market-custom-colors-grid">
            {([
              { key: "accent" as keyof CustomColors, label: "Accent" },
              { key: "background" as keyof CustomColors, label: "Background" },
              { key: "secondaryBackground" as keyof CustomColors, label: "Sec. BG" },
              { key: "foreground" as keyof CustomColors, label: "Text" },
              { key: "border" as keyof CustomColors, label: "Border" },
            ] as const).map(({ key, label }) => (
              <div key={key} className="market-custom-color-item">
                <div className="market-custom-color-swatch-wrap">
                  <div
                    className="market-custom-color-swatch"
                    style={{ background: customColors[key] ?? getDefaultColor(appTheme, key) }}
                  />
                  <input
                    type="color"
                    className="market-custom-color-input"
                    value={customColors[key] ?? getDefaultColor(appTheme, key)}
                    onChange={(e) => setCustomColor(key, e.target.value)}
                  />
                  {customColors[key] && (
                    <button
                      className="market-custom-color-reset"
                      onClick={(e) => { e.stopPropagation(); setCustomColor(key, null); }}
                      title="Reset"
                    >
                      ×
                    </button>
                  )}
                </div>
                <span className="market-custom-color-label">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Syntax Highlighting */}
        <div className="market-themes-section">
          <div className="market-themes-section-title">Syntax Highlighting</div>
          <div className="market-themes-section-subtitle">Choose a code color scheme. Click a theme to apply and preview it.</div>
          <div className="market-syntax-themes-layout">
            {/* List */}
            <div className="market-syntax-themes-list">
              {SYNTAX_THEMES.map((t) => {
                const isActive = t.id === selectedSyntaxId;
                return (
                  <button
                    key={t.id}
                    className={`market-syntax-theme-item ${isActive ? "market-syntax-theme-item--active" : ""}`}
                    onClick={() => {
                      setSelectedSyntaxId(t.id);
                      setSyntaxTheme(t.id === "default" ? null : t.id);
                    }}
                  >
                    <span className="market-syntax-theme-item-name">{t.name}</span>
                    {isActive && <CheckCircle size={10} className="market-syntax-theme-item-check" />}
                  </button>
                );
              })}
            </div>

            {/* IDE Preview */}
            <SyntaxCodePreview colors={activeSyntax.colors} dark={activeSyntax.dark} />
          </div>
        </div>
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
          <button className="market-close-btn" onClick={onClose} aria-label="Close marketplace">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ── Toolbar ── */}
      {(
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
            <button
              className={`market-tab ${view === "themes" ? "active" : ""}`}
              onClick={() => handleViewChange("themes")}
            >
              <Palette size={11} />
              Themes
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
      <div className="market-content" ref={contentRef}>
        <div className="market-content-inner">
          {view === "browse" ? renderBrowse() : view === "themes" ? renderThemes() : renderInstalled()}
        </div>
      </div>

      {/* ── Add Plugin Modal ── */}
      {showAddModal && (
        <div className="market-modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div className="market-modal" onClick={(e) => e.stopPropagation()}>
            <button className="market-modal-close" onClick={() => setShowAddModal(false)}>
              <X size={14} />
            </button>
            <AddPluginView onBack={() => setShowAddModal(false)} />
          </div>
        </div>
      )}

      {/* ── Configure Plugin Modal ── */}
      {configuringPlugin && (
        <div className="market-modal-backdrop" onClick={() => setConfiguringPlugin(null)}>
          <div className="market-modal" onClick={(e) => e.stopPropagation()}>
            <button className="market-modal-close" onClick={() => setConfiguringPlugin(null)}>
              <X size={14} />
            </button>
            <ConfigurePluginView
              plugin={configuringPlugin}
              onInstall={handleInstall}
              onCancel={() => setConfiguringPlugin(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
