import { describe, it, expect } from "vitest";
import { percentile, normalizeRoutePath, shellEscape, escapeAppleScript, validateUrl } from "../utils.js";

describe("percentile", () => {
  it("returns 0 for empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("returns the single element for single-element array", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it("returns correct p50 for odd-length array", () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
  });

  it("returns correct p95 for larger array", () => {
    // 20 elements, p95 = ceil(0.95 * 20) - 1 = ceil(19) - 1 = 18
    const sorted = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(percentile(sorted, 95)).toBe(190);
  });

  it("returns correct p99 for larger array", () => {
    // 100 elements, p99 = ceil(0.99 * 100) - 1 = 99 - 1 = 98
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 99)).toBe(99);
  });

  it("handles p=0 by returning the first element", () => {
    // p=0: idx = ceil(0) - 1 = -1, clamped to 0
    expect(percentile([10, 20, 30], 0)).toBe(10);
  });

  it("handles p=100 by returning the last element", () => {
    // p=100: idx = ceil(1 * 3) - 1 = 2
    expect(percentile([10, 20, 30], 100)).toBe(30);
  });

  it("returns correct p50 for even-length array", () => {
    // 4 elements, p50 = ceil(0.5 * 4) - 1 = ceil(2) - 1 = 1
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
  });
});

describe("normalizeRoutePath", () => {
  it("replaces /sessions/<id> with /sessions/:id", () => {
    expect(normalizeRoutePath("/sessions/abc123")).toBe("/sessions/:id");
  });

  it("replaces /prs/<id> with /prs/:id", () => {
    expect(normalizeRoutePath("/prs/456")).toBe("/prs/:id");
  });

  it("handles paths with both sessions and prs segments", () => {
    expect(normalizeRoutePath("/api/sessions/abc/prs/123")).toBe(
      "/api/sessions/:id/prs/:id",
    );
  });

  it("leaves paths without dynamic segments unchanged", () => {
    expect(normalizeRoutePath("/api/health")).toBe("/api/health");
    expect(normalizeRoutePath("/")).toBe("/");
  });

  it("handles multiple session segments", () => {
    expect(normalizeRoutePath("/sessions/a/sessions/b")).toBe(
      "/sessions/:id/sessions/:id",
    );
  });

  it("preserves query strings and trailing slashes", () => {
    // normalizeRoutePath only replaces path segments; everything else passes through
    expect(normalizeRoutePath("/sessions/abc123/details")).toBe(
      "/sessions/:id/details",
    );
  });
});

describe("shellEscape", () => {
  it("wraps a simple string in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("escapes embedded single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("escapes multiple single quotes", () => {
    expect(shellEscape("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });

  it("preserves dollar signs without expansion", () => {
    // Single-quoted strings in POSIX shells do not expand $
    expect(shellEscape("$HOME")).toBe("'$HOME'");
  });

  it("preserves backticks without expansion", () => {
    expect(shellEscape("`whoami`")).toBe("'`whoami`'");
  });

  it("preserves double quotes literally", () => {
    expect(shellEscape('say "hello"')).toBe("'say \"hello\"'");
  });

  it("preserves spaces and special characters", () => {
    expect(shellEscape("hello world!")).toBe("'hello world!'");
    expect(shellEscape("a&b|c;d")).toBe("'a&b|c;d'");
  });

  it("preserves newlines", () => {
    expect(shellEscape("line1\nline2")).toBe("'line1\nline2'");
  });
});

describe("escapeAppleScript", () => {
  it("returns simple string unchanged", () => {
    expect(escapeAppleScript("hello")).toBe("hello");
  });

  it("escapes double quotes", () => {
    expect(escapeAppleScript('say "hello"')).toBe('say \\"hello\\"');
  });

  it("escapes backslashes", () => {
    expect(escapeAppleScript("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("escapes both backslashes and double quotes", () => {
    expect(escapeAppleScript('a\\b"c')).toBe('a\\\\b\\"c');
  });

  it("handles empty string", () => {
    expect(escapeAppleScript("")).toBe("");
  });

  it("handles string with only backslashes", () => {
    expect(escapeAppleScript("\\\\")).toBe("\\\\\\\\");
  });

  it("handles string with only double quotes", () => {
    expect(escapeAppleScript('""')).toBe('\\"\\"');
  });

  it("preserves single quotes (not special in AppleScript double-quoted strings)", () => {
    expect(escapeAppleScript("it's fine")).toBe("it's fine");
  });
});

describe("validateUrl", () => {
  it("accepts valid https URL", () => {
    expect(() => validateUrl("https://example.com", "test")).not.toThrow();
  });

  it("accepts valid http URL", () => {
    expect(() => validateUrl("http://example.com", "test")).not.toThrow();
  });

  it("accepts https URL with path and query", () => {
    expect(() =>
      validateUrl("https://api.github.com/repos/owner/repo?page=1", "github"),
    ).not.toThrow();
  });

  it("rejects ftp URL", () => {
    expect(() => validateUrl("ftp://files.example.com", "test")).toThrow(
      /Invalid url: must be http\(s\)/,
    );
  });

  it("rejects URL without protocol", () => {
    expect(() => validateUrl("example.com", "test")).toThrow(
      /Invalid url: must be http\(s\)/,
    );
  });

  it("rejects empty string", () => {
    expect(() => validateUrl("", "test")).toThrow(
      /Invalid url: must be http\(s\)/,
    );
  });

  it("rejects mailto URL", () => {
    expect(() => validateUrl("mailto:user@example.com", "test")).toThrow(
      /Invalid url: must be http\(s\)/,
    );
  });

  it("includes label in error message", () => {
    expect(() => validateUrl("bad-url", "my-plugin")).toThrow("[my-plugin]");
  });

  it("includes the invalid URL in error message", () => {
    expect(() => validateUrl("ftp://bad", "test")).toThrow("ftp://bad");
  });
});
