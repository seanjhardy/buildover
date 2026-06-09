import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import "./styles/app.css";

// Listen for focus signals sent by the /focus redirect page (opened by the
// Dock launcher). When received, bring this tab to the front.
const focusChannel = new BroadcastChannel("buildover-focus");
focusChannel.addEventListener("message", () => {
  window.focus();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
