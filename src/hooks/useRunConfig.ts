import { useCallback, useEffect, useRef, useState } from "react";
import { runConfigApi, type RunConfig } from "../lib/api.js";

export function useRunConfig(repoPath: string | null) {
  const [config, setConfig] = useState<RunConfig | null>(null);
  const [panelHtml, setPanelHtml] = useState<string | null>(null);
  const [isPortListening, setIsPortListening] = useState(false);
  const portPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reload = useCallback(async () => {
    if (!repoPath) { setConfig(null); setPanelHtml(null); return; }
    try {
      const [cfg, html] = await Promise.all([
        runConfigApi.getConfig(repoPath),
        runConfigApi.getHtml(repoPath),
      ]);
      setConfig(cfg);
      setPanelHtml(html);
    } catch {
      setConfig(null);
      setPanelHtml(null);
    }
  }, [repoPath]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (portPollRef.current) clearInterval(portPollRef.current);
    if (!config?.devPort) { setIsPortListening(false); return; }
    const checkPort = async () => {
      try {
        const { listening } = await runConfigApi.checkPort(config.devPort!);
        setIsPortListening(listening);
      } catch { setIsPortListening(false); }
    };
    void checkPort();
    portPollRef.current = setInterval(() => void checkPort(), 3000);
    return () => { if (portPollRef.current) clearInterval(portPollRef.current); };
  }, [config?.devPort]);

  const killPort = useCallback(async () => {
    if (!config?.devPort) return;
    await runConfigApi.killPort(config.devPort);
    setIsPortListening(false);
  }, [config?.devPort]);

  return { config, panelHtml, isPortListening, killPort, reload };
}
