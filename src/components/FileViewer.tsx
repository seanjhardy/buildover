import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { X, AlertCircle, Loader } from "lucide-react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import swift from "highlight.js/lib/languages/swift";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import scala from "highlight.js/lib/languages/scala";
import r from "highlight.js/lib/languages/r";
import lua from "highlight.js/lib/languages/lua";
import perl from "highlight.js/lib/languages/perl";
import graphql from "highlight.js/lib/languages/graphql";
import toml from "highlight.js/lib/languages/ini"; // TOML uses ini grammar
import dockerfile from "highlight.js/lib/languages/dockerfile";
import nginx from "highlight.js/lib/languages/nginx";
import { fileApi, gitApi } from "../lib/api.js";
import type { FileEntry } from "../hooks/useFilesChanged.js";

// Register languages
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("java", java);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("php", php);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("scala", scala);
hljs.registerLanguage("r", r);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("perl", perl);
hljs.registerLanguage("graphql", graphql);
hljs.registerLanguage("toml", toml);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("nginx", nginx);

function getLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript",
    html: "html", htm: "html",
    css: "css", scss: "css",
    json: "json",
    py: "python",
    rs: "rust",
    go: "go",
    sh: "bash", bash: "bash", zsh: "bash",
    sql: "sql",
    md: "markdown", mdx: "markdown",
    yml: "yaml", yaml: "yaml",
    xml: "xml",
    java: "java",
    kt: "kotlin", kts: "kotlin",
    cpp: "cpp", cc: "cpp", cxx: "cpp", c: "cpp", h: "cpp", hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    php: "php",
    rb: "ruby",
    scala: "scala",
    r: "r",
    lua: "lua",
    pl: "perl", pm: "perl",
    graphql: "graphql", gql: "graphql",
    toml: "toml",
    ini: "toml", cfg: "toml", properties: "toml",
    dockerfile: "dockerfile",
    nginx: "nginx",
  };
  return map[ext] ?? "plaintext";
}

/** Split highlight.js HTML output into one string per line,
 *  closing/reopening spans at each newline so each line is self-contained. */
