import { describe, it, expect } from "vitest";
import { parsePauseUntil } from "../global-pause.js";

describe("parsePauseUntil", () => {
  it("parses a valid ISO date string", () => {
    const result = parsePauseUntil("2024-06-01T12:00:00Z");
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe("2024-06-01T12:00:00.000Z");
  });

  it("returns null for undefined", () => {
    expect(parsePauseUntil(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parsePauseUntil("")).toBeNull();
  });

  it("returns null for invalid date string", () => {
    expect(parsePauseUntil("not-a-date")).toBeNull();
  });
});
