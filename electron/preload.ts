// Intentionally minimal preload script.
// All backend communication uses the Express HTTP/WebSocket server on port 8787,
// accessed via standard web fetch/WebSocket APIs in the renderer.
// Add contextBridge.exposeInMainWorld() calls here if you ever need to
// expose safe Node APIs to the renderer.
