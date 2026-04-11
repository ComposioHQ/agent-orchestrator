import { describe, it, expect } from "vitest";
import { THEME_PRESETS, FONT_FAMILIES, getThemePreset } from "@/components/TerminalSettings";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

describe("THEME_PRESETS", () => {
  it("has at least 6 theme presets", () => {
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(6);
  });

  it("each preset has valid hex colors for all ANSI slots", () => {
    for (const preset of THEME_PRESETS) {
      expect(preset.dark.background).toMatch(HEX_RE);
      expect(preset.dark.foreground).toMatch(HEX_RE);
      for (const key of ANSI_KEYS) {
        expect(preset.dark[key], `${preset.name}.${key}`).toMatch(HEX_RE);
      }
    }
  });

  it("each preset has a unique name and swatch color", () => {
    const names = THEME_PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    const swatches = THEME_PRESETS.map((p) => p.swatch);
    expect(new Set(swatches).size).toBe(swatches.length);
  });

  it("github-dark is the first preset", () => {
    expect(THEME_PRESETS[0].name).toBe("github-dark");
    expect(THEME_PRESETS[0].dark.background).toBe("#0d1117");
  });
});

describe("getThemePreset", () => {
  it("returns the preset for a valid name", () => {
    const preset = getThemePreset("dracula");
    expect(preset).toBeDefined();
    expect(preset!.dark.background).toBe("#282a36");
  });

  it("returns undefined for an invalid name", () => {
    expect(getThemePreset("nonexistent")).toBeUndefined();
  });
});

describe("FONT_FAMILIES", () => {
  it("has at least 5 font family options", () => {
    expect(FONT_FAMILIES.length).toBeGreaterThanOrEqual(5);
  });

  it("each font family has a value and label", () => {
    for (const font of FONT_FAMILIES) {
      expect(font.value).toBeTruthy();
      expect(font.label).toBeTruthy();
      expect(font.value).toContain("monospace");
    }
  });

  it("JetBrains Mono is the first option", () => {
    expect(FONT_FAMILIES[0].label).toBe("JetBrains Mono");
  });
});
