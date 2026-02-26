import { describe, it, expect } from "vitest";
import { manifest, create } from "./index.js";

describe("runtime-docker", () => {
  it("has manifest metadata", () => {
    expect(manifest.name).toBe("docker");
    expect(manifest.slot).toBe("runtime");
  });

  it("creates runtime", () => {
    const runtime = create();
    expect(runtime.name).toBe("docker");
  });
});
