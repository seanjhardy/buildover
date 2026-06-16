// Resolves the backend origin for HTTP and WebSocket connections.
//
// The same build runs in three contexts:
//   - Electron: the shell starts a local Express server on :8787. Even when
//     the UI is loaded from Vite on :5173, connect to the backend directly so
//     chat sockets do not depend on the Vite proxy staying healthy.
//   - Vite dev in a browser: page on http://localhost:5173 — same-origin
//     relative URLs work (Vite proxies /api and WS upgrades to :8787).
//   - Remote (phone over Tailscale): page served by Express itself behind HTTPS,
//     so everything must be same-origin and use wss:// when the page is https://.

const FILE_FALLBACK_HOST = "localhost:8787";

function isFileProtocol(): boolean {
  return window.location.protocol === "file:";
}

function isElectron(): boolean {
  return Boolean(window.electronShell);
}

/** HTTP(S) base to prefix API paths with. Empty string = same-origin. */
export function httpBase(): string {
  return isFileProtocol() || isElectron() ? `http://${FILE_FALLBACK_HOST}` : "";
}

/** WebSocket URL for a server path like "/agent". Matches the page's TLS. */
export function wsUrl(path: string): string {
  if (isFileProtocol() || isElectron()) return `ws://${FILE_FALLBACK_HOST}${path}`;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${path}`;
}
