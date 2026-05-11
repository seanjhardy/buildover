import { useEffect, useMemo, useState, useRef } from "react";
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
import { fileApi } from "../lib/api.js";
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
  };
  return map[ext] ?? "plaintext";
}

interface Props {
  entry: FileEntry;
  onClose: () => void;
}

export function FileViewer({ entry, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const codeRef = useRef<HTMLElement>(null);

  const filename = entry.path.split("/").pop() ?? entry.relPath;
  const lang = getLanguage(filename);

  // Load file content
  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent(null);
    fileApi
      .readFile(entry.path)
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [entry.path]);

  // Apply syntax highlighting after content renders.
  // Rules:
  //  1. Skip plaintext entirely.
  //  2. Skip files > 50 KB — hljs is O(n) and blocks the main thread for
  //     large files; plain text is shown instead.
  //  3. Use requestIdleCallback (with a 2 s deadline) so highlighting
  //     only runs when the browser has spare capacity, never during a
  //     paint/layout pass. Falls back to setTimeout for Safari.
  useEffect(() => {
    if (content === null || !codeRef.current) return;
    const el = codeRef.current;
    el.removeAttribute("data-highlighted");
    if (lang === "plaintext") return;
    // Skip highlighting for large files to avoid freezing the main thread.
    if (content.length > 50_000) return;

    let cancelled = false;
    let handle: number | ReturnType<typeof setTimeout>;

    if (typeof requestIdleCallback === "function") {
      handle = requestIdleCallback(
        () => { if (!cancelled) hljs.highlightElement(el); },
        { timeout: 2000 },
      );
    } else {
      // Safari fallback — still yields one frame before doing the work.
      handle = setTimeout(() => { if (!cancelled) hljs.highlightElement(el); }, 16);
    }

    return () => {
      cancelled = true;
      if (typeof requestIdleCallback === "function") {
        cancelIdleCallback(handle as number);
      } else {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      }
    };
  }, [content, lang]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Memoize line count and gutter text so they aren't recomputed on every render.
  const { lineCount, gutterText } = useMemo(() => {
    if (content === null) return { lineCount: 0, gutterText: "" };
    const count = content.split("\n").length;
    return {
      lineCount: count,
      gutterText: Array.from({ length: count }, (_, i) => i + 1).join("\n"),
    };
  }, [content]);

  return (
    <div className="file-viewer">
      {/* Header bar — mimics VS Code tab bar */}
      <div className="file-viewer-header">
        <div className="file-viewer-tab">
          <span className="file-viewer-tab-name">{filename}</span>
          <span className="file-viewer-tab-path">{entry.relPath}</span>
        </div>
        <div className="file-viewer-header-actions">
          <button
            className="file-viewer-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close file viewer"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Editor area */}
      <div className="file-viewer-body">
        {loading && (
          <div className="file-viewer-state">
            <Loader size={18} className="file-viewer-spinner" />
            <span>Loading…</span>
          </div>
        )}
        {error && (
          <div className="file-viewer-state file-viewer-state--error">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}
        {!loading && !error && content !== null && (
          <div className="file-viewer-editor">
            {/* Gutter: a single pre-formatted text node with all line
                numbers joined by newlines — ONE DOM node regardless of
                file length, so layout/paint cost is negligible. */}
            <div className="file-viewer-gutter" aria-hidden="true">
              {gutterText}
            </div>
            {/* Code */}
            <pre className="file-viewer-pre">
              <code
                ref={codeRef}
                className={`language-${lang} file-viewer-code`}
              >
                {content}
              </code>
            </pre>
          </div>
        )}
      </div>

      {/* Status bar */}
      {!loading && !error && content !== null && (
        <div className="file-viewer-statusbar">
          <span>{lang}</span>
          <span>{lineCount} lines</span>
          <span className={`file-viewer-op file-viewer-op--${entry.op}`}>
            {entry.op === "write" ? "added" : entry.op === "delete" ? "deleted" : "modified"}
          </span>
        </div>
      )}
    </div>
  );
}
