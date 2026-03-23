import type { ITheme } from "xterm";

/** Visual variant for the terminal chrome. */
export type TerminalVariant = "agent" | "orchestrator";

/** Connection status for the terminal. */
export type TerminalStatus = "connecting" | "connected" | "error";

/** Terminal font configuration. */
export const TERMINAL_FONT_FAMILY =
  '"IBM Plex Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace';
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_SCROLLBACK = 10000;
export const TERMINAL_BACKGROUND = "#0a0a0f";

/**
 * ANSI color palette shared across terminal variants.
 * These are xterm.js theme colors that must remain as hex values
 * because they are passed into the xterm.js Terminal constructor
 * (not CSS classes).
 */
const ANSI_COLORS = {
  black: "#1a1a24",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#f59e0b",
  blue: "#5b7ef8",
  magenta: "#a371f7",
  cyan: "#22d3ee",
  white: "#d4d4d8",
  brightBlack: "#50506a",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fbbf24",
  brightBlue: "#7b9cfb",
  brightMagenta: "#c084fc",
  brightCyan: "#67e8f9",
  brightWhite: "#eeeef5",
} as const;

/** Variant-specific cursor and selection colors (hex for xterm.js theme). */
const VARIANT_COLORS = {
  agent: {
    cursor: "#5b7ef8",
    selection: "rgba(91, 126, 248, 0.3)",
  },
  orchestrator: {
    cursor: "#a371f7",
    selection: "rgba(163, 113, 247, 0.25)",
  },
} as const;

/** Light-mode ANSI colors with higher contrast for readability on white backgrounds. */
const ANSI_COLORS_LIGHT = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#9a6700",
  blue: "#0550ae",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#7d4e00",
  brightBlue: "#0969da",
  brightMagenta: "#6639ba",
  brightCyan: "#1b7c83",
  brightWhite: "#8c959f",
} as const;

export const TERMINAL_BACKGROUND_LIGHT = "#fafafa";

/**
 * Build dark and light xterm.js ITheme objects for a given variant.
 * All colors here are hex/rgba values required by the xterm.js API --
 * they cannot be replaced with CSS custom properties.
 */
export function buildTerminalTheme(variant: TerminalVariant): ITheme {
  const colors = VARIANT_COLORS[variant];
  return {
    background: TERMINAL_BACKGROUND,
    foreground: "#d4d4d8",
    cursor: colors.cursor,
    cursorAccent: TERMINAL_BACKGROUND,
    selectionBackground: colors.selection,
    ...ANSI_COLORS,
  };
}

export function buildTerminalThemeLight(variant: TerminalVariant): ITheme {
  const colors = VARIANT_COLORS[variant];
  return {
    background: TERMINAL_BACKGROUND_LIGHT,
    foreground: "#24292f",
    cursor: colors.cursor,
    cursorAccent: TERMINAL_BACKGROUND_LIGHT,
    selectionBackground: colors.selection,
    ...ANSI_COLORS_LIGHT,
  };
}

/** Return the CSS custom property for the variant accent color. */
export function getAccentColor(variant: TerminalVariant): string {
  return variant === "orchestrator"
    ? "var(--color-accent-violet)"
    : "var(--color-accent)";
}

/** Tailwind class for the status indicator dot. */
export function getStatusDotClass(status: TerminalStatus): string {
  switch (status) {
    case "connected":
      return "bg-[var(--color-status-ready)]";
    case "error":
      return "bg-[var(--color-status-error)]";
    case "connecting":
      return "bg-[var(--color-status-attention)] animate-[pulse_1.5s_ease-in-out_infinite]";
  }
}

/** Tailwind text color class for the status label. */
export function getStatusTextColor(status: TerminalStatus): string {
  switch (status) {
    case "connected":
      return "text-[var(--color-status-ready)]";
    case "error":
      return "text-[var(--color-status-error)]";
    case "connecting":
      return "text-[var(--color-text-tertiary)]";
  }
}

/** Human-readable status label. */
export function getStatusText(
  status: TerminalStatus,
  error: string | null,
): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "error":
      return error ?? "Error";
    case "connecting":
      return "Connecting\u2026";
  }
}
