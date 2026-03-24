import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OrchestratorConfig } from "../types.js";
import {
  isRetryableHttpStatus,
  normalizeRetryConfig,
  readLastJsonlEntry,
  shellEscape,
  escapeAppleScript,
  validateUrl,
  resolveProjectIdForSessionId,
} from "../utils.js";
import { parsePrFromUrl } from "../utils/pr.js";

describe("readLastJsonlEntry", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(content: string): string {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-utils-test-"));
    const filePath = join(tmpDir, "test.jsonl");
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  it("returns null for empty file", async () => {
    const path = setup("");
    expect(await readLastJsonlEntry(path)).toBeNull();
  });

  it("returns null for nonexistent file", async () => {
    expect(await readLastJsonlEntry("/tmp/nonexistent-ao-test.jsonl")).toBeNull();
  });

  it("reads last entry type from single-line JSONL", async () => {
    const path = setup('{"type":"assistant","message":"hello"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastType).toBe("assistant");
  });

  it("reads last entry from multi-line JSONL", async () => {
    const path = setup(
      '{"type":"human","text":"hi"}\n{"type":"assistant","text":"hello"}\n{"type":"result","text":"done"}\n',
    );
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("result");
  });

  it("handles trailing newlines", async () => {
    const path = setup('{"type":"done"}\n\n\n');
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("done");
  });

  it("returns lastType null for entry without type field", async () => {
    const path = setup('{"message":"no type"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastType).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const path = setup("not json at all\n");
    expect(await readLastJsonlEntry(path)).toBeNull();
  });

  it("handles multi-byte UTF-8 characters in JSONL entries", async () => {
    // Create a JSONL entry with multi-byte characters (CJK, emoji)
    const entry = { type: "assistant", text: "日本語テスト 🎉 données résumé" };
    const path = setup(JSON.stringify(entry) + "\n");
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("assistant");
  });

  it("handles multi-byte UTF-8 at chunk boundaries", async () => {
    // Create content larger than the 4096 byte chunk size with multi-byte
    // characters that could straddle a boundary. Each 🎉 is 4 bytes.
    const padding = '{"type":"padding","data":"' + "x".repeat(4080) + '"}\n';
    // The emoji-heavy last line will be at a chunk boundary
    const lastLine = { type: "final", text: "🎉".repeat(100) };
    const path = setup(padding + JSON.stringify(lastLine) + "\n");
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("final");
  });

  it("returns modifiedAt as a Date", async () => {
    const path = setup('{"type":"test"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result!.modifiedAt).toBeInstanceOf(Date);
  });
});

describe("retry utilities", () => {
  it("marks 429 and 5xx statuses as retryable", () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
  });

  it("marks 4xx statuses (except 429) as non-retryable", () => {
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });

  it("normalizes retry config with defaults", () => {
    expect(normalizeRetryConfig(undefined)).toEqual({ retries: 2, retryDelayMs: 1000 });
  });

  it("normalizes retry config values and clamps invalid input", () => {
    expect(normalizeRetryConfig({ retries: 4, retryDelayMs: 250 })).toEqual({
      retries: 4,
      retryDelayMs: 250,
    });
    expect(normalizeRetryConfig({ retries: -1, retryDelayMs: -50 })).toEqual({
      retries: 0,
      retryDelayMs: 1000,
    });
  });
});

describe("parsePrFromUrl", () => {
  it("parses GitHub PR URLs", () => {
    expect(parsePrFromUrl("https://github.com/foo/bar/pull/123")).toEqual({
      owner: "foo",
      repo: "bar",
      number: 123,
      url: "https://github.com/foo/bar/pull/123",
    });
  });

  it("falls back to trailing number for non-GitHub URLs", () => {
    expect(parsePrFromUrl("https://gitlab.com/foo/bar/-/merge_requests/456")).toEqual({
      owner: "",
      repo: "",
      number: 456,
      url: "https://gitlab.com/foo/bar/-/merge_requests/456",
    });
  });

  it("returns null when the URL has no PR number", () => {
    expect(parsePrFromUrl("https://example.com/foo/bar/pull/not-a-number")).toBeNull();
  });
});

describe("shellEscape", () => {
  it("wraps simple strings in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
    expect(shellEscape("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
    expect(shellEscape("don't")).toBe("'don'\\''t'");
  });

  it("handles multiple single quotes", () => {
    expect(shellEscape("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("handles strings with special characters", () => {
    expect(shellEscape("hello$world")).toBe("'hello$world'");
    expect(shellEscape("cmd;ls")).toBe("'cmd;ls'");
    expect(shellEscape('echo "test"')).toBe("'echo \"test\"'");
  });
});

describe("escapeAppleScript", () => {
  it("escapes backslashes", () => {
    expect(escapeAppleScript("C:\\Users\\test")).toBe("C:\\\\Users\\\\test");
    expect(escapeAppleScript("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("escapes double quotes", () => {
    expect(escapeAppleScript('say "hello"')).toBe('say \\"hello\\"');
    expect(escapeAppleScript('"quoted"')).toBe('\\"quoted\\"');
  });

  it("escapes both backslashes and double quotes", () => {
    expect(escapeAppleScript('C:\\Users\\test "name"')).toBe(
      'C:\\\\Users\\\\test \\"name\\"',
    );
  });

  it("handles strings with no special characters", () => {
    expect(escapeAppleScript("hello world")).toBe("hello world");
    expect(escapeAppleScript("test")).toBe("test");
  });

  it("handles empty string", () => {
    expect(escapeAppleScript("")).toBe("");
  });
});

describe("validateUrl", () => {
  it("accepts https URLs", () => {
    expect(() => validateUrl("https://example.com", "TestPlugin")).not.toThrow();
    expect(() => validateUrl("https://api.example.com/v1", "API")).not.toThrow();
  });

  it("accepts http URLs", () => {
    expect(() => validateUrl("http://localhost:8080", "Local")).not.toThrow();
    expect(() => validateUrl("http://example.com", "Test")).not.toThrow();
  });

  it("rejects non-http URLs", () => {
    expect(() => validateUrl("ftp://example.com", "Test")).toThrow(
      "[Test] Invalid url: must be http(s), got \"ftp://example.com\"",
    );
    expect(() => validateUrl("file:///path/to/file", "Test")).toThrow(
      "[Test] Invalid url: must be http(s), got \"file:///path/to/file\"",
    );
  });

  it("rejects URLs without protocol", () => {
    expect(() => validateUrl("example.com", "Test")).toThrow(
      "[Test] Invalid url: must be http(s), got \"example.com\"",
    );
    expect(() => validateUrl("//example.com", "Test")).toThrow(
      "[Test] Invalid url: must be http(s), got \"//example.com\"",
    );
  });

  it("includes plugin label in error message", () => {
    expect(() => validateUrl("invalid", "MyPlugin")).toThrow(
      "[MyPlugin] Invalid url: must be http(s), got \"invalid\"",
    );
  });
});

describe("resolveProjectIdForSessionId", () => {
  it("returns project ID when session ID matches prefix", () => {
    const config = {
      projects: {
        proj1: { sessionPrefix: "foo" },
        proj2: { sessionPrefix: "bar" },
      },
    } as unknown as OrchestratorConfig;
    expect(resolveProjectIdForSessionId(config, "foo")).toBe("proj1");
    expect(resolveProjectIdForSessionId(config, "bar")).toBe("proj2");
  });

  it("returns project ID when session ID starts with prefix and hyphen", () => {
    const config = {
      projects: {
        proj1: { sessionPrefix: "foo" },
        proj2: { sessionPrefix: "bar" },
      },
    } as unknown as OrchestratorConfig;
    expect(resolveProjectIdForSessionId(config, "foo-123")).toBe("proj1");
    expect(resolveProjectIdForSessionId(config, "bar-456")).toBe("proj2");
  });

  it("returns undefined when no prefix matches", () => {
    const config = {
      projects: {
        proj1: { sessionPrefix: "foo" },
        proj2: { sessionPrefix: "bar" },
      },
    } as unknown as OrchestratorConfig;
    expect(resolveProjectIdForSessionId(config, "baz")).toBeUndefined();
    expect(resolveProjectIdForSessionId(config, "baz-123")).toBeUndefined();
  });

  it("handles session ID that is prefix without hyphen as direct match", () => {
    const config = {
      projects: {
        proj1: { sessionPrefix: "test" },
      },
    } as unknown as OrchestratorConfig;
    expect(resolveProjectIdForSessionId(config, "test")).toBe("proj1");
  });

  it("returns undefined when projects config is empty", () => {
    const config = { projects: {} } as unknown as OrchestratorConfig;
    expect(resolveProjectIdForSessionId(config, "test-123")).toBeUndefined();
  });

  it("handles case where session ID starts with prefix but no hyphen", () => {
    const config = {
      projects: {
        proj1: { sessionPrefix: "foo" },
      },
    } as unknown as OrchestratorConfig;
    // "foobar" starts with "foo" but doesn't have hyphen, should NOT match
    expect(resolveProjectIdForSessionId(config, "foobar")).toBeUndefined();
    expect(resolveProjectIdForSessionId(config, "foo-xyz")).toBe("proj1");
  });
});
