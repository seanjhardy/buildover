// Minimal service worker for buildover's PWA.
//
// buildover is a live tool — every view depends on the server (HTTP + WS), so
// we deliberately do NOT cache app state or API responses; a stale chat list or
// frozen agent output would be worse than an honest "offline". The SW exists
// only to satisfy installability and let iOS launch the app standalone (its own
// icon, no Safari chrome). It activates immediately and otherwise stays out of
// the way, letting every request hit the network as normal.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch handler. Having a fetch handler is what makes the app
// installable; we add no caching so nothing can go stale.
self.addEventListener("fetch", () => {
  // No-op: let the request proceed to the network untouched.
});
