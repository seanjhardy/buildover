import { useState, useEffect, useCallback, type ReactNode } from "react";
import { CheckCircle, ExternalLink, Eye, EyeOff, AlertCircle, Bell, Mic } from "lucide-react";
import { envApi } from "../lib/api.js";
import { enablePush } from "../lib/push.js";

interface EnvVarDef {
  key: string;
  label: string;
  feature: string;
  description: string;
  helpUrl: string;
  helpLinkText: string;
  optional?: boolean;
}

const ENV_VAR_DEFS: EnvVarDef[] = [
  {
    key: "WHISPER_API_KEY",
    label: "Groq API Key",
    feature: "Voice Transcription",
    description:
      "Powers real-time voice-to-text using Groq Whisper. Free tier covers most usage — no credit card required to start.",
    helpUrl: "https://console.groq.com/keys",
    helpLinkText: "Get a free key at console.groq.com",
  },
];

interface EnvVarRowProps {
  def: EnvVarDef;
  isSet: boolean;
  onSaved: () => void;
}

function EnvVarRow({ def, isSet, onSaved }: EnvVarRowProps) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showValue, setShowValue] = useState(false);

  const handleSave = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await envApi.setVar(def.key, trimmed);
      setJustSaved(true);
      setValue("");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [value, def.key, onSaved]);

  const configured = isSet || justSaved;

  return (
    <div className={`setup-var-row${configured ? " setup-var-row--set" : ""}`}>
      <div className="setup-var-header">
        <div className="setup-var-labels">
          <span className="setup-var-feature">{def.feature}</span>
          <code className="setup-var-key">{def.key}</code>
        </div>
        {configured ? (
          <span className="setup-var-status setup-var-status--ok">
            <CheckCircle size={12} />
            Configured
          </span>
        ) : (
          <span className="setup-var-status setup-var-status--missing">
            <AlertCircle size={12} />
            Missing
          </span>
        )}
      </div>

      <p className="setup-var-desc">{def.description}</p>

      <a
        href={def.helpUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="setup-var-link"
      >
        <ExternalLink size={11} />
        {def.helpLinkText}
      </a>

      {!configured && (
        <div className="setup-var-input-row">
          <div className="setup-var-input-wrap">
            <input
              type={showValue ? "text" : "password"}
              className="setup-var-input"
              placeholder={`Paste your ${def.label}…`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleSave(); }}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
            />
            <button
              type="button"
              className="setup-var-eye"
              onClick={() => setShowValue((v) => !v)}
              aria-label={showValue ? "Hide value" : "Show value"}
              tabIndex={-1}
            >
              {showValue ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <button
            type="button"
            className="setup-var-save"
            onClick={() => void handleSave()}
            disabled={saving || !value.trim()}
          >
            {saving ? "Saving…" : "Save to .env"}
          </button>
        </div>
      )}

      {error && <p className="setup-var-error">{error}</p>}
    </div>
  );
}

// ── Permissions section ───────────────────────────────────────────────────────

type PermStatus = "granted" | "denied" | "not-determined" | "unknown";

interface PermDef {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
}

const PERM_DEFS: PermDef[] = [
  {
    id: "notifications",
    label: "Notifications",
    description: "Alerts you when an agent needs attention or finishes a task.",
    icon: <Bell size={13} />,
  },
  {
    id: "microphone",
    label: "Microphone",
    description: "Required for real-time voice transcription with Groq Whisper.",
    icon: <Mic size={13} />,
  },
];

function normaliseNotificationPermission(): PermStatus {
  // Notification.permission is a browser API always available in Electron.
  const p = (typeof Notification !== "undefined" && Notification.permission) || "default";
  if (p === "granted") return "granted";
  if (p === "denied") return "denied";
  return "not-determined"; // "default" means never asked
}

