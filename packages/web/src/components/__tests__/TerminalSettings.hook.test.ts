import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useTerminalSettings,
  getThemePreset,
  THEME_PRESETS,
  FONT_FAMILIES,
  type TerminalSettings,
} from "@/components/TerminalSettings";

const STORAGE_KEY = "ao-terminal-settings";

function createMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}

describe("useTerminalSettings", () => {
  let mockStorage: Storage;

  beforeEach(() => {
    mockStorage = createMockStorage();
    vi.stubGlobal("localStorage", mockStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns default settings when localStorage is empty", () => {
    const { result } = renderHook(() => useTerminalSettings());
    const [settings] = result.current;
    expect(settings.fontSize).toBe(14);
    expect(settings.fontFamily).toBe('"JetBrains Mono", monospace');
    expect(settings.cursorStyle).toBe("bar");
    expect(settings.cursorBlink).toBe(true);
    expect(settings.themeName).toBe("github-dark");
  });

  it("loads persisted settings from localStorage", () => {
    const saved: TerminalSettings = {
      fontSize: 16,
      fontFamily: "Menlo, monospace",
      cursorStyle: "block",
      cursorBlink: false,
      themeName: "dracula",
    };
    mockStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

    const { result } = renderHook(() => useTerminalSettings());
    const [settings] = result.current;
    expect(settings.fontSize).toBe(16);
    expect(settings.fontFamily).toBe("Menlo, monospace");
    expect(settings.cursorStyle).toBe("block");
    expect(settings.cursorBlink).toBe(false);
    expect(settings.themeName).toBe("dracula");
  });

  it("falls back to defaults for invalid fontSize", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 999 }));
    const { result } = renderHook(() => useTerminalSettings());
    expect(result.current[0].fontSize).toBe(14);
  });

  it("falls back to defaults for non-integer fontSize", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 14.5 }));
    const { result } = renderHook(() => useTerminalSettings());
    expect(result.current[0].fontSize).toBe(14);
  });

  it("falls back to defaults for fontSize below minimum", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 5 }));
    const { result } = renderHook(() => useTerminalSettings());
    expect(result.current[0].fontSize).toBe(14);
  });

  it("accepts valid fontSize at boundaries (10 and 22)", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 10 }));
    const { result: result1 } = renderHook(() => useTerminalSettings());
    expect(result1.current[0].fontSize).toBe(10);

    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 22 }));
    const { result: result2 } = renderHook(() => useTerminalSettings());
    expect(result2.current[0].fontSize).toBe(22);
  });

  it("falls back to defaults for invalid cursorStyle", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ cursorStyle: "blink" }));
    const { result } = renderHook(() => useTerminalSettings());
    expect(result.current[0].cursorStyle).toBe("bar");
  });

  it("falls back to defaults for invalid themeName", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ themeName: "solarized" }));
    const { result } = renderHook(() => useTerminalSettings());
    expect(result.current[0].themeName).toBe("github-dark");
  });

  it("falls back to defaults for invalid fontFamily", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ fontFamily: "Comic Sans" }));
    const { result } = renderHook(() => useTerminalSettings());
    expect(result.current[0].fontFamily).toBe('"JetBrains Mono", monospace');
  });

  it("falls back to defaults for non-object JSON", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify("not-an-object"));
    const { result } = renderHook(() => useTerminalSettings());
    expect(result.current[0].fontSize).toBe(14);
  });

  it("falls back to defaults for null JSON", () => {
    mockStorage.setItem(STORAGE_KEY, "null");
    const { result } = renderHook(() => useTerminalSettings());
    expect(result.current[0].fontSize).toBe(14);
  });

  it("falls back to defaults for invalid JSON", () => {
    mockStorage.setItem(STORAGE_KEY, "{broken");
    const { result } = renderHook(() => useTerminalSettings());
    expect(result.current[0].fontSize).toBe(14);
  });

  it("falls back to defaults for non-boolean cursorBlink", () => {
    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ cursorBlink: "yes" }));
    const { result } = renderHook(() => useTerminalSettings());
    expect(result.current[0].cursorBlink).toBe(true);
  });

  it("updateSettings merges partial updates and persists to localStorage", () => {
    const { result } = renderHook(() => useTerminalSettings());
    act(() => {
      result.current[1]({ fontSize: 18 });
    });

    expect(result.current[0].fontSize).toBe(18);
    expect(result.current[0].cursorStyle).toBe("bar"); // unchanged

    const stored = JSON.parse(mockStorage.getItem(STORAGE_KEY)!);
    expect(stored.fontSize).toBe(18);
    expect(stored.cursorStyle).toBe("bar");
  });

  it("updateSettings handles localStorage write failure gracefully", () => {
    const { result } = renderHook(() => useTerminalSettings());

    const original = mockStorage.setItem.bind(mockStorage);
    mockStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };

    act(() => {
      result.current[1]({ fontSize: 20 });
    });

    // State should still update even if persist fails
    expect(result.current[0].fontSize).toBe(20);

    mockStorage.setItem = original;
  });
});

describe("getThemePreset", () => {
  it("returns matching preset for all known theme names", () => {
    for (const preset of THEME_PRESETS) {
      expect(getThemePreset(preset.name)).toBe(preset);
    }
  });
});

describe("FONT_FAMILIES", () => {
  it("all font families have non-empty value and label", () => {
    for (const font of FONT_FAMILIES) {
      expect(font.value.length).toBeGreaterThan(0);
      expect(font.label.length).toBeGreaterThan(0);
    }
  });
});
