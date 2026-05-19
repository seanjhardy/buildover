import { useState, useMemo, useEffect, useRef } from "react";
import { X, Search, Package, Star, Download, CheckCircle } from "lucide-react";

interface Plugin {
  id: string;
  name: string;
  author: string;
  description: string;
  category: string;
  stars: number;
  installs: number;
  installed: boolean;
  featured?: boolean;
  icon: string;
}

const MOCK_PLUGINS: Plugin[] = [
  { id: "github-mcp", name: "GitHub", author: "Anthropic", description: "Search repos, manage issues, create PRs, and browse code directly from Claude.", category: "Dev Tools", stars: 4821, installs: 38200, installed: true, featured: true, icon: "🐙" },
  { id: "linear-mcp", name: "Linear", author: "Linear, Inc.", description: "Create and update issues, view cycles, and manage your Linear workspace.", category: "Project Mgmt", stars: 2340, installs: 14100, installed: false, featured: true, icon: "🔷" },
  { id: "slack-mcp", name: "Slack", author: "Anthropic", description: "Read channels, send messages, search conversations and manage notifications.", category: "Communication", stars: 3102, installs: 22800, installed: true, featured: true, icon: "💬" },
  { id: "notion-mcp", name: "Notion", author: "Notion Labs", description: "Read and write Notion pages, databases, and blocks from your workspace.", category: "Productivity", stars: 2891, installs: 19300, installed: false, icon: "📝" },
  { id: "postgres-mcp", name: "PostgreSQL", author: "Community", description: "Run queries, inspect schemas, and explore your PostgreSQL databases safely.", category: "Database", stars: 1678, installs: 11200, installed: false, icon: "🐘" },
  { id: "browser-mcp", name: "Browser Automation", author: "Anthropic", description: "Navigate web pages, click elements, fill forms, and capture screenshots.", category: "Automation", stars: 4120, installs: 31700, installed: false, featured: true, icon: "🌐" },
  { id: "figma-mcp", name: "Figma", author: "Community", description: "Inspect designs, extract styles, export assets, and read component specs.", category: "Design", stars: 1230, installs: 8900, installed: false, icon: "🎨" },
  { id: "jira-mcp", name: "Jira", author: "Atlassian", description: "Search tickets, create issues, update sprints, and track project progress.", category: "Project Mgmt", stars: 1890, installs: 13500, installed: false, icon: "📋" },
  { id: "aws-mcp", name: "AWS", author: "Community", description: "Query EC2, S3, Lambda, CloudWatch and more from the AWS cloud platform.", category: "Cloud", stars: 2100, installs: 9800, installed: false, icon: "☁️" },
  { id: "vercel-mcp", name: "Vercel", author: "Vercel, Inc.", description: "Deploy projects, read logs, manage domains, and inspect build output.", category: "Dev Tools", stars: 1540, installs: 10200, installed: false, icon: "▲" },
  { id: "google-drive-mcp", name: "Google Drive", author: "Anthropic", description: "Search, read, and create documents, spreadsheets, and presentations.", category: "Productivity", stars: 2760, installs: 17400, installed: false, icon: "📁" },
  { id: "sentry-mcp", name: "Sentry", author: "Community", description: "Investigate errors, view stack traces, and manage alert rules in Sentry.", category: "Dev Tools", stars: 980, installs: 6700, installed: false, icon: "🐛" },
  { id: "docker-mcp", name: "Docker", author: "Community", description: "Manage containers, inspect images, view logs, and orchestrate your Docker environment.", category: "Dev Tools", stars: 2890, installs: 21300, installed: false, icon: "🐳" },
  { id: "kubernetes-mcp", name: "Kubernetes", author: "Community", description: "Inspect pods, scale deployments, view cluster events, and manage k8s resources.", category: "Cloud", stars: 1940, installs: 13400, installed: false, icon: "⚙️" },
  { id: "mongodb-mcp", name: "MongoDB", author: "Community", description: "Query collections, aggregate documents, inspect indexes, and manage your databases.", category: "Database", stars: 1550, installs: 9200, installed: false, icon: "🍃" },
  { id: "redis-mcp", name: "Redis", author: "Community", description: "Get/set keys, inspect TTLs, view streams, and manage your Redis data structures.", category: "Database", stars: 1120, installs: 7400, installed: false, icon: "🔴" },
  { id: "stripe-mcp", name: "Stripe", author: "Stripe, Inc.", description: "Inspect payments, manage subscriptions, view customer data, and debug webhooks.", category: "Dev Tools", stars: 1780, installs: 12100, installed: false, icon: "💳" },
  { id: "twilio-mcp", name: "Twilio", author: "Community", description: "Send SMS and voice calls, inspect logs, and manage your Twilio account resources.", category: "Communication", stars: 890, installs: 5600, installed: false, icon: "📞" },
  { id: "discord-mcp", name: "Discord", author: "Community", description: "Read messages, manage servers, send notifications, and query your Discord guilds.", category: "Communication", stars: 2100, installs: 16800, installed: false, icon: "🎮" },
  { id: "trello-mcp", name: "Trello", author: "Atlassian", description: "Manage boards, create cards, move items between lists, and track progress.", category: "Project Mgmt", stars: 1340, installs: 8900, installed: false, icon: "📌" },
  { id: "asana-mcp", name: "Asana", author: "Community", description: "Create and update tasks, manage projects, assign work, and track deadlines.", category: "Project Mgmt", stars: 1190, installs: 7200, installed: false, icon: "🎯" },
  { id: "airtable-mcp", name: "Airtable", author: "Community", description: "Read and write Airtable bases, query records, and manage views and fields.", category: "Productivity", stars: 1670, installs: 11000, installed: false, icon: "🗂️" },
  { id: "obsidian-mcp", name: "Obsidian", author: "Community", description: "Read and write notes, search your vault, manage links, and explore your knowledge graph.", category: "Productivity", stars: 2340, installs: 15600, installed: false, icon: "💎" },
  { id: "playwright-mcp", name: "Playwright", author: "Anthropic", description: "Run end-to-end tests, navigate browsers headlessly, and capture screenshots and traces.", category: "Automation", stars: 3120, installs: 24100, installed: false, icon: "🎭" },
  { id: "github-actions-mcp", name: "GitHub Actions", author: "Anthropic", description: "Trigger workflows, view run logs, manage secrets, and monitor CI/CD pipelines.", category: "Dev Tools", stars: 2560, installs: 19800, installed: false, icon: "⚡" },
  { id: "terraform-mcp", name: "Terraform", author: "Community", description: "Plan and apply infrastructure changes, inspect state, and manage cloud resources.", category: "Cloud", stars: 1430, installs: 9100, installed: false, icon: "🏗️" },
  { id: "datadog-mcp", name: "Datadog", author: "Datadog, Inc.", description: "Query metrics, view dashboards, manage monitors, and investigate incidents.", category: "Dev Tools", stars: 1210, installs: 7800, installed: false, icon: "🐕" },
  { id: "shopify-mcp", name: "Shopify", author: "Community", description: "Manage products, orders, customers, and inventory in your Shopify store.", category: "Productivity", stars: 1890, installs: 13200, installed: false, icon: "🛒" },
  { id: "hubspot-mcp", name: "HubSpot", author: "Community", description: "Manage contacts, deals, and pipelines, and sync data with your CRM.", category: "Productivity", stars: 1100, installs: 7100, installed: false, icon: "🧲" },
  { id: "zendesk-mcp", name: "Zendesk", author: "Community", description: "View and update support tickets, manage agents, and track customer satisfaction.", category: "Communication", stars: 780, installs: 4900, installed: false, icon: "🎫" },
  { id: "confluence-mcp", name: "Confluence", author: "Atlassian", description: "Read and write pages, search spaces, manage comments, and view page trees.", category: "Project Mgmt", stars: 1020, installs: 6700, installed: false, icon: "📚" },
  { id: "gitlab-mcp", name: "GitLab", author: "Community", description: "Manage merge requests, issues, pipelines, and browse your GitLab repositories.", category: "Dev Tools", stars: 1760, installs: 12400, installed: false, icon: "🦊" },
  { id: "supabase-mcp", name: "Supabase", author: "Supabase, Inc.", description: "Query your database, manage auth users, and inspect real-time subscriptions.", category: "Database", stars: 2490, installs: 18700, installed: false, featured: true, icon: "⚡" },
  { id: "openai-mcp", name: "OpenAI API", author: "Community", description: "Call OpenAI models, manage assistants, inspect fine-tunes, and track token usage.", category: "Dev Tools", stars: 3400, installs: 28600, installed: false, featured: true, icon: "🤖" },
  { id: "gcal-mcp", name: "Google Calendar", author: "Anthropic", description: "Create events, view schedules, manage invites, and sync across your calendars.", category: "Productivity", stars: 2180, installs: 15400, installed: false, icon: "📅" },
  { id: "maps-mcp", name: "Google Maps", author: "Community", description: "Search locations, get directions, view place details, and geocode addresses.", category: "Productivity", stars: 1320, installs: 8900, installed: false, icon: "🗺️" },
];