function PermissionRow({ def, status }: { def: PermDef; status: PermStatus | null }) {
  const granted = status === "granted";

  // Desktop opens native System Settings via the Electron bridge. On the web
  // (phone PWA) there's no such bridge, but the browser can request the
  // notification permission directly — which works in an installed iOS PWA.
  const isElectron = typeof window !== "undefined" && !!window.electronPermissions;
  const canRequestWeb =
    def.id === "notifications" &&
    typeof Notification !== "undefined" &&
    typeof Notification.requestPermission === "function";
  const showActionButton = isElectron || canRequestWeb;

  const handleOpenSettings = () => {
    if (window.electronPermissions) {
      void window.electronPermissions.openSettings(def.id);
      return;
    }
    // Web (phone PWA): request permission and register for push in one go.
    if (canRequestWeb) void enablePush();
  };

  return (
    <div className={`perm-row${granted ? " perm-row--granted" : ""}`}>
      <div className="perm-row-header">
        <div className="perm-row-label">
          <span className="perm-row-icon">{def.icon}</span>
          <span className="perm-row-name">{def.label}</span>
        </div>
        <div className="perm-row-right">
          {status === null ? (
            <span className="perm-row-status perm-row-status--unknown">…</span>
          ) : granted ? (
            <span className="perm-row-status perm-row-status--granted">
              <CheckCircle size={11} />
              Allowed
            </span>
          ) : (
            <>
              <span className={`perm-row-status perm-row-status--${status === "denied" ? "denied" : "unknown"}`}>
                <AlertCircle size={11} />
                {status === "denied" ? "Denied" : "Not set"}
              </span>
              {showActionButton && (
                <button
                  type="button"
                  className="perm-row-settings-btn"
                  onClick={handleOpenSettings}
                >
                  {isElectron ? "Open Settings" : "Enable"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <p className="perm-row-desc">{def.description}</p>
    </div>
  );
}

function webPermStateToPermStatus(state: PermissionState): PermStatus {
  if (state === "granted") return "granted";
  if (state === "denied") return "denied";
  return "not-determined"; // "prompt" means not yet asked
}

function PermissionsSection() {
  const [statuses, setStatuses] = useState<Record<string, PermStatus | null>>({
    notifications: null,
    microphone: null,
  });

  useEffect(() => {
    let micStatus: PermissionStatus | null = null;

    async function init() {
      const next: Record<string, PermStatus> = {
        notifications: normaliseNotificationPermission(),
        microphone: "unknown",
      };

      try {
        // Use the Web Permissions API — this reflects what Electron's Chromium
        // renderer actually sees, which is what getUserMedia uses. It's more
        // reliable than querying the macOS TCC database from the main process.
        micStatus = await navigator.permissions.query(
          { name: "microphone" as PermissionName }
        );
        next.microphone = webPermStateToPermStatus(micStatus.state);
        micStatus.onchange = () => {
          setStatuses((prev) => ({
            ...prev,
            microphone: webPermStateToPermStatus(micStatus!.state),
          }));
        };
      } catch {
        next.microphone = "unknown";
      }

      setStatuses(next);
    }

    void init();

    return () => {
      if (micStatus) micStatus.onchange = null;
    };
  }, []);

  const allGranted = Object.values(statuses).every((s) => s === "granted");
  const pendingCount = Object.values(statuses).filter((s) => s !== null && s !== "granted").length;

  return (
    <div className="perm-section">
      <div className="perm-section-header">
        <h3 className="perm-section-title">PERMISSIONS</h3>
        {statuses.notifications !== null && (
          <span className={`setup-panel-badge${allGranted ? " setup-panel-badge--ok" : ""}`}>
            {allGranted ? "All allowed" : `${pendingCount} needed`}
          </span>
        )}
      </div>
      <div className="perm-rows-list">
        {PERM_DEFS.map((def) => (
          <PermissionRow key={def.id} def={def} status={statuses[def.id] ?? null} />
        ))}
      </div>
    </div>
  );
}

// ── Setup panel ───────────────────────────────────────────────────────────────

export function SetupPanel() {
  const [status, setStatus] = useState<Record<string, boolean> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setStatus(await envApi.getStatus());
    } catch {
      setStatus({});
    }
  }, []);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  const missingCount =
    status === null
      ? null
      : ENV_VAR_DEFS.filter((d) => !status[d.key]).length;

  return (
    <div className="setup-panel">
      <div className="setup-panel-header">
        <h2 className="setup-panel-title">SETUP</h2>
        {missingCount !== null && (
          <span
            className={`setup-panel-badge${missingCount === 0 ? " setup-panel-badge--ok" : ""}`}
          >
            {missingCount === 0 ? "All configured" : `${missingCount} remaining`}
          </span>
        )}
      </div>

      <p className="setup-panel-subtitle">
        Configure the services that power Buildover's features. Values are
        written directly to your local <code>.env</code> file.
      </p>

      <div className="setup-vars-list">
        {status === null ? (
          <div className="setup-panel-loading">Checking configuration…</div>
        ) : (
          ENV_VAR_DEFS.map((def) => (
            <EnvVarRow
              key={def.key}
              def={def}
              isSet={Boolean(status[def.key])}
              onSaved={fetchStatus}
            />
          ))
        )}
      </div>

      <div className="setup-panel-divider" />
      <PermissionsSection />
    </div>
  );
}
