import { describe, it, expect } from "vitest";
import { manifest, create } from "./index.js";

describe("tracker-jira", () => {
  it("has manifest metadata", () => {
    expect(manifest.name).toBe("jira");
    expect(manifest.slot).toBe("tracker");
  });

  it("creates tracker", () => {
    const tracker = create();
    expect(tracker.name).toBe("jira");
  });
});
