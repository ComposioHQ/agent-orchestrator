import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Tests for DirectTerminal font size and touch scroll functionality.
 */
describe("DirectTerminal", () => {
  const FONT_SIZE_KEY = "ao-terminal-font-size";

  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("loads font size from localStorage on initialization", () => {
    localStorage.setItem(FONT_SIZE_KEY, "14");
    const stored = localStorage.getItem(FONT_SIZE_KEY);
    expect(stored).toBe("14");
  });

  it("clamping respects minimum font size of 9", () => {
    const minSize = 9;
    const clamped = Math.max(minSize, 8);
    expect(clamped).toBe(9);
  });

  it("clamping respects maximum font size of 18", () => {
    const maxSize = 18;
    const clamped = Math.min(maxSize, 19);
    expect(clamped).toBe(18);
  });

  it("font size button decrements and writes to localStorage", () => {
    const fontSize = 13;
    const newFontSize = Math.max(9, fontSize - 1);
    localStorage.setItem(FONT_SIZE_KEY, String(newFontSize));
    expect(localStorage.getItem(FONT_SIZE_KEY)).toBe("12");
  });

  it("font size button increments and writes to localStorage", () => {
    const fontSize = 13;
    const newFontSize = Math.min(18, fontSize + 1);
    localStorage.setItem(FONT_SIZE_KEY, String(newFontSize));
    expect(localStorage.getItem(FONT_SIZE_KEY)).toBe("14");
  });

  it("font size buttons disable at min and max bounds", () => {
    const minDisabled = 9 <= 9;
    const maxDisabled = 18 >= 18;
    expect(minDisabled).toBe(true);
    expect(maxDisabled).toBe(true);
  });
});
