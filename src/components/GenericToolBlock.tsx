import { useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  Bell,
  BookOpen,
  Bot,
  Brain,
  Calendar,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Database,
  FileText,
  GitBranch,
  Globe,
  HardDrive,
  Mail,
  MessageSquare,
  Plug,
  Search,
  Share2,
  Users,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface Props {
  name: string;
  input: unknown;
  result?: { content: string; isError: boolean };
}

function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function getSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const priority = [
    "query", "message", "description", "title", "name",
    "id", "path", "url", "pattern", "prompt", "command",
  ];
  for (const key of priority) {
    const val = i[key];
    if (typeof val === "string" && val.length > 0) return val.slice(0, 100);
  }
  for (const val of Object.values(i)) {
    if (typeof val === "string" && val.length > 0) return val.slice(0, 100);
  }
  return "";
}

function iconForServer(server: string): LucideIcon {
  const s = server.toLowerCase();
  if (s.includes("agent")) return Bot;
  if (s.includes("supabase") || s.includes("database")) return Database;
  if (s.includes("github") || s.includes("git")) return Code2;
  if (s.includes("exa") || s.includes("search")) return Search;
  if (s.includes("gmail") || s.includes("mail")) return Mail;
  if (s.includes("calendar")) return Calendar;
  if (s.includes("drive") || s.includes("storage")) return HardDrive;
  if (s.includes("slack") || s.includes("message")) return MessageSquare;
  if (s.includes("notion") || s.includes("doc")) return FileText;
  if (s.includes("vercel") || s.includes("deploy")) return Globe;
  if (s.includes("hubspot") || s.includes("crm") || s.includes("clay")) return Users;
  return Plug;
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  ToolSearch: Search,
  CronCreate: Clock,
  CronDelete: Clock,
  CronList: Clock,
  EnterPlanMode: Brain,
  ExitPlanMode: Brain,
  EnterWorktree: GitBranch,
  ExitWorktree: GitBranch,
  LSP: Code2,
  Monitor: Activity,
  NotebookEdit: BookOpen,
  PushNotification: Bell,
  RemoteTrigger: Zap,
  ShareOnboardingGuide: Share2,
};

// Per-tool field display config: which fields to show (in order) and how to rename them.
const TOOL_FIELD_CONFIG: Record<string, {
  show?: string[];
  rename?: Record<string, string>;
}> = {
  "mcp__buildover-agents__create_ticket": {
    show: ["title", "humanDescription"],
    rename: { humanDescription: "Description" },
  },
  "mcp__buildover-agents__update_ticket": {
    show: ["title", "humanDescription", "status"],
    rename: { humanDescription: "Description" },
  },
};

interface ToolInfo {
  icon: LucideIcon;
  label: string;
  server?: string;
}

function parseToolInfo(name: string): ToolInfo {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const server = parts[1] ?? "";
    const tool = parts.slice(2).join("__");
    // Strip "claude_ai_" prefix that Claude.ai integration servers use
    const displayServer = server.startsWith("claude_ai_")
      ? server.slice("claude_ai_".length)
      : server;
    return {
      icon: iconForServer(server),
      label: titleCase(tool),
      server: displayServer,
    };
  }
  return {
    icon: TOOL_ICONS[name] ?? Plug,
    label: name,
  };
}

function renderFieldValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(String).join(", ");
  return <pre className="generic-tool-param-json">{JSON.stringify(value, null, 2)}</pre>;
}

export function GenericToolBlock({ name, input, result }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const { icon: Icon, label, server } = parseToolInfo(name);
  const summary = getSummary(input);

  const config = TOOL_FIELD_CONFIG[name];
  const inputObj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const params: [string, unknown][] = config?.show
    ? config.show
        .map((k): [string, unknown] => [k, inputObj[k]])
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
    : Object.entries(inputObj).filter(([, v]) => v !== null && v !== undefined && v !== "");

  if (collapsed) {
    return (
      <div
        className={`tool-visual generic-tool-visual collapsed${result?.isError ? " error" : ""}`}
        onClick={() => setCollapsed(false)}
        title="Click to expand"
      >
        <Icon size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">{label}</span>
        {server && <span className="generic-tool-server">{server}</span>}
        {summary && <span className="generic-tool-summary">{summary}</span>}
        <ChevronRight size={12} className="chevron" />
      </div>
    );
  }

  return (
    <div className={`tool-visual generic-tool-visual${result?.isError ? " error" : ""}`}>
      <div className="tool-visual-header" onClick={() => setCollapsed(true)}>
        <Icon size={14} className="tool-visual-icon" />
        <span className="tool-visual-label">{label}</span>
        {server && <span className="generic-tool-server">{server}</span>}
        {summary && <span className="generic-tool-summary">{summary}</span>}
        <ChevronDown size={12} className="chevron" />
      </div>
      <div className="tool-visual-body">
        {params.length > 0 && (
          <div className="generic-tool-params">
            {params.map(([key, value]) => (
              <div key={key} className="generic-tool-param">
                <div className="generic-tool-param-key">
                  {config?.rename?.[key] ?? titleCase(key)}
                </div>
                <div className="generic-tool-param-value">{renderFieldValue(value)}</div>
              </div>
            ))}
          </div>
        )}
        {result?.content && (
          <div className={`generic-tool-result${result.isError ? " error" : ""}${params.length > 0 ? " with-border" : ""}`}>
            {result.content}
          </div>
        )}
      </div>
    </div>
  );
}
