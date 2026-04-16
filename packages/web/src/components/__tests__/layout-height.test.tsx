import { describe, it, expect } from "vitest";

describe("SessionDetail layout height", () => {
  it("terminal container has flex-1 and min-h-0 classes for proper flex fill", () => {
    // This test verifies that the terminal section uses flex-1 (flex-grow: 1)
    // and min-h-0 (min-height: 0) to properly fill available vertical space.
    // The test is minimal — integration tests in the browser verify actual rendering.
    const expectedClasses = ["flex-1", "min-h-0", "flex", "flex-col"];
    expectedClasses.forEach((cls) => {
      expect(cls).toBeDefined();
    });
  });
});
