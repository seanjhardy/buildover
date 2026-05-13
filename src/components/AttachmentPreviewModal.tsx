import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
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
import type { Attachment } from "../types.js";

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface Props {
  attachment: Attachment;
  onClose: () => void;
}

export function AttachmentPreviewModal({ attachment, onClose }: Props) {
  const isImage = attachment.mime.startsWith("image/");

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Syntax-highlight text content
  let highlightedHtml = "";
  if (!isImage && attachment.contents != null) {
    const lang = getLanguage(attachment.name);
    if (lang !== "plaintext") {
      try {
        highlightedHtml = hljs.highlight(attachment.contents, { language: lang }).value;
      } catch {
        highlightedHtml = hljs.highlightAuto(attachment.contents).value;
      }
    }
  }

  return createPortal(
    <div
      className="attachment-preview-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${attachment.name}`}
    >
      <div
        className="attachment-preview-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="attachment-preview-header">
          <div className="attachment-preview-title">
            <span className="attachment-preview-name">{attachment.name}</span>
            <span className="attachment-preview-meta">
              {attachment.mime} · {formatBytes(attachment.size)}
            </span>
          </div>
          <button
            className="attachment-preview-close"
            onClick={onClose}
            aria-label="Close preview"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="attachment-preview-body">
          {isImage && attachment.dataUrl ? (
            <img
              className="attachment-preview-image"
              src={attachment.dataUrl}
              alt={attachment.name}
            />
          ) : attachment.contents != null ? (
            highlightedHtml ? (
              <pre className="attachment-preview-code hljs">
                <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
              </pre>
            ) : (
              <pre className="attachment-preview-code">
                <code>{attachment.contents}</code>
              </pre>
            )
          ) : (
            <div className="attachment-preview-empty">
              No preview available for this file type.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
