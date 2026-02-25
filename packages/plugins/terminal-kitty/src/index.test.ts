import { describe, it, expect } from "vitest";
import { manifest, create } from "./index.js";

describe("terminal-kitty", () => {
  it("has manifest metadata", () => {
    expect(manifest.name).toBe("kitty");
    expect(manifest.slot).toBe("terminal");
  });

  it("creates terminal instance", () => {
    const terminal = create();
    expect(terminal.name).toBe("kitty");
  });
});
