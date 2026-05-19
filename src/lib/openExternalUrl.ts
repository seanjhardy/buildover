/** Open http(s) URLs in the system browser (Electron) or a new tab (browser dev). */
export function openExternalUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed || trimmed === "about:blank" || !/^https?:/i.test(trimmed)) return;

  if (window.electronShell?.openExternal) {
    void window.electronShell.openExternal(trimmed);
    return;
  }

  window.open(trimmed, "_blank", "noopener,noreferrer");
}
