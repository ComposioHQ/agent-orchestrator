import { describe, it, expect } from "vitest";
import { manifest, create } from "./index.js";

describe("notifier-email", () => {
  it("has manifest metadata", () => {
    expect(manifest.name).toBe("email");
    expect(manifest.slot).toBe("notifier");
  });

  it("creates notifier", () => {
    const notifier = create();
    expect(notifier.name).toBe("email");
  });
});