const OWNER_DIALOGUES: Record<string, string> = {
  browse: "Welcome, traveller! My shelves are stocked with the finest MCP plugins in all the land. Browse away — no purchase necessary!",
  installed: "Ah, checking on your collection? Wise choice. A true craftsperson always tends their tools.",
  search: "Looking for something specific? The results update as you type — I know every plugin in this marketplace!",
};

type View = "browse" | "installed";

interface Props {
  onClose: () => void;
}

const PAGE_SIZE = 12;

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// ── Awning path helpers ──────────────────────────────────────────────────────

function buildScallops(fromX: number, toX: number, baseY: number, count: number): string {
  const step = (fromX - toX) / count;
  let d = "";
  for (let i = 0; i < count; i++) {
    const startX = fromX - i * step;
    const endX = fromX - (i + 1) * step;
    const midX = (startX + endX) / 2;
    d += ` Q ${midX.toFixed(1)},${baseY + 22} ${endX.toFixed(1)},${baseY}`;
  }
  return d;
}

// ── Storefront awning ────────────────────────────────────────────────────────

function StorefrontAwning() {
  const W = 1000;
  const hemY = 138;
  const topL = 72;
  const topR = W - topL;
  const numStripes = 22;

  // Trapezoid path: top narrow edge → right side → scalloped bottom → close (left side)
  const scallops = buildScallops(W, 0, hemY, numStripes);
  const awningPath = `M ${topL},0 L ${topR},0 L ${W},${hemY}${scallops} Z`;

  // Stripe polygons (parallelograms) — alternating shades
  const stripes = Array.from({ length: numStripes }, (_, i) => {
    const topWidth = topR - topL;
    const tl = (topL + (i / numStripes) * topWidth).toFixed(1);
    const tr = (topL + ((i + 1) / numStripes) * topWidth).toFixed(1);
    const bl = ((i / numStripes) * W).toFixed(1);
    const br = (((i + 1) / numStripes) * W).toFixed(1);
    return { pts: `${tl},0 ${tr},0 ${br},${hemY} ${bl},${hemY}`, i };
  });

  return (
    <div className="market-awning-wrap">
      <svg
        className="market-awning-svg"
        viewBox={`0 0 ${W} ${hemY + 26}`}
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* Wall backdrop */}
        <rect width={W} height={hemY + 26} fill="#14100c" />

        {/* Side depth triangles */}
        <polygon points={`0,0 ${topL},0 0,${hemY}`} fill="#1a0e08" />
        <polygon points={`${topR},0 ${W},0 ${W},${hemY}`} fill="#1a0e08" />

        {/* Clip path for stripes */}
        <defs>
          <clipPath id="awning-clip">
            <path d={awningPath} />
          </clipPath>
        </defs>

        {/* Awning base fill */}
        <path d={awningPath} fill="#2e1c0e" />

        {/* Alternating stripes (clipped) */}
        <g clipPath="url(#awning-clip)">
          {stripes.map(({ pts, i }) =>
            i % 2 === 1 ? (
              <polygon key={i} points={pts} fill="#3c2512" />
            ) : null
          )}
        </g>

        {/* Awning outline + hem */}
        <path d={awningPath} fill="none" stroke="#5a3820" strokeWidth="1.5" />
        {/* Decorative hem highlight */}
        <path
          d={`M ${W},${hemY}${scallops}`}
          fill="none"
          stroke="#7a5030"
          strokeWidth="2"
        />
      </svg>

      {/* Sign board — HTML overlay so it doesn't stretch with the SVG */}
      <div className="market-awning-sign">
        <div className="market-awning-sign-inner">
          <span className="market-awning-sign-title">PLUGIN MARKET</span>
          <span className="market-awning-sign-sub">MCP MARKETPLACE</span>
        </div>
      </div>
    </div>
  );
}

