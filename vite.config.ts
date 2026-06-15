import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

/**
 * Vite plugin that serves onnxruntime-web worker .mjs files from node_modules
 * at the /ort/ path. These files are dynamically import()-ed by onnxruntime-web
 * at runtime and cannot live in public/ (Vite blocks dynamic imports from public/).
 *
 * .wasm files are served statically from public/ort/ (via Vite's static file
 * serving).  Only .mjs workers need this middleware because Vite explicitly
 * blocks dynamic import() of files inside public/.
 */
function ortWasmPlugin() {
  const ORT_DIST = path.resolve(
    __dirname,
    "node_modules/onnxruntime-web/dist",
  );

  return {
    name: "ort-wasm-plugin",
    configureServer(server: {
      middlewares: {
        use: (
          handler: (
            req: { url?: string },
            res: {
              setHeader: (k: string, v: string) => void;
              end: (buf: Buffer) => void;
            },
            next: () => void,
          ) => void,
        ) => void;
      };
    }) {
      // Register a catch-all middleware. We filter to /ort/*.mjs ourselves
      // so we don't need a path prefix (which would strip the prefix from req.url).
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").replace(/\?.*$/, "");
        // Only handle /ort/<filename>.mjs requests.
        const match = url.match(/^\/ort\/([^/]+\.mjs)$/);
        if (!match) {
          next();
          return;
        }
        const filename = match[1];
        const filePath = path.join(ORT_DIST, filename);
        if (!fs.existsSync(filePath)) {
          next();
          return;
        }
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.end(fs.readFileSync(filePath));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), ortWasmPlugin()],
  optimizeDeps: {
    // Exclude onnxruntime-web from pre-bundling so Vite doesn't try to
    // inline or transform the WASM worker files — let them resolve at runtime.
    exclude: ["onnxruntime-web", "openwakeword-wasm-browser"],
  },
  server: {
    port: 5173,
    strictPort: true,
    // Listen on all interfaces (IPv4 + IPv6). By default Vite binds only IPv6
    // [::1], but `tailscale serve` proxies to IPv4 127.0.0.1 — the mismatch
    // makes the tunnel return 502 (blank page on the phone). `host: true` binds
    // both so the proxy reaches the dev server.
    host: true,
    // Accept the Tailscale MagicDNS hostname so the phone can load the dev
    // server through `tailscale serve` without Vite's host check rejecting it.
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": "http://localhost:8787",
      "/focus": "http://localhost:8787",
      // WebSocket endpoints — proxied (ws: true) so the dev server (:5173) is a
      // complete stand-in for the backend, including over a tunnel. Without this
      // the client connection hangs in "connecting" forever in Vite dev.
      "/agent": { target: "ws://localhost:8787", ws: true },
      "/orchestrator": { target: "ws://localhost:8787", ws: true },
      "/terminal": { target: "ws://localhost:8787", ws: true },
    },
  },
});
