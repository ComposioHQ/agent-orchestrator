import { describe, it, expect } from "vitest";
import { safeJsonParse, validateStatus } from "../utils/validation.js";

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("returns null for invalid JSON (catch branch line 32)", () => {
    expect(safeJsonParse("not valid json")).toBeNull();
  });

  it("parses arrays", () => {
    expect(safeJsonParse("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("returns null for empty string", () => {
    expect(safeJsonParse("")).toBeNull();
  });
});

describe("validateStatus", () => {
  it("returns 'spawning' for undefined", () => {
    expect(validateStatus(undefined)).toBe("spawning");
  });

  it("returns 'working' for 'starting'", () => {
    expect(validateStatus("starting")).toBe("working");
  });

  it("returns the status for valid statuses", () => {
    expect(validateStatus("working")).toBe("working");
    expect(validateStatus("pr_open")).toBe("pr_open");
    expect(validateStatus("merged")).toBe("merged");
    expect(validateStatus("killed")).toBe("killed");
  });

  it("returns 'spawning' for invalid status string", () => {
    expect(validateStatus("invalid")).toBe("spawning");
  });

  it("returns 'spawning' for empty string", () => {
    expect(validateStatus("")).toBe("spawning");
  });
});
