import { useState } from "react";
import { Bell } from "lucide-react";
import { pushSupported, enablePush } from "../lib/push.js";

// Header affordance to turn on phone push notifications. Only relevant on the
// web (phone PWA) — the Electron desktop app uses native notifications, so this
// is hidden there. Disappears once permission is granted.
export function NotificationButton() {
  const [perm, setPerm] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );

  // Hidden in Electron (native notifications), where unsupported, or once granted.
  if (typeof window !== "undefined" && window.electronPermissions) return null;
  if (!pushSupported() || perm === "granted") return null;

  return (
    <button
      className="notif-enable-btn"
      title="Enable notifications when agents finish"
      onClick={async () => {
        await enablePush();
        setPerm(Notification.permission);
      }}
    >
      <Bell size={13} />
      <span className="notif-enable-label">Notifications</span>
    </button>
  );
}
