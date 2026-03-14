import { describe, expect, it } from "vitest";
import { normalizeBasePath } from "../base-path.js";

describe("normalizeBasePath", () => {
  it("returns an empty string for empty input", () => {
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath(null)).toBe("");
  });

  it("normalizes valid base paths", () => {
    expect(normalizeBasePath("ao")).toBe("/ao");
    expect(normalizeBasePath("/ao")).toBe("/ao");
    expect(normalizeBasePath("/ao/")).toBe("/ao");
    expect(normalizeBasePath("  /ao/  ")).toBe("/ao");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeBasePath("   ")).toBe("");
  });

  it("rejects slash-only input", () => {
    expect(() => normalizeBasePath("/")).toThrow(/NEXT_PUBLIC_BASE_PATH/);
    expect(() => normalizeBasePath("///")).toThrow(/NEXT_PUBLIC_BASE_PATH/);
    expect(() => normalizeBasePath("  //  ")).toThrow(/NEXT_PUBLIC_BASE_PATH/);
  });
});
