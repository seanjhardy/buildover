// Resolves the backend origin for HTTP and WebSocket connections.
//
// The same build runs in three contexts:
//   - Electron production: page served via file:// — no implicit origin, so we
//     fall back to the local Express server.
//   - Vite dev: page on http://localhost:5173 — same-origin relative URLs work
//     (Vite proxies /api and the WS upgrade to :8787).
//   - Remote (phone over Tailscale): page served by Express itself behind HTTPS,
//     so everything must be same-origin and use wss:// when the page is https://.

const FILE_FALLBACK_HOST = "localhost:8787";

function isFileProtocol(): boolean {
  return window.location.protocol === "file:";
}

/** HTTP(S) base to prefix API paths with. Empty string = same-origin. */
export function httpBase(): string {
  return isFileProtocol() ? `http://${FILE_FALLBACK_HOST}` : "";
}

/** WebSocket URL for a server path like "/agent". Matches the page's TLS. */
export function wsUrl(path: string): string {
  if (isFileProtocol()) return `ws://${FILE_FALLBACK_HOST}${path}`;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${path}`;
}
