import { useEffect, useRef, useState } from "react";
import { Wand2, Square, Monitor, Loader } from "lucide-react";
import type { RunConfig } from "../lib/api.js";

/**
 * Inject overflow:hidden + a ResizeObserver height-reporter into the panel HTML
 * so the iframe can be sized exactly to its content with no scrollbar.
 * Works on existing saved panels without any regeneration needed.
 */
function withHeightReporter(html: string): string {
  const injected =
    // Suppress scrollbars; body margin reset so measurements are clean
    `<style>html,body{overflow:hidden!important;margin:0!important}</style>` +
    `<script>(function(){` +
    // Use body.scrollHeight only — documentElement can inherit the iframe's
    // default 150 px viewport height and would inflate the measurement.
    `function measure(){var b=document.body;return b?b.scrollHeight:document.documentElement.scrollHeight;}` +
    // Wrap in rAF so layout is fully settled before we read dimensions
    `function report(){requestAnimationFrame(function(){` +
    `  window.parent.postMessage({type:'panel-height',height:measure()},'*');` +
    `});}` +
    `document.readyState==='loading'` +
    `  ?document.addEventListener('DOMContentLoaded',report)` +
    `  :report();` +
    `window.addEventListener('load',function(){report();setTimeout(report,150);});` +
    // Observe body so any dynamic size change (hover states, animations) re-reports
    `if(window.ResizeObserver)new ResizeObserver(report).observe(document.body||document.documentElement);` +
    `}());<\/script>`;
  return html.includes("</head>")
    ? html.replace("</head>", injected + "</head>")
    : injected + html;
}

interface RunPanelProps {
  repoPath: string;
  config: RunConfig | null;
  panelHtml: string | null;
  isPortListening: boolean;
  isSettingUp: boolean;
  onSetupRun: () => void;
  onRunCommand: (command: string) => void;
  onKillPort: () => void;
  onOpenPreview: () => void;
}

export function RunPanel({
  config,
  panelHtml,
  isPortListening,
  isSettingUp,
  onSetupRun,
  onRunCommand,
  onKillPort,
  onOpenPreview,
}: RunPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(0);

  // Handle postMessage from the sandboxed iframe:
  //   "run-command"  → forward to terminal
  //   "panel-height" → resize the iframe to fit its content
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data?.type === "run-command" && typeof e.data.command === "string") {
        onRunCommand(e.data.command);
      }
      if (e.data?.type === "panel-height" && typeof e.data.height === "number") {
        setIframeHeight(e.data.height);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onRunCommand]);

  // No config yet — show the setup button
  if (!config || !panelHtml) {
    return (
      <div className="run-panel run-panel--setup">
        <button
          type="button"
          className="run-panel-setup-btn"
          onClick={onSetupRun}
          disabled={isSettingUp}
        >
          {isSettingUp ? (
            <Loader size={12} className="run-panel-spin" />
          ) : (
            <Wand2 size={12} />
          )}
          {isSettingUp ? "Setting up…" : "Set up Run Panel"}
        </button>
        <p className="run-panel-hint">
          {isSettingUp
            ? "Scanning your project for runnable commands…"
            : "Generate custom run buttons for this project using AI."}
        </p>
      </div>
    );
  }

  // Config exists — show the iframe panel
  return (
    <div className="run-panel run-panel--active">
      {/* Sandboxed iframe — height driven by content via postMessage */}
      <iframe
        ref={iframeRef}
        className="run-panel-iframe"
        srcDoc={withHeightReporter(panelHtml)}
        sandbox="allow-scripts"
        title="Run panel"
        style={iframeHeight > 0 ? { height: iframeHeight } : undefined}
      />

      {/* Preview + status row — always visible once config exists */}
      <div className="run-panel-footer">
        {/* Port status pill */}
        {config.devPort && (
          <div className={`run-panel-port ${isPortListening ? "run-panel-port--live" : ""}`}>
            <span className="run-panel-port-dot" />
            <span className="run-panel-port-label">
              {isPortListening ? `Running :${config.devPort}` : `:${config.devPort}`}
            </span>
            {isPortListening && (
              <button
                type="button"
                className="run-panel-kill-btn"
                onClick={onKillPort}
                title={`Stop process on :${config.devPort}`}
              >
                <Square size={9} />
              </button>
            )}
          </div>
        )}

        {/* Preview button — shown when previewUrl is set; disabled unless port is live */}
        {config.previewUrl && (
          <button
            type="button"
            className={`run-panel-preview-btn${isPortListening ? " run-panel-preview-btn--live" : ""}`}
            onClick={onOpenPreview}
            disabled={!isPortListening}
            title={isPortListening ? "Open preview" : "Start the dev server first"}
          >
            <Monitor size={11} />
            Preview
          </button>
        )}
      </div>
    </div>
  );
}
