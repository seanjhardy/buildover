import { useMemo, useState } from "react";

interface Props {
  svg: string;
  title?: string;
  caption?: string;
}

// Lightweight SVG sanitizer.
//
// The SVG payload is produced by our own assistant via the `RenderSVG` tool,
// but we still strip anything that could execute script in the browser:
//   - <script> elements
//   - on* event-handler attributes (onclick, onload, onerror, ...)
//   - javascript: URLs in href / xlink:href
//   - <foreignObject> (can host arbitrary HTML, including iframes/scripts)
// Everything else (paths, shapes, text, gradients, filters, animations,
// CSS-style attributes) is preserved.
function sanitizeSvg(input: string): string | null {
  // Find the outer <svg ...>...</svg>. Be tolerant of leading whitespace,
  // XML declarations, or stray prose around the markup.
  const match = input.match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) return null;
  let svg = match[0];

  // Drop <script>...</script> blocks entirely.
  svg = svg.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  // Drop self-closing/empty <script .../>.
  svg = svg.replace(/<script\b[^>]*\/?>/gi, "");

  // Drop <foreignObject>...</foreignObject>.
  svg = svg.replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "");

  // Strip on*="..." and on*='...' event-handler attributes.
  svg = svg.replace(/\son[a-z]+\s*=\s*"(?:[^"\\]|\\.)*"/gi, "");
  svg = svg.replace(/\son[a-z]+\s*=\s*'(?:[^'\\]|\\.)*'/gi, "");
  // Unquoted variant: on*=value (rare but possible).
  svg = svg.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");

  // Neutralize javascript: URLs in href / xlink:href.
  svg = svg.replace(
    /\s(href|xlink:href)\s*=\s*"(?:\s*javascript:[^"]*)"/gi,
    ' $1="#"',
  );
  svg = svg.replace(
    /\s(href|xlink:href)\s*=\s*'(?:\s*javascript:[^']*)'/gi,
    " $1='#'",
  );

  return svg;
}

export function SvgBlock({ svg, title, caption }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const sanitized = useMemo(() => sanitizeSvg(svg), [svg]);

  if (!sanitized) {
    return (
      <div className="svg-block error">
        <div className="svg-block-header">
          <span className="chevron">▾</span>
          <span className="svg-block-title">SVG (invalid)</span>
        </div>
        <div className="svg-block-body">
          Could not parse SVG markup.
        </div>
      </div>
    );
  }

  return (
    <div className={`svg-block${collapsed ? " collapsed" : ""}`}>
      <div
        className="svg-block-header"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "Click to expand" : "Click to collapse"}
      >
        <span className="chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="svg-block-title">{title || "SVG"}</span>
      </div>
      {!collapsed && (
        <>
          <div
            className="svg-block-body"
            // Sanitized above. We need raw HTML insertion so the SVG
            // actually renders as graphics rather than escaped text.
            dangerouslySetInnerHTML={{ __html: sanitized }}
          />
          {caption && <div className="svg-block-caption">{caption}</div>}
        </>
      )}
    </div>
  );
}
