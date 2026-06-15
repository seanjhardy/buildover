import { useCallback, useEffect, useRef, useState } from "react";
import { Coffee, Monitor, MonitorOff, X } from "lucide-react";
import { caffeineApi, type CaffeineStatus } from "../lib/api.js";

function formatRemaining(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h <= 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function CaffeineButton() {
  const [status, setStatus] = useState<CaffeineStatus | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await caffeineApi.getStatus());
    } catch {
      /* ignore — server may be briefly unavailable */
    }
  }, []);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => void refresh(), 30_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  // Don't render on platforms where caffeinate isn't available (non-macOS).
  if (status && !status.supported) return null;

  const active = status?.active ?? false;
  const secondsRemaining = status?.secondsRemaining ?? 0;
  const keepDisplayAwake = status?.keepDisplayAwake ?? true;

  const addHour = async () => {
    setStatus(await caffeineApi.addHour());
  };
  const stop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setStatus(await caffeineApi.stop());
  };
  const toggleDisplay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setStatus(await caffeineApi.setDisplay(!keepDisplayAwake));
  };

  const title = active
    ? `Staying awake for ${formatRemaining(secondsRemaining)} — click to add 1 hour`
    : "Keep Mac awake — click to add 1 hour";

  return (
    <div className={`caffeine-btn ${active ? "active" : ""}`}>
      <button
        className="caffeine-main"
        onClick={() => void addHour()}
        title={title}
        aria-label={title}
      >
        <Coffee size={13} />
        <span className="caffeine-label">
          {active ? formatRemaining(secondsRemaining) : "caffeinate"}
        </span>
      </button>
      {active && (
        <>
          <button
            className={`caffeine-toggle ${keepDisplayAwake ? "on" : ""}`}
            onClick={(e) => void toggleDisplay(e)}
            title={
              keepDisplayAwake
                ? "Display stays on — click to allow display sleep"
                : "Display can sleep — click to keep display on"
            }
            aria-label="Toggle display sleep"
            aria-pressed={keepDisplayAwake}
          >
            {keepDisplayAwake ? <Monitor size={12} /> : <MonitorOff size={12} />}
          </button>
          <button
            className="caffeine-stop"
            onClick={(e) => void stop(e)}
            title="Stop keeping awake"
            aria-label="Stop keeping awake"
          >
            <X size={12} />
          </button>
        </>
      )}
    </div>
  );
}
