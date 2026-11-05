import type { ContentBlock } from "../types.js";

// A chat's front page: the plain-language card its agent writes for Sean with
// the page tools (server/pageTools.ts). Nothing is stored separately; like the
// todo list, the page is folded from the page-tool calls in the chat history,
// so the server and the client derive the same page from the same events.

export const PAGE_SERVER = "buildover-page";

export type PanelFormat = "markdown" | "html" | "url";

export interface FrontPanel {
  key: string;
  title?: string;
  format: PanelFormat;
  content: string;
  version: number;
}

export interface PageOption {
  label: string;
  detail?: string;
}

export interface PageWait {
  note: string;
  until?: string;
  event?: string;
}

export interface FrontPage {
  title?: string;
  summary?: string;
  tags: string[];
  /** What Sean (or the reporter) said is wrong or wanted, close to verbatim. */
  issues: string[];
  /** Two or three sentences on what this is about; replaced whole each time. */
  context?: string;
  /** One sentence on where it stands now. */
  state?: string;
  /** Most recently shown last. */
  panels: FrontPanel[];
  /** The first is the big action button; cleared once Sean answers. */
  options: PageOption[];
  waiting?: PageWait;
  done?: string;
}

/** One step of the history, in order: a page-tool call or a message from Sean. */
export type PageEntry =
  | { kind: "tool"; name: string; input: unknown; failed?: boolean }
  | { kind: "user" };

/** The bare page-tool name (`set_card`) for a tool_use name, or null for other tools. */
export function pageToolName(name: string): string | null {
  const prefix = `mcp__${PAGE_SERVER}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export function emptyPage(): FrontPage {
  return { tags: [], issues: [], panels: [], options: [] };
}

/** Apply one entry to the page. Pure: returns a new page. */
export function applyEntry(page: FrontPage, entry: PageEntry): FrontPage {
  if (entry.kind === "user") {
    // Sean answered or picked the item back up: the offered answers and any
    // park or close are spent.
    return { ...page, options: [], waiting: undefined, done: undefined };
  }
  if (entry.failed) return page;
  const tool = pageToolName(entry.name);
  const i = (entry.input ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "set_card": {
      const tags = Array.isArray(i.tags) ? i.tags.map(str).filter((t): t is string => !!t).slice(0, 3) : undefined;
      return {
        ...page,
        title: str(i.title) ?? page.title,
        summary: str(i.summary) ?? page.summary,
        tags: tags ?? page.tags,
      };
    }
    case "milestone": {
      const text = str(i.text);
      if (!text) return page;
      if (i.kind === "issue") return page.issues.includes(text) ? page : { ...page, issues: [...page.issues, text] };
      if (i.kind === "context") return { ...page, context: text };
      if (i.kind === "state") return { ...page, state: text };
      return page;
    }
    case "show_panel": {
      const key = str(i.key);
      if (!key) return page;
      const prev = page.panels.find((p) => p.key === key);
      const rest = page.panels.filter((p) => p.key !== key);
      if (typeof i.content !== "string") return prev ? { ...page, panels: [...rest, prev] } : page;
      const format: PanelFormat =
        i.format === "html" || i.format === "url" || i.format === "markdown" ? i.format : prev?.format ?? "markdown";
      const panel: FrontPanel = {
        key,
        title: str(i.title) ?? prev?.title,
        format,
        content: i.content,
        version: (prev?.version ?? 0) + 1,
      };
      return { ...page, panels: [...rest, panel] };
    }
    case "patch_panel": {
      const key = str(i.key);
      const prev = page.panels.find((p) => p.key === key);
      if (!prev || typeof i.find !== "string" || typeof i.replace !== "string" || !prev.content.includes(i.find)) return page;
      const panel = { ...prev, content: prev.content.replace(i.find, i.replace), version: prev.version + 1 };
      return { ...page, panels: [...page.panels.filter((p) => p.key !== key), panel] };
    }
    case "suggest_options": {
      const options = Array.isArray(i.options)
        ? i.options
            .map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>) : {}))
            .filter((o) => str(o.label))
            .map((o) => ({ label: str(o.label)!, ...(str(o.detail) ? { detail: str(o.detail) } : {}) }))
            .slice(0, 4)
        : [];
      return { ...page, options };
    }
    case "wait": {
      const note = str(i.note);
      if (!note) return page;
      return { ...page, waiting: { note, ...(str(i.until) ? { until: str(i.until) } : {}), ...(str(i.event) ? { event: str(i.event) } : {}) } };
    }
    case "done":
      return { ...page, done: str(i.note) ?? "Done", options: [], waiting: undefined };
    default:
      return page;
  }
}

export function foldPage(entries: Iterable<PageEntry>): FrontPage {
  let page = emptyPage();
  for (const e of entries) page = applyEntry(page, e);
  return page;
}

/** A window opens on its front only once the agent has written one. */
export function hasFrontPage(page: FrontPage): boolean {
  return !!(page.summary || page.context);
}

/**
 * Page entries from a run of history: assistant/tool-result content blocks and
 * Sean's own messages. Calls whose tool_result came back as an error are marked
 * failed so a rejected `wait` never shows as parked.
 */
export function pageEntries(
  items: Iterable<{ user: true } | { blocks: ContentBlock[] }>,
): PageEntry[] {
  const out: PageEntry[] = [];
  const byId = new Map<string, Extract<PageEntry, { kind: "tool" }>>();
  for (const item of items) {
    if ("user" in item) {
      out.push({ kind: "user" });
      continue;
    }
    for (const b of item.blocks) {
      if (b.type === "tool_use" && pageToolName(b.name)) {
        const entry = { kind: "tool" as const, name: b.name, input: b.input };
        byId.set(b.id, entry);
        out.push(entry);
      } else if (b.type === "tool_result" && b.is_error) {
        const entry = byId.get(b.tool_use_id);
        if (entry) (entry as { failed?: boolean }).failed = true;
      }
    }
  }
  return out;
}
