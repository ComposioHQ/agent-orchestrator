import { describe, it, expect } from "vitest";
import { manifest, create } from "./index.js";

describe("scm-gitlab", () => {
  it("has manifest metadata", () => {
    expect(manifest.name).toBe("gitlab");
    expect(manifest.slot).toBe("scm");
  });

  it("creates scm plugin", () => {
    const scm = create();
    expect(scm.name).toBe("gitlab");
  });
});
