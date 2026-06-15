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

// ── Web Push ────────────────────────────────────────────────────────────────
// Server pushes a JSON payload {title, body, tag, url}; show it as a system
// notification. On iOS this only fires when the app is installed to the Home
// Screen and notification permission has been granted.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "buildover", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "buildover";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || "buildover",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

// Tapping a notification focuses an existing app window or opens a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
