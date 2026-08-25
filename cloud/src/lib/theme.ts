export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

export type ThemeStyle =
  | "orchestrate"
  | "github"
  | "catppuccin"
  | "dracula"
  | "tokyo-night"
  | "rose-pine"
  | "nord"
  | "gruvbox"
  | "solarized";

const THEME_KEY = "ao.theme";
const STYLE_KEY = "ao.theme-style";

function getStorage() {
  if (typeof window === "undefined" || !window.localStorage) return null;
  return window.localStorage;
}

export function systemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolveTheme(preference: ThemePreference): Theme {
  if (preference === "system") return systemTheme();
  return preference;
}

export function readStoredThemePreference(): ThemePreference {
  try {
    const stored = getStorage()?.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {}
  return "system";
}

export function readStoredThemeStyle(): ThemeStyle {
  try {
    const stored = getStorage()?.getItem(STYLE_KEY);
    if (
      stored === "orchestrate" || stored === "github" || stored === "catppuccin" ||
      stored === "dracula" || stored === "tokyo-night" || stored === "rose-pine" ||
      stored === "nord" || stored === "gruvbox" || stored === "solarized"
    ) return stored;
  } catch {}
  return "orchestrate";
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function applyThemeStyle(style: ThemeStyle): void {
  if (typeof document === "undefined") return;
  if (style === "orchestrate") {
    delete document.documentElement.dataset.styleTheme;
  } else {
    document.documentElement.dataset.styleTheme = style;
  }
}

export function saveThemePreference(pref: ThemePreference): void {
  getStorage()?.setItem(THEME_KEY, pref);
  applyTheme(resolveTheme(pref));
}

export function saveThemeStyle(style: ThemeStyle): void {
  getStorage()?.setItem(STYLE_KEY, style);
  applyThemeStyle(style);
}

export function initTheme(): void {
  applyTheme(resolveTheme(readStoredThemePreference()));
  applyThemeStyle(readStoredThemeStyle());
}