// ── Store owner ──────────────────────────────────────────────────────────────

function StoreOwner({ blinking }: { blinking: boolean }) {
  return (
    <svg
      className="market-owner-svg"
      viewBox="0 0 80 130"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Body */}
      <rect x="18" y="54" width="44" height="50" rx="4" fill="#2a2a2a" stroke="#3a3a3a" strokeWidth="1" />
      {/* Lapels */}
      <polygon points="36,54 28,72 36,72" fill="#222222" />
      <polygon points="44,54 52,72 44,72" fill="#222222" />
      {/* Buttons */}
      <circle cx="40" cy="76" r="2" fill="#444444" />
      <circle cx="40" cy="86" r="2" fill="#444444" />
      <circle cx="40" cy="96" r="2" fill="#444444" />
      {/* Apron */}
      <rect x="28" y="70" width="24" height="34" rx="2" fill="#252525" stroke="#333333" strokeWidth="1" />
      <rect x="32" y="82" width="10" height="9" rx="1" fill="#222222" stroke="#333333" strokeWidth="0.5" />

      {/* Left arm — welcoming, angled out */}
      <g transform="rotate(22 11 56)">
        <rect x="4" y="56" width="14" height="28" rx="6" fill="#2a2a2a" stroke="#3a3a3a" strokeWidth="1" />
        <ellipse cx="11" cy="87" rx="7" ry="6" fill="#383838" />
      </g>

      {/* Right arm — mirrored symmetric */}
      <g transform="rotate(-22 69 56)">
        <rect x="62" y="56" width="14" height="28" rx="6" fill="#2a2a2a" stroke="#3a3a3a" strokeWidth="1" />
        <ellipse cx="69" cy="87" rx="7" ry="6" fill="#383838" />
      </g>

      {/* Neck */}
      <rect x="33" y="42" width="14" height="14" rx="3" fill="#383838" />
      {/* Head */}
      <rect x="20" y="16" width="40" height="36" rx="10" fill="#404040" stroke="#4a4a4a" strokeWidth="1" />

      {/* Eyes */}
      {blinking ? (
        <>
          <rect x="27" y="30" width="8" height="2" rx="1" fill="#cccccc" />
          <rect x="45" y="30" width="8" height="2" rx="1" fill="#cccccc" />
        </>
      ) : (
        <>
          <ellipse cx="31" cy="31" rx="4" ry="5" fill="#cccccc" />
          <ellipse cx="49" cy="31" rx="4" ry="5" fill="#cccccc" />
          <ellipse cx="32" cy="31" rx="2" ry="3" fill="#222222" />
          <ellipse cx="50" cy="31" rx="2" ry="3" fill="#222222" />
          <circle cx="33" cy="29" r="1" fill="#ffffff" />
          <circle cx="51" cy="29" r="1" fill="#ffffff" />
        </>
      )}

      {/* Eyebrows */}
      <rect x="26" y="24" width="10" height="2" rx="1" fill="#555555" />
      <rect x="44" y="24" width="10" height="2" rx="1" fill="#555555" />
      {/* Smile */}
      <path d="M 30,40 Q 40,46 50,40" fill="none" stroke="#aaaaaa" strokeWidth="1.5" strokeLinecap="round" />

      {/* Hat brim */}
      <rect x="22" y="10" width="36" height="8" rx="2" fill="#333333" stroke="#444444" strokeWidth="1" />
      {/* Hat crown */}
      <rect x="28" y="2" width="24" height="12" rx="3" fill="#2e2e2e" stroke="#444444" strokeWidth="1" />
      {/* Hat band */}
      <rect x="22" y="14" width="36" height="3" fill="#444444" />

      {/* Legs */}
      <rect x="24" y="102" width="14" height="20" rx="3" fill="#252525" stroke="#333333" strokeWidth="1" />
      <rect x="42" y="102" width="14" height="20" rx="3" fill="#252525" stroke="#333333" strokeWidth="1" />
      {/* Shoes */}
      <ellipse cx="31" cy="122" rx="10" ry="5" fill="#1e1e1e" />
      <ellipse cx="49" cy="122" rx="10" ry="5" fill="#1e1e1e" />
    </svg>
  );
}

