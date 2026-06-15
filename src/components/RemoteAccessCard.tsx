import { useEffect, useState } from "react";
import { Smartphone, Copy, Check } from "lucide-react";
import { httpBase } from "../lib/serverOrigin.js";

interface RemoteStatus {
  available: boolean;
  serving: boolean;
  url: string | null;
}

const SETUP_CMD = "./setup-remote.sh";

export function RemoteAccessCard() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(httpBase() + "/api/remote/status")
      .then((r) => r.json())
      .then((s: RemoteStatus) => { if (alive) setStatus(s); })
      .catch(() => { if (alive) setStatus({ available: false, serving: false, url: null }); });
    return () => { alive = false; };
  }, []);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
  };

  const ready = status?.available && status.serving && status.url;

  return (
    <div className="ew-remote">
      <div className="ew-remote-head">
        <Smartphone size={15} />
        <span>Use buildover on your phone</span>
      </div>

      {ready ? (
        <>
          <p className="ew-remote-desc">
            Remote access is live. Open this on your iPhone (with the Tailscale
            app installed and signed into the same account):
          </p>
          <button className="ew-remote-url" onClick={() => copy(status!.url!)} title="Copy URL">
            <span>{status!.url!.replace(/^https:\/\//, "")}</span>
            {copied === status!.url ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <ol className="ew-remote-steps">
            <li>Open the URL in <b>Safari</b>.</li>
            <li><b>Share → Add to Home Screen</b> for the branded app.</li>
            <li>Open it from the icon, tap <b>Notifications</b> to get alerts when agents finish.</li>
          </ol>
        </>
      ) : (
        <>
          <p className="ew-remote-desc">
            Run this once in the project folder to set up secure phone access
            over Tailscale (installs Tailscale, logs in, and serves over HTTPS):
          </p>
          <button className="ew-remote-cmd" onClick={() => copy(SETUP_CMD)} title="Copy command">
            <code>{SETUP_CMD}</code>
            {copied === SETUP_CMD ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <ol className="ew-remote-steps">
            <li>Run the command above — it prints your phone URL when done.</li>
            <li>Install <b>Tailscale</b> on your iPhone, sign in to the same account.</li>
            <li>Open the URL in Safari → <b>Add to Home Screen</b>.</li>
          </ol>
        </>
      )}
    </div>
  );
}
