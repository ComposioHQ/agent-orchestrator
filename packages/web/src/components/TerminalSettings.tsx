"use client";

import { useState, useCallback } from "react";
import type { ITheme } from "xterm";

// ── Types ────────────────────────────────────────────────────────────

export interface TerminalSettings {
  fontSize: number;
  fontFamily: string;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  selectionColor: string;
  themeName: string;
}

export const FONT_FAMILIES = [
  { value: '"JetBrains Mono", monospace', label: "JetBrains Mono" },
  { value: '"Fira Code", monospace', label: "Fira Code" },
  { value: '"Source Code Pro", monospace', label: "Source Code Pro" },
  { value: '"SF Mono", monospace', label: "SF Mono" },
  { value: '"Cascadia Code", monospace', label: "Cascadia Code" },
  { value: 'ui-monospace, monospace', label: "System Mono" },
] as const;

export const SELECTION_COLORS = [
  { value: "rgba(88,166,255,0.3)", label: "Blue", swatch: "#58a6ff" },
  { value: "rgba(210,168,255,0.3)", label: "Purple", swatch: "#d2a8ff" },
  { value: "rgba(63,185,80,0.3)", label: "Green", swatch: "#3fb950" },
  { value: "rgba(240,136,62,0.3)", label: "Orange", swatch: "#f0883e" },
  { value: "rgba(255,123,114,0.3)", label: "Red", swatch: "#ff7b72" },
] as const;

function isValidFontSize(n: number): boolean {
  return Number.isInteger(n) && n >= 10 && n <= 22;
}
const VALID_CURSOR_STYLES = new Set(["block", "bar", "underline"]);

export interface ThemePreset {
  name: string;
  label: string;
  swatch: string; // Preview color for the selector
  dark: ITheme;
}

// ── Defaults ─────────────────────────────────────────────────────────

const STORAGE_KEY = "ao-terminal-settings";

const DEFAULT_SETTINGS: TerminalSettings = {
  fontSize: 14,
  fontFamily: '"JetBrains Mono", monospace',
  cursorStyle: "bar",
  cursorBlink: true,
  selectionColor: "rgba(88,166,255,0.3)",
  themeName: "github-dark",
};

// ── Theme Presets ────────────────────────────────────────────────────

export const THEME_PRESETS: ThemePreset[] = [
  {
    name: "github-dark",
    label: "GitHub Dark",
    swatch: "#0d1117",
    dark: {
      background: "#0d1117",
      foreground: "#c9d1d9",
      cursor: "#58a6ff",
      cursorAccent: "#0d1117",
      selectionBackground: "rgba(88, 166, 255, 0.3)",
      selectionInactiveBackground: "rgba(128, 128, 128, 0.2)",
      black: "#161b22",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39d2c0",
      white: "#c9d1d9",
      brightBlack: "#484f58",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
  },
  {
    name: "dracula",
    label: "Dracula",
    swatch: "#282a36",
    dark: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "rgba(68, 71, 90, 0.6)",
      selectionInactiveBackground: "rgba(68, 71, 90, 0.3)",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    name: "tokyo-night",
    label: "Tokyo Night",
    swatch: "#1a1b26",
    dark: {
      background: "#1a1b26",
      foreground: "#a9b1d6",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "rgba(45, 51, 89, 0.6)",
      selectionInactiveBackground: "rgba(45, 51, 89, 0.3)",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  {
    name: "one-dark",
    label: "One Dark",
    swatch: "#282c34",
    dark: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      cursorAccent: "#282c34",
      selectionBackground: "rgba(82, 139, 255, 0.25)",
      selectionInactiveBackground: "rgba(128, 128, 128, 0.2)",
      black: "#1e2127",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#d19a66",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#d19a66",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  {
    name: "catppuccin",
    label: "Catppuccin",
    swatch: "#1e1e2e",
    dark: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "rgba(88, 91, 112, 0.5)",
      selectionInactiveBackground: "rgba(88, 91, 112, 0.25)",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
  {
    name: "nord",
    label: "Nord",
    swatch: "#2e3440",
    dark: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "rgba(136, 192, 208, 0.25)",
      selectionInactiveBackground: "rgba(136, 192, 208, 0.12)",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
];

// ── Hook ─────────────────────────────────────────────────────────────

function loadPersistedSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SETTINGS;
    const obj = parsed as Record<string, unknown>;
    return {
      fontSize:
        typeof obj.fontSize === "number" && isValidFontSize(obj.fontSize)
          ? obj.fontSize
          : DEFAULT_SETTINGS.fontSize,
      fontFamily:
        typeof obj.fontFamily === "string" && FONT_FAMILIES.some((f) => f.value === obj.fontFamily)
          ? obj.fontFamily
          : DEFAULT_SETTINGS.fontFamily,
      cursorStyle:
        typeof obj.cursorStyle === "string" && VALID_CURSOR_STYLES.has(obj.cursorStyle)
          ? (obj.cursorStyle as TerminalSettings["cursorStyle"])
          : DEFAULT_SETTINGS.cursorStyle,
      cursorBlink:
        typeof obj.cursorBlink === "boolean"
          ? obj.cursorBlink
          : DEFAULT_SETTINGS.cursorBlink,
      selectionColor:
        typeof obj.selectionColor === "string" && SELECTION_COLORS.some((c) => c.value === obj.selectionColor)
          ? obj.selectionColor
          : DEFAULT_SETTINGS.selectionColor,
      themeName:
        typeof obj.themeName === "string" && THEME_PRESETS.some((t) => t.name === obj.themeName)
          ? obj.themeName
          : DEFAULT_SETTINGS.themeName,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useTerminalSettings(): [TerminalSettings, (s: Partial<TerminalSettings>) => void] {
  // Synchronous initializer — settings are available on first render,
  // avoiding an async race with the terminal initialization effect.
  const [settings, setSettings] = useState<TerminalSettings>(loadPersistedSettings);

  const updateSettings = useCallback((partial: Partial<TerminalSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // localStorage full or unavailable
      }
      return next;
    });
  }, []);

  return [settings, updateSettings];
}

export function getThemePreset(name: string): ThemePreset | undefined {
  return THEME_PRESETS.find((t) => t.name === name);
}