// ── Plant decoration column ──────────────────────────────────────────────────

function PlantDecoration({ side }: { side: "left" | "right" }) {
  return (
    <div
      className="market-plant-col"
      style={{ transform: side === "right" ? "scaleX(-1)" : undefined }}
    >
      <svg
        viewBox="0 0 60 500"
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="xMidYMax meet"
        aria-hidden="true"
        style={{ width: "100%", height: "100%", display: "block" }}
      >
        {/* Planter box */}
        <rect x="5" y="454" width="50" height="42" rx="4" fill="#2a180a" stroke="#4a3020" strokeWidth="1.5" />
        <rect x="5" y="465" width="50" height="2.5" fill="#3d2415" />
        <rect x="5" y="476" width="50" height="2.5" fill="#3d2415" />
        <rect x="5" y="487" width="50" height="2.5" fill="#3d2415" />
        {/* Soil */}
        <rect x="9" y="456" width="42" height="9" rx="2" fill="#1a0e06" />

        {/* Main tall stem (gently curved) */}
        <path
          d="M 28,455 C 28,438 26,410 24,382 C 22,354 20,326 23,298 C 26,270 30,242 27,214 C 24,186 19,162 21,138 C 23,116 28,102 26,88 C 24,74 20,62 22,50"
          fill="none" stroke="#5a3c20" strokeWidth="2.5" strokeLinecap="round"
        />

        {/* Leaf pairs, bottom to top, alternating sides */}
        <ellipse cx="14" cy="432" rx="13" ry="6" fill="#3a2818" transform="rotate(-35 14 432)" />
        <ellipse cx="44" cy="420" rx="12" ry="6" fill="#3a2818" transform="rotate(28 44 420)" />

        <ellipse cx="12" cy="366" rx="14" ry="7" fill="#3a2818" transform="rotate(-38 12 366)" />
        <ellipse cx="46" cy="354" rx="13" ry="6" fill="#3a2818" transform="rotate(30 46 354)" />

        <ellipse cx="10" cy="300" rx="15" ry="7" fill="#3a2818" transform="rotate(-32 10 300)" />
        <ellipse cx="48" cy="288" rx="14" ry="7" fill="#3a2818" transform="rotate(28 48 288)" />

        <ellipse cx="11" cy="234" rx="14" ry="6" fill="#3a2818" transform="rotate(-28 11 234)" />
        <ellipse cx="46" cy="222" rx="13" ry="6" fill="#3a2818" transform="rotate(25 46 222)" />

        <ellipse cx="12" cy="170" rx="13" ry="6" fill="#3a2818" transform="rotate(-24 12 170)" />
        <ellipse cx="45" cy="158" rx="12" ry="5" fill="#3a2818" transform="rotate(22 45 158)" />

        <ellipse cx="14" cy="110" rx="12" ry="5" fill="#3a2818" transform="rotate(-20 14 110)" />
        <ellipse cx="42" cy="100" rx="11" ry="5" fill="#3a2818" transform="rotate(18 42 100)" />

        {/* Top leafy cluster */}
        <ellipse cx="20" cy="62" rx="10" ry="5" fill="#3a2818" transform="rotate(-15 20 62)" />
        <ellipse cx="34" cy="52" rx="9" ry="5" fill="#443222" transform="rotate(12 34 52)" />
        <ellipse cx="26" cy="43" rx="8" ry="4" fill="#3c2a18" transform="rotate(-5 26 43)" />

        {/* Hanging vine on inner side */}
        <path
          d="M 7,380 C 3,398 1,420 4,440 C 7,456 5,470 8,490"
          fill="none" stroke="#4a3220" strokeWidth="1.5" strokeLinecap="round"
        />
        <ellipse cx="3" cy="412" rx="7" ry="4" fill="#362613" transform="rotate(-18 3 412)" />
        <ellipse cx="6" cy="452" rx="7" ry="4" fill="#362613" transform="rotate(-8 6 452)" />
      </svg>
    </div>
  );
}