function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = [];
  let cur = "";
  const stack: string[] = []; // opening <span ...> tags
  let i = 0;
  while (i < html.length) {
    const ch = html[i]!;
    if (ch === "<") {
      const end = html.indexOf(">", i);
      if (end === -1) { cur += html.slice(i); break; }
      const tag = html.slice(i, end + 1);
      cur += tag;
      if (tag.startsWith("</")) stack.pop();
      else if (!tag.endsWith("/>")) stack.push(tag);
      i = end + 1;
    } else if (ch === "\n") {
      for (let j = stack.length - 1; j >= 0; j--) cur += "</span>";
      lines.push(cur);
      cur = stack.join("");
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  lines.push(cur);
  return lines;
}

const HIGHLIGHT_LINE_LIMIT = 5_000;

interface RemovedGroup { after: number; lines: string[] }

// A display row is either a real file line or a ghost deleted line.
type DisplayRow =
  | { kind: "line"; lineNo: number; text: string; added: boolean }
  | { kind: "deleted"; text: string };

interface Props {
  entry: FileEntry;
  repoPath: string;
  onClose: () => void;
  /** When true, renders inline (fills parent) instead of as an absolute overlay */
  inline?: boolean;
}

export function FileViewer({ entry, repoPath, onClose, inline }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [addedLines, setAddedLines] = useState<ReadonlySet<number>>(new Set());
  const [removedGroups, setRemovedGroups] = useState<RemovedGroup[]>([]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);

  const filename = entry.path.split("/").pop() ?? entry.relPath;
  const lang = getLanguage(filename);

  // ── Load file content ───────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent(null);
    setAddedLines(new Set());
    setRemovedGroups([]);

    fileApi
      .readFile(entry.path)
      .then((text) => { setContent(text); setLoading(false); })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [entry.path]);

  // ── Load diff data ──────────────────────────────────────────────────────
  useEffect(() => {
    if (entry.op === "delete") return;
    let cancelled = false;
    gitApi
      .getDiff(repoPath, entry.relPath)
      .then(({ addedLines: a, removedGroups: r }) => {
        if (cancelled) return;
        setAddedLines(new Set(a));
        setRemovedGroups(r);
      })
      .catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, [repoPath, entry.relPath, entry.op]);

  // ── Close on Escape ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // ── Build merged display rows ────────────────────────────────────────────
  // Interleave real file lines with ghost deleted-line rows from the diff.
  const { displayRows, lineCount, totalRemovedCount } = useMemo(() => {
    if (content === null) return { displayRows: [], lineCount: 0, totalRemovedCount: 0 };

    const fileLines = content.split("\n");
    // Remove trailing empty line that split() adds for files ending in \n
    if (fileLines[fileLines.length - 1] === "") fileLines.pop();

    const lineCount = fileLines.length;

    if (removedGroups.length === 0 && addedLines.size === 0) {
      // No diff — fast path: plain rows
      return {
        displayRows: fileLines.map((text, i) => ({
          kind: "line" as const,
          lineNo: i + 1,
          text,
          added: false,
        })),
        lineCount,
        totalRemovedCount: 0,
      };
    }

    // Build a map: after-line → deleted texts
    const deletedAfter = new Map<number, string[]>();
    let totalRemovedCount = 0;
    for (const g of removedGroups) {
      deletedAfter.set(g.after, g.lines);
      totalRemovedCount += g.lines.length;
    }

    const rows: DisplayRow[] = [];

    // Deleted lines that appear before line 1 (after: 0)
    for (const text of deletedAfter.get(0) ?? []) {
      rows.push({ kind: "deleted", text });
    }

    for (let i = 0; i < fileLines.length; i++) {
      const lineNo = i + 1;
      rows.push({ kind: "line", lineNo, text: fileLines[i]!, added: addedLines.has(lineNo) });
      // Deleted lines that appear after this line
      for (const text of deletedAfter.get(lineNo) ?? []) {
        rows.push({ kind: "deleted", text });
      }
    }

    return { displayRows: rows, lineCount, totalRemovedCount };
  }, [content, addedLines, removedGroups]);

  const hasDiff = addedLines.size > 0 || removedGroups.length > 0;
  const totalRows = displayRows.length;

  // ── Syntax-highlight deleted lines ──────────────────────────────────────
  // Returns an HTML string with hljs spans for a single line of code.
  const highlightLine = useCallback((text: string): string => {
    if (lang === "plaintext" || !text.trim()) return escapeHtml(text) || "&nbsp;";
    try {
      return hljs.highlight(text, { language: lang }).value || escapeHtml(text);
    } catch {
      return escapeHtml(text);
    }
  }, [lang]);

  // ── Full-file syntax highlighting ───────────────────────────────────────
  const highlightedLines = useMemo((): string[] | null => {
    if (content === null || lang === "plaintext") return null;
    const lines = content.split("\n");
    // Remove trailing empty line
    if (lines[lines.length - 1] === "") lines.pop();
    if (lines.length > HIGHLIGHT_LINE_LIMIT) return null;
    const src = lines.join("\n");
    try {
      const result = hljs.highlight(src, { language: lang });
      return splitHighlightedHtml(result.value);
    } catch {
      return null;
    }
  }, [content, lang]);

  // ── Minimap canvas drawing ───────────────────────────────────────────────
  const drawMinimap = useCallback(() => {
    const canvas = canvasRef.current;
    const container = minimapRef.current;
    const body = bodyRef.current;
    if (!canvas || !container || !body || totalRows === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const W = container.clientWidth;
    const H = container.clientHeight;
    if (W === 0 || H === 0) return;

    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const rowH = Math.max(1, H / totalRows);

    // Draw each row mark
    for (let i = 0; i < displayRows.length; i++) {
      const row = displayRows[i]!;
      const y = (i / totalRows) * H;
      if (row.kind === "deleted") {
        ctx.fillStyle = "rgba(248, 81, 73, 0.85)";
        ctx.fillRect(0, y, W, Math.max(rowH, 2));
      } else if (row.added) {
        ctx.fillStyle = "rgba(46, 160, 67, 0.85)";
        ctx.fillRect(0, y, W, Math.max(rowH, 2));
      }
    }

    // Viewport indicator
    const totalContentH = body.scrollHeight;
    const viewportH = body.clientHeight;
    if (totalContentH > viewportH) {
      const scrollRatio = body.scrollTop / totalContentH;
      const vpRatio = viewportH / totalContentH;
      const vpTop = scrollRatio * H;
      const vpHeight = Math.max(vpRatio * H, 20);
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.fillRect(0, vpTop, W, vpHeight);
      ctx.strokeStyle = "rgba(255,255,255,0.20)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, vpTop + 0.5, W - 1, vpHeight - 1);
    }
  }, [totalRows, displayRows]);

  useEffect(() => { drawMinimap(); }, [drawMinimap]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onScroll = () => drawMinimap();
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, [drawMinimap]);

  useEffect(() => {
    const container = minimapRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => drawMinimap());
    ro.observe(container);
    return () => ro.disconnect();
  }, [drawMinimap]);

  // ── Minimap scrubbing ────────────────────────────────────────────────────
  const handleMinimapPointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const body = bodyRef.current;
    if (!canvas || !body) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const scrub = (clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      body.scrollTop = ratio * body.scrollHeight - body.clientHeight / 2;
    };
    scrub(e.clientY);
    const onMove = (ev: PointerEvent) => scrub(ev.clientY);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  return (
    <div className={`file-viewer${inline ? " file-viewer--inline" : ""}`}>
      {/* Header */}
      <div className="file-viewer-header">
        <div className="file-viewer-tab">
          <span className="file-viewer-tab-name">{filename}</span>
          <span className="file-viewer-tab-path">{entry.relPath}</span>
        </div>
        <div className="file-viewer-header-actions">
          <button className="file-viewer-close" onClick={onClose} title="Close (Esc)" aria-label="Close file viewer">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Editor + minimap */}
      <div className="file-viewer-main">
        <div className="file-viewer-body" ref={bodyRef}>
          {loading && (
            <div className="file-viewer-state">
              <Loader size={18} className="file-viewer-spinner" /><span>Loading…</span>
            </div>
          )}
          {error && (
            <div className="file-viewer-state file-viewer-state--error">
              <AlertCircle size={18} /><span>{error}</span>
            </div>
          )}
          {!loading && !error && content !== null && (
            <div className="file-viewer-editor">
              {/* Gutter */}
              <div className="file-viewer-gutter" aria-hidden="true">
                {displayRows.map((row, i) =>
                  row.kind === "deleted"
                    ? <div key={i} className="file-viewer-gutter-row file-viewer-gutter-row--deleted">−</div>
                    : <div key={i} className="file-viewer-gutter-row">{row.lineNo}</div>
                )}
              </div>

              {/* Code rows */}
              <div className="file-viewer-content-wrap">
                <pre className="file-viewer-pre">
                  {displayRows.map((row, i) => (
                    row.kind === "deleted" ? (
                      <div
                        key={i}
                        className="file-viewer-row file-viewer-row--deleted"
                        dangerouslySetInnerHTML={{ __html: highlightLine(row.text) }}
                      />
                    ) : highlightedLines ? (
                      <div
                        key={i}
                        className={`file-viewer-row${row.added ? " file-viewer-row--added" : ""}`}
                        dangerouslySetInnerHTML={{ __html: (highlightedLines[row.lineNo - 1] ?? escapeHtml(row.text)) || "&nbsp;" }}
                      />
                    ) : (
                      <div
                        key={i}
                        className={`file-viewer-row${row.added ? " file-viewer-row--added" : ""}`}
                      >
                        {row.text || "\u200b"}
                      </div>
                    )
                  ))}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Minimap */}
        <div ref={minimapRef} className="file-viewer-minimap-wrap" aria-hidden="true">
          <canvas
            ref={canvasRef}
            className="file-viewer-minimap"
            onPointerDown={handleMinimapPointer}
            title="Click or drag to scroll"
          />
        </div>
      </div>

      {/* Status bar */}
      {!loading && !error && content !== null && (
        <div className="file-viewer-statusbar">
          <span>{lang}</span>
          <span>{lineCount} lines</span>
          {hasDiff && (
            <span className="file-viewer-diff-stat">
              {addedLines.size > 0 && <span className="file-viewer-diff-stat--add">+{addedLines.size}</span>}
              {totalRemovedCount > 0 && <span className="file-viewer-diff-stat--remove">−{totalRemovedCount}</span>}
            </span>
          )}
          <span className={`file-viewer-op file-viewer-op--${entry.op}`}>
            {entry.op === "write" ? "added" : entry.op === "delete" ? "deleted" : "modified"}
          </span>
        </div>
      )}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
