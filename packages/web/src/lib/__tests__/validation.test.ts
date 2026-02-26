import { describe, it, expect } from "vitest";
import { validateString, validateIdentifier, stripControlChars } from "../validation.js";

// =============================================================================
// validateString
// =============================================================================

describe("validateString", () => {
  it("returns null for a valid non-empty string within length", () => {
    expect(validateString("hello", "name", 100)).toBeNull();
  });

  it("returns error when value is undefined", () => {
    expect(validateString(undefined, "name", 100)).toBe("name is required");
  });

  it("returns error when value is null", () => {
    expect(validateString(null, "name", 100)).toBe("name is required");
  });

  it("returns error when value is not a string", () => {
    expect(validateString(42, "age", 100)).toBe("age must be a string");
    expect(validateString(true, "flag", 100)).toBe("flag must be a string");
    expect(validateString({}, "obj", 100)).toBe("obj must be a string");
    expect(validateString([], "arr", 100)).toBe("arr must be a string");
  });

  it("returns error when value is empty string", () => {
    expect(validateString("", "name", 100)).toBe("name must not be empty");
  });

  it("returns error when value is only whitespace", () => {
    expect(validateString("   ", "name", 100)).toBe("name must not be empty");
    expect(validateString("\t\n", "name", 100)).toBe("name must not be empty");
  });

  it("returns error when value exceeds max length", () => {
    const long = "a".repeat(129);
    expect(validateString(long, "name", 128)).toBe("name must be at most 128 characters");
  });

  it("allows string exactly at max length", () => {
    const exact = "a".repeat(128);
    expect(validateString(exact, "name", 128)).toBeNull();
  });

  it("uses field name in error messages", () => {
    expect(validateString(null, "projectId", 100)).toBe("projectId is required");
    expect(validateString(42, "sessionId", 100)).toBe("sessionId must be a string");
  });
});

// =============================================================================
// validateIdentifier
// =============================================================================

describe("validateIdentifier", () => {
  it("returns null for valid identifiers", () => {
    expect(validateIdentifier("my-app", "id")).toBeNull();
    expect(validateIdentifier("my_app", "id")).toBeNull();
    expect(validateIdentifier("myApp123", "id")).toBeNull();
    expect(validateIdentifier("APP-1", "id")).toBeNull();
    expect(validateIdentifier("a", "id")).toBeNull();
  });

  it("returns error for strings that fail validateString", () => {
    expect(validateIdentifier(null, "id")).toBe("id is required");
    expect(validateIdentifier("", "id")).toBe("id must not be empty");
    expect(validateIdentifier(42, "id")).toBe("id must be a string");
  });

  it("returns error for identifiers with invalid characters", () => {
    expect(validateIdentifier("my app", "id")).toBe("id must match [a-zA-Z0-9_-]+");
    expect(validateIdentifier("my.app", "id")).toBe("id must match [a-zA-Z0-9_-]+");
    expect(validateIdentifier("my/app", "id")).toBe("id must match [a-zA-Z0-9_-]+");
    expect(validateIdentifier("my@app", "id")).toBe("id must match [a-zA-Z0-9_-]+");
    expect(validateIdentifier("app!", "id")).toBe("id must match [a-zA-Z0-9_-]+");
    expect(validateIdentifier("app#1", "id")).toBe("id must match [a-zA-Z0-9_-]+");
  });

  it("uses default max length of 128", () => {
    const long = "a".repeat(129);
    expect(validateIdentifier(long, "id")).toBe("id must be at most 128 characters");
  });

  it("accepts custom max length", () => {
    const long = "a".repeat(11);
    expect(validateIdentifier(long, "id", 10)).toBe("id must be at most 10 characters");
    expect(validateIdentifier("a".repeat(10), "id", 10)).toBeNull();
  });
});

// =============================================================================
// stripControlChars
// =============================================================================

describe("stripControlChars", () => {
  it("returns unchanged string when no control chars present", () => {
    expect(stripControlChars("hello world")).toBe("hello world");
    expect(stripControlChars("Hello, World! 123")).toBe("Hello, World! 123");
  });

  it("strips null bytes", () => {
    expect(stripControlChars("hello\x00world")).toBe("helloworld");
  });

  it("strips tab and newline characters", () => {
    expect(stripControlChars("hello\tworld")).toBe("helloworld");
    expect(stripControlChars("hello\nworld")).toBe("helloworld");
    expect(stripControlChars("hello\rworld")).toBe("helloworld");
  });

  it("strips escape sequences", () => {
    expect(stripControlChars("hello\x1bworld")).toBe("helloworld");
    expect(stripControlChars("\x1b[31mred\x1b[0m")).toBe("[31mred[0m");
  });

  it("strips DEL character (0x7F)", () => {
    expect(stripControlChars("hello\x7fworld")).toBe("helloworld");
  });

  it("strips C1 control characters (0x80-0x9F)", () => {
    expect(stripControlChars("hello\x80world")).toBe("helloworld");
    expect(stripControlChars("hello\x9fworld")).toBe("helloworld");
  });

  it("preserves space (0x20) and printable ASCII", () => {
    expect(stripControlChars(" !\"#$%&'()*+,-./0123456789")).toBe(
      " !\"#$%&'()*+,-./0123456789",
    );
  });

  it("preserves unicode characters above 0x9F", () => {
    expect(stripControlChars("hello café")).toBe("hello café");
    expect(stripControlChars("emoji 🎉")).toBe("emoji 🎉");
  });

  it("handles empty string", () => {
    expect(stripControlChars("")).toBe("");
  });

  it("strips all control chars from a fully-controlled string", () => {
    // A string of only control characters
    expect(stripControlChars("\x00\x01\x02\x1f")).toBe("");
  });

  it("handles mixed control and printable", () => {
    expect(stripControlChars("a\x00b\x01c\x02d")).toBe("abcd");
  });
});
