/**
 * Shared highlight.js setup used by every file-viewing and file-editing
 * component in the app. Import from here instead of registering languages
 * in each component.
 */
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

// Register once — safe to call multiple times (hljs is a singleton)
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

export { hljs };

// ── Language detection ─────────────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
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

export function getLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "plaintext";
}

// ── Image file detection ───────────────────────────────────────────────────────

export const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif", "tiff", "tif",
]);

export function isImageFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

export function getLanguageLabel(filename: string): string {
  const lang = getLanguage(filename);
  const labels: Record<string, string> = {
    typescript: "TypeScript", javascript: "JavaScript",
    html: "HTML", css: "CSS", json: "JSON",
    python: "Python", rust: "Rust", go: "Go",
    bash: "Shell", sql: "SQL", markdown: "Markdown",
    yaml: "YAML", xml: "XML", java: "Java",
    kotlin: "Kotlin", cpp: "C++", csharp: "C#",
    swift: "Swift", php: "PHP", ruby: "Ruby",
    scala: "Scala", r: "R", lua: "Lua",
    perl: "Perl", graphql: "GraphQL", toml: "TOML",
    dockerfile: "Dockerfile", nginx: "Nginx",
    plaintext: "Plain Text",
  };
  return labels[lang] ?? lang;
}

// ── HTML splitting ─────────────────────────────────────────────────────────────

/**
 * Split a highlight.js HTML string into one self-contained string per line.
 * Spans are closed at each newline and reopened on the next line so every
 * line's HTML is valid in isolation.
 */
export function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = [];
  let cur = "";
  const stack: string[] = [];
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

export const HIGHLIGHT_LINE_LIMIT = 5_000;

// ── Highlighting helpers ───────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Highlight a single line of code, returning HTML string.
 * Falls back to escaped plain text on any error.
 */
export function highlightLine(text: string, lang: string): string {
  if (lang === "plaintext" || !text.trim()) return escapeHtml(text) || "&nbsp;";
  try {
    return hljs.highlight(text, { language: lang }).value || escapeHtml(text);
  } catch {
    return escapeHtml(text);
  }
}

/**
 * Highlight a full file's content, returning one HTML string per line.
 * Returns null if the file is too long or the language is plaintext.
 */
export function highlightContent(content: string, lang: string): string[] | null {
  if (lang === "plaintext") return null;
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length > HIGHLIGHT_LINE_LIMIT) return null;
  try {
    const result = hljs.highlight(lines.join("\n"), { language: lang });
    return splitHighlightedHtml(result.value);
  } catch {
    return null;
  }
}
