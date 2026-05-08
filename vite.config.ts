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
  // Use relative paths so assets load correctly when Electron serves the
  // production build from a file:// URL inside the .app bundle.
  base: "./",
  plugins: [react(), ortWasmPlugin()],
  optimizeDeps: {
    // Exclude onnxruntime-web from pre-bundling so Vite doesn't try to
    // inline or transform the WASM worker files — let them resolve at runtime.
    exclude: ["onnxruntime-web", "openwakeword-wasm-browser"],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
