import { useCallback, useEffect, useState } from "react";

export type AppThemeId = "sunset" | "arctic" | "ocean";

export interface CustomColors {
  accent?: string;
  accentHover?: string;
  background?: string;
  secondaryBackground?: string;
  foreground?: string;
  border?: string;
}

const STORAGE_KEY_APP = "buildover.appTheme";
const STORAGE_KEY_SYNTAX = "buildover.syntaxTheme";
const STORAGE_KEY_CUSTOM = "buildover.customColors";
const SYNTAX_LINK_ID = "buildover-syntax-theme";
const CDN_BASE = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles";

export function applyAppTheme(themeId: AppThemeId) {
  document.documentElement.dataset.theme = themeId;
}

export function applySyntaxTheme(themeName: string | null) {
  const existing = document.getElementById(SYNTAX_LINK_ID) as HTMLLinkElement | null;
  if (!themeName) {
    existing?.remove();
    return;
  }
  const link = existing ?? document.createElement("link") as HTMLLinkElement;
  link.id = SYNTAX_LINK_ID;
  link.rel = "stylesheet";
  link.href = `${CDN_BASE}/${themeName}.min.css`;
  if (!existing) document.head.appendChild(link);
}

export function applyCustomColors(colors: CustomColors) {
  const root = document.documentElement;
  const map: Record<keyof CustomColors, string> = {
    accent: "--app-claude-orange",
    accentHover: "--app-claude-clay-button-orange",
    background: "--app-primary-background",
    secondaryBackground: "--app-secondary-background",
    foreground: "--app-primary-foreground",
    border: "--app-primary-border-color",
  };
  for (const [key, cssVar] of Object.entries(map) as [keyof CustomColors, string][]) {
    const val = colors[key];
    if (val) root.style.setProperty(cssVar, val);
    else root.style.removeProperty(cssVar);
  }
}

export function useTheme() {
  const [appTheme, setAppThemeState] = useState<AppThemeId>(() => {
    return (localStorage.getItem(STORAGE_KEY_APP) as AppThemeId) ?? "sunset";
  });
  const [syntaxTheme, setSyntaxThemeState] = useState<string | null>(() => {
    return localStorage.getItem(STORAGE_KEY_SYNTAX);
  });
  const [customColors, setCustomColorsState] = useState<CustomColors>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_CUSTOM) ?? "{}");
    } catch {
      return {};
    }
  });

  useEffect(() => { applyAppTheme(appTheme); }, [appTheme]);
  useEffect(() => { applySyntaxTheme(syntaxTheme); }, [syntaxTheme]);
  useEffect(() => { applyCustomColors(customColors); }, [customColors]);

  const setAppTheme = useCallback((id: AppThemeId) => {
    setAppThemeState(id);
    localStorage.setItem(STORAGE_KEY_APP, id);
    // Clear custom colors when switching themes
    setCustomColorsState({});
    localStorage.removeItem(STORAGE_KEY_CUSTOM);
    applyCustomColors({});
  }, []);

  const setSyntaxTheme = useCallback((name: string | null) => {
    setSyntaxThemeState(name);
    if (!name) localStorage.removeItem(STORAGE_KEY_SYNTAX);
    else localStorage.setItem(STORAGE_KEY_SYNTAX, name);
  }, []);

  const setCustomColor = useCallback((key: keyof CustomColors, value: string | null) => {
    setCustomColorsState((prev) => {
      const next = { ...prev };
      if (value === null) delete next[key];
      else next[key] = value;
      localStorage.setItem(STORAGE_KEY_CUSTOM, JSON.stringify(next));
      applyCustomColors(next);
      return next;
    });
  }, []);

  return { appTheme, syntaxTheme, customColors, setAppTheme, setSyntaxTheme, setCustomColor };
}
