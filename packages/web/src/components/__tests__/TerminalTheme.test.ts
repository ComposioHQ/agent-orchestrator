import { describe, it, expect } from "vitest";
import {
  buildTerminalTheme,
  getAccentColor,
  getStatusDotClass,
  getStatusText,
  getStatusTextColor,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_SCROLLBACK,
  TERMINAL_BACKGROUND,
} from "@/components/TerminalTheme";

describe("TerminalTheme constants", () => {
  it("exports expected font family", () => {
    expect(TERMINAL_FONT_FAMILY).toContain("IBM Plex Mono");
  });

  it("exports expected font size", () => {
    expect(TERMINAL_FONT_SIZE).toBe(13);
  });

  it("exports expected scrollback", () => {
    expect(TERMINAL_SCROLLBACK).toBe(10000);
  });

  it("exports expected background color", () => {
    expect(TERMINAL_BACKGROUND).toBe("#0a0a0f");
  });
});

describe("buildTerminalTheme", () => {
  it("returns agent theme with blue cursor", () => {
    const theme = buildTerminalTheme("agent");
    expect(theme.cursor).toBe("#5b7ef8");
    expect(theme.selectionBackground).toBe("rgba(91, 126, 248, 0.3)");
    expect(theme.background).toBe("#0a0a0f");
  });

  it("returns orchestrator theme with violet cursor", () => {
    const theme = buildTerminalTheme("orchestrator");
    expect(theme.cursor).toBe("#a371f7");
    expect(theme.selectionBackground).toBe("rgba(163, 113, 247, 0.25)");
    expect(theme.background).toBe("#0a0a0f");
  });

  it("includes ANSI colors in both variants", () => {
    for (const variant of ["agent", "orchestrator"] as const) {
      const theme = buildTerminalTheme(variant);
      expect(theme.red).toBe("#ef4444");
      expect(theme.green).toBe("#22c55e");
      expect(theme.blue).toBe("#5b7ef8");
      expect(theme.brightWhite).toBe("#eeeef5");
    }
  });

  it("sets cursorAccent to background color", () => {
    const theme = buildTerminalTheme("agent");
    expect(theme.cursorAccent).toBe(theme.background);
  });
});

describe("getAccentColor", () => {
  it("returns accent CSS variable for agent variant", () => {
    expect(getAccentColor("agent")).toBe("var(--color-accent)");
  });

  it("returns violet accent CSS variable for orchestrator variant", () => {
    expect(getAccentColor("orchestrator")).toBe("var(--color-accent-violet)");
  });
});

describe("getStatusDotClass", () => {
  it("returns ready class for connected status", () => {
    expect(getStatusDotClass("connected")).toContain("color-status-ready");
  });

  it("returns error class for error status", () => {
    expect(getStatusDotClass("error")).toContain("color-status-error");
  });

  it("returns attention class with animation for connecting status", () => {
    const cls = getStatusDotClass("connecting");
    expect(cls).toContain("color-status-attention");
    expect(cls).toContain("animate-");
  });
});

describe("getStatusTextColor", () => {
  it("returns ready text color for connected", () => {
    expect(getStatusTextColor("connected")).toContain("color-status-ready");
  });

  it("returns error text color for error", () => {
    expect(getStatusTextColor("error")).toContain("color-status-error");
  });

  it("returns tertiary text color for connecting", () => {
    expect(getStatusTextColor("connecting")).toContain("color-text-tertiary");
  });
});

describe("getStatusText", () => {
  it("returns Connected for connected status", () => {
    expect(getStatusText("connected", null)).toBe("Connected");
  });

  it("returns error message for error status", () => {
    expect(getStatusText("error", "Session not found")).toBe("Session not found");
  });

  it("returns fallback Error for error status with null error", () => {
    expect(getStatusText("error", null)).toBe("Error");
  });

  it("returns Connecting with ellipsis for connecting status", () => {
    const text = getStatusText("connecting", null);
    expect(text).toContain("Connecting");
  });
});
