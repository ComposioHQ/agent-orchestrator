import type { ITheme } from "@xterm/xterm";

function cssVar(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function buildTerminalTheme(): ITheme {
  const namedThemeActive = typeof document !== "undefined" && Boolean(document.documentElement.dataset.styleTheme);
  const isLight = document.documentElement.dataset.theme === "light";
  const bg = namedThemeActive
    ? cssVar("--background")
    : cssVar("--color-bg-terminal-opaque") || cssVar("--color-bg-terminal");
  const fg = namedThemeActive ? cssVar("--foreground") : cssVar("--color-text-terminal");
  const cursor = isLight ? fg : (namedThemeActive ? cssVar("--primary") : cssVar("--color-working") || "#4d8dff");

  return {
    background: bg,
    foreground: fg,
    cursor,
    cursorAccent: bg,
    selectionBackground: cssVar(isLight ? "--color-term-selection-light" : "--color-term-selection-dark") || "#4d8dff4d",
    selectionInactiveBackground: cssVar(isLight ? "--color-term-selection-inactive-light" : "--color-term-selection-inactive") || "rgba(128,128,128,0.2)",
    black: cssVar("--color-term-black") || "#1f2329",
    red: cssVar("--color-term-red") || "#f05d5e",
    green: cssVar("--color-term-green") || "#44c97a",
    yellow: cssVar("--color-term-yellow") || "#e5c34b",
    blue: cssVar("--color-term-blue") || "#5b9cff",
    magenta: cssVar("--color-term-magenta") || "#c678dd",
    cyan: cssVar("--color-term-cyan") || "#56b6c2",
    white: cssVar("--color-term-white") || "#d7dae0",
    brightBlack: cssVar("--color-term-bright-black") || "#7f8792",
    brightRed: cssVar("--color-term-bright-red") || "#ff7b7c",
    brightGreen: cssVar("--color-term-bright-green") || "#62df91",
    brightYellow: cssVar("--color-term-bright-yellow") || "#f2d66d",
    brightBlue: cssVar("--color-term-bright-blue") || "#79b1ff",
    brightMagenta: cssVar("--color-term-bright-magenta") || "#d99aee",
    brightCyan: cssVar("--color-term-bright-cyan") || "#79d4df",
    brightWhite: cssVar("--color-term-bright-white") || "#f4f5f7",
  };
}
