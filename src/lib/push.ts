import { httpBase } from "./serverOrigin.js";

// Registers this device (phone PWA) for Web Push so the server can notify it
// when an agent finishes or needs input. No-op on platforms/contexts that don't
// support push (e.g. a non-installed iOS Safari tab, or the Electron desktop app).

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/**
 * Ensures this device has an active push subscription registered with the
 * server. Safe to call repeatedly (idempotent). Requires notification
 * permission to already be "granted" — call requestPermission() first.
 */
export async function ensurePushSubscription(): Promise<boolean> {
  if (!pushSupported()) return false;
  if (Notification.permission !== "granted") return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const res = await fetch(httpBase() + "/api/push/vapid-key");
      const { key } = (await res.json()) as { key: string };
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
    }
    await fetch(httpBase() + "/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub }),
    });
    return true;
  } catch (err) {
    console.warn("[push] subscription failed", err);
    return false;
  }
}

/** Convenience for a button: request permission, then subscribe. */
export async function enablePush(): Promise<boolean> {
  if (!pushSupported()) return false;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
  return ensurePushSubscription();
}
