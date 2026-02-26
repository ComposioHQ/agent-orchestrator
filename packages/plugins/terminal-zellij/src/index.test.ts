import { describe, it, expect } from "vitest";
import { manifest, create } from "./index.js";

describe("terminal-zellij", () => {
  it("has manifest metadata", () => {
    expect(manifest.name).toBe("zellij");
    expect(manifest.slot).toBe("terminal");
  });

  it("creates terminal", () => {
    const terminal = create();
    expect(terminal.name).toBe("zellij");
  });
});
