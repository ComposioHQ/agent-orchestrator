import { describe, it, expect } from "vitest";
import { parsePauseUntil } from "../global-pause.js";

describe("parsePauseUntil", () => {
  it("returns null for undefined input", () => {
    expect(parsePauseUntil(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parsePauseUntil("")).toBeNull();
  });

  it("returns null for invalid date string", () => {
    expect(parsePauseUntil("not-a-date")).toBeNull();
  });

  it("parses valid ISO date string", () => {
    const date = parsePauseUntil("2026-03-31T12:00:00.000Z");
    expect(date).toBeInstanceOf(Date);
    expect(date!.toISOString()).toBe("2026-03-31T12:00:00.000Z");
  });

  it("parses valid date string without time", () => {
    const date = parsePauseUntil("2026-03-31");
    expect(date).toBeInstanceOf(Date);
    expect(date).not.toBeNull();
  });
});