// ── Plugin card ──────────────────────────────────────────────────────────────

function PluginCard({ plugin, onToggle }: { plugin: Plugin; onToggle: (id: string) => void }) {
  return (
    <div className={`market-plugin-card ${plugin.installed ? "installed" : ""} ${plugin.featured ? "featured" : ""}`}>
      <div className="market-plugin-card-header">
        <span className="market-plugin-icon" role="img" aria-label={plugin.name}>{plugin.icon}</span>
        <div className="market-plugin-meta">
          <div className="market-plugin-name">{plugin.name}</div>
          <div className="market-plugin-author">by {plugin.author}</div>
        </div>
        {plugin.installed && (
          <span className="market-plugin-installed-badge" title="Installed">
            <CheckCircle size={12} />
          </span>
        )}
      </div>
      <p className="market-plugin-description">{plugin.description}</p>
      <div className="market-plugin-footer">
        <div className="market-plugin-stats">
          <span title="Stars"><Star size={10} /> {formatCount(plugin.stars)}</span>
          <span title="Installs"><Download size={10} /> {formatCount(plugin.installs)}</span>
        </div>
        <button
          className={`market-plugin-btn ${plugin.installed ? "remove" : "install"}`}
          onClick={() => onToggle(plugin.id)}
        >
          {plugin.installed ? "Remove" : "Install"}
        </button>
      </div>
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────

export function MarketPanel({ onClose }: Props) {
  const [view, setView] = useState<View>("browse");
  const [searchQuery, setSearchQuery] = useState("");
  const [plugins, setPlugins] = useState<Plugin[]>(MOCK_PLUGINS);
  const [blinking, setBlinking] = useState(false);
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const filteredLengthRef = useRef(MOCK_PLUGINS.length);

  // Periodic eye blink
  useEffect(() => {
    const blink = () => {
      setBlinking(true);
      setTimeout(() => setBlinking(false), 150);
    };
    const id = setInterval(blink, 3500);
    return () => clearInterval(id);
  }, []);

  const filteredPlugins = useMemo(() => {
    let list = view === "installed" ? plugins.filter((p) => p.installed) : plugins;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q)
      );
    }
    return list;
  }, [plugins, view, searchQuery]);

  filteredLengthRef.current = filteredPlugins.length;

  // Reset display + scroll when filter changes
  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
    if (gridRef.current) gridRef.current.scrollTop = 0;
  }, [view, searchQuery]);

  // Infinite scroll via IntersectionObserver (set up once)
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setDisplayCount((c) => Math.min(c + PAGE_SIZE, filteredLengthRef.current));
        }
      },
      { rootMargin: "120px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const handleDialogueChoice = (newView: View) => {
    setView(newView);
    setSearchQuery("");
  };

  const handleTogglePlugin = (id: string) => {
    setPlugins((prev) => prev.map((p) => (p.id === id ? { ...p, installed: !p.installed } : p)));
  };

  const visiblePlugins = filteredPlugins.slice(0, displayCount);
  const hasMore = displayCount < filteredPlugins.length;
  const installedCount = plugins.filter((p) => p.installed).length;
  const dialogueKey = searchQuery ? "search" : view;

  return (
    <div className="market-panel">
      <button className="market-close-btn" onClick={onClose} aria-label="Close marketplace">
        <X size={14} />
      </button>

      <StorefrontAwning />

      <div className="market-body">
        {/* Owner sidebar */}
        <aside className="market-owner-pane">
          <div className="market-owner-figure">
            <StoreOwner blinking={blinking} />
          </div>

          <div className="market-dialogue-box">
            <div className="market-dialogue-name">Shopkeeper</div>
            <p className="market-dialogue-text">{OWNER_DIALOGUES[dialogueKey]}</p>
          </div>

          <div className="market-dialogue-choices">
            <button
              className={`market-choice-btn ${view === "browse" && !searchQuery ? "active" : ""}`}
              onClick={() => handleDialogueChoice("browse")}
            >
              <span className="market-choice-arrow">▶</span>
              Browse all plugins
            </button>
            <button
              className={`market-choice-btn ${view === "installed" && !searchQuery ? "active" : ""}`}
              onClick={() => handleDialogueChoice("installed")}
            >
              <span className="market-choice-arrow">▶</span>
              My plugins
              {installedCount > 0 && (
                <span className="market-choice-badge">{installedCount}</span>
              )}
            </button>
          </div>

          {/* Search bar in owner pane */}
          <div className="market-search-wrap">
            <Search size={12} className="market-search-icon" />
            <input
              className="market-search-input"
              type="text"
              placeholder="Search plugins…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </aside>

        {/* Left plant */}
        <PlantDecoration side="left" />

        {/* Plugin grid */}
        <div className="market-grid-pane">
          <div className="market-grid" ref={gridRef}>
            {filteredPlugins.length === 0 ? (
              <div className="market-empty">
                <Package size={28} />
                <p>{view === "installed" ? "No plugins installed yet." : "No plugins found."}</p>
              </div>
            ) : (
              <>
                {visiblePlugins.map((plugin) => (
                  <PluginCard key={plugin.id} plugin={plugin} onToggle={handleTogglePlugin} />
                ))}
                {hasMore ? (
                  <div ref={sentinelRef} className="market-sentinel" />
                ) : (
                  <div className="market-end">
                    ✦ All {filteredPlugins.length} plugins shown ✦
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right plant */}
        <PlantDecoration side="right" />
      </div>
    </div>
  );
}
