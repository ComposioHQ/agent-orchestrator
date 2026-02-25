import { describe, it, expect } from "vitest";
import { manifest, create } from "./index.js";

describe("terminal-wezterm", () => {
  it("has manifest metadata", () => {
    expect(manifest.name).toBe("wezterm");
    expect(manifest.slot).toBe("terminal");
  });

  it("creates terminal instance", () => {
    const terminal = create();
    expect(terminal.name).toBe("wezterm");
  });
});
