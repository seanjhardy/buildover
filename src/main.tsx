import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ensurePushSubscription } from "./lib/push.js";
import "./styles/app.css";

// Mobile browsers keep the CSS layout viewport at its full height while the
// on-screen keyboard shrinks the visual viewport. Expose that visible height
// to CSS so the fixed PWA shell can resize with the keyboard instead of leaving
// bottom-docked controls behind it.
const syncVisualViewport = () => {
  const viewport = window.visualViewport;
  const height = viewport?.height ?? window.innerHeight;
  const offsetTop = viewport?.offsetTop ?? 0;
  document.documentElement.style.setProperty(
    "--app-visual-viewport-height",
    `${Math.round(height)}px`,
  );
  document.documentElement.style.setProperty(
    "--app-visual-viewport-offset-top",
    `${Math.round(offsetTop)}px`,
  );
};

syncVisualViewport();
window.addEventListener("resize", syncVisualViewport, { passive: true });
window.visualViewport?.addEventListener("resize", syncVisualViewport, {
  passive: true,
});
window.visualViewport?.addEventListener("scroll", syncVisualViewport, {
  passive: true,
});

// If this device already granted notifications (installed phone PWA), make sure
// it's still registered for push on the server. No-op everywhere else.
void ensurePushSubscription();

// Listen for focus signals sent by the /focus redirect page (opened by the
// Dock launcher). When received, bring this tab to the front. Guarded because
// BroadcastChannel is unavailable on older mobile Safari — an unguarded throw
// here would white-screen the app before React (and the ErrorBoundary) mounts.
try {
  if (typeof BroadcastChannel !== "undefined") {
    const focusChannel = new BroadcastChannel("buildover-focus");
    focusChannel.addEventListener("message", () => {
      window.focus();
    });
  }
} catch {
  /* non-fatal: focus relay just won't work */
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
