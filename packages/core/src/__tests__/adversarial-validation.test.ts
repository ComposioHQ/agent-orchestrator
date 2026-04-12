import { describe, it, expect } from "vitest";
import type { SessionStatus } from "../types.js";

describe("Adversarial Validation — Types", () => {
  it("SessionStatus includes planning and reviewing", () => {
    const planning: SessionStatus = "planning";
    const reviewing: SessionStatus = "reviewing";
    expect(planning).toBe("planning");
    expect(reviewing).toBe("reviewing");
  });
});
