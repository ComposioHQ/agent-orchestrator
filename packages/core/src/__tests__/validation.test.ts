import { describe, it, expect } from "vitest";
import { safeJsonParse, validateStatus } from "../utils/validation.js";

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null for invalid JSON", () => {
    expect(safeJsonParse("not json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(safeJsonParse("")).toBeNull();
  });

  it("parses arrays", () => {
    expect(safeJsonParse<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("parses primitive values", () => {
    expect(safeJsonParse<string>('"hello"')).toBe("hello");
    expect(safeJsonParse<number>("42")).toBe(42);
    expect(safeJsonParse<boolean>("true")).toBe(true);
    expect(safeJsonParse<null>("null")).toBeNull();
  });
});

describe("validateStatus", () => {
  it("returns valid statuses as-is", () => {
    expect(validateStatus("working")).toBe("working");
    expect(validateStatus("pr_open")).toBe("pr_open");
    expect(validateStatus("merged")).toBe("merged");
    expect(validateStatus("stuck")).toBe("stuck");
    expect(validateStatus("done")).toBe("done");
  });

  it('normalizes "starting" to "working"', () => {
    expect(validateStatus("starting")).toBe("working");
  });

  it('defaults to "spawning" for undefined', () => {
    expect(validateStatus(undefined)).toBe("spawning");
  });

  it('defaults to "spawning" for unknown status strings', () => {
    expect(validateStatus("invalid")).toBe("spawning");
    expect(validateStatus("")).toBe("spawning");
  });
});
