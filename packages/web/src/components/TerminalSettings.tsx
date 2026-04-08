"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ITheme } from "xterm";
import { cn } from "@/lib/cn";

// ── Types ────────────────────────────────────────────────────────────

export interface TerminalSettings {
  fontSize: number;
  cursorStyle: "block" | "bar" | "underline";
  themeName: string;
}

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
  cursorStyle: "bar",
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

export function useTerminalSettings(): [TerminalSettings, (s: Partial<TerminalSettings>) => void] {
  const [settings, setSettings] = useState<TerminalSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<TerminalSettings>;
        setSettings((prev) => ({ ...prev, ...parsed }));
      }
    } catch {
      // Ignore invalid JSON
    }
  }, []);

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

// ── Settings Panel ───────────────────────────────────────────────────

const FONT_SIZES = [12, 13, 14, 15, 16] as const;
const CURSOR_STYLES: Array<{ value: TerminalSettings["cursorStyle"]; label: string }> = [
  { value: "block", label: "Block" },
  { value: "bar", label: "Bar" },
  { value: "underline", label: "Underline" },
];

export function TerminalSettingsPanel({
  settings,
  onUpdate,
  onClose,
}: {
  settings: TerminalSettings;
  onUpdate: (s: Partial<TerminalSettings>) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full z-50 mt-1 w-64 border border-[var(--color-border-default)] bg-[#161b22] shadow-lg"
      style={{ borderRadius: "8px" }}
    >
      <div className="p-3">
        {/* Font Size */}
        <div className="mb-3">
          <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            Font Size
          </span>
          <div className="flex gap-1">
            {FONT_SIZES.map((size) => (
              <button
                key={size}
                onClick={() => onUpdate({ fontSize: size })}
                className={cn(
                  "flex-1 py-1 text-[11px] font-medium transition-colors",
                  settings.fontSize === size
                    ? "bg-[var(--color-accent)] text-white"
                    : "bg-[rgba(255,255,255,0.06)] text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.1)]",
                )}
                style={{ borderRadius: "4px" }}
              >
                {size}
              </button>
            ))}
          </div>
        </div>

        {/* Cursor Style */}
        <div className="mb-3">
          <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            Cursor
          </span>
          <div className="flex gap-1">
            {CURSOR_STYLES.map((cs) => (
              <button
                key={cs.value}
                onClick={() => onUpdate({ cursorStyle: cs.value })}
                className={cn(
                  "flex-1 py-1 text-[11px] font-medium transition-colors",
                  settings.cursorStyle === cs.value
                    ? "bg-[var(--color-accent)] text-white"
                    : "bg-[rgba(255,255,255,0.06)] text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.1)]",
                )}
                style={{ borderRadius: "4px" }}
              >
                {cs.label}
              </button>
            ))}
          </div>
        </div>

        {/* Theme Swatches */}
        <div>
          <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            Theme
          </span>
          <div className="grid grid-cols-3 gap-1.5">
            {THEME_PRESETS.map((preset) => (
              <button
                key={preset.name}
                onClick={() => onUpdate({ themeName: preset.name })}
                className={cn(
                  "flex flex-col items-center gap-1 py-1.5 text-[10px] transition-colors",
                  settings.themeName === preset.name
                    ? "bg-[rgba(255,255,255,0.1)] text-[var(--color-text-primary)]"
                    : "text-[var(--color-text-tertiary)] hover:bg-[rgba(255,255,255,0.06)]",
                )}
                style={{ borderRadius: "4px" }}
              >
                <span
                  className={cn(
                    "h-4 w-4 border",
                    settings.themeName === preset.name
                      ? "border-[var(--color-accent)]"
                      : "border-[rgba(255,255,255,0.15)]",
                  )}
                  style={{ background: preset.swatch, borderRadius: "3px" }}
                />
                <span className="leading-none">{preset.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
