import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  escapeAppleScript,
  isRetryableHttpStatus,
  normalizeRetryConfig,
  readLastJsonlEntry,
  resolveProjectIdForSessionId,
  shellEscape,
  validateUrl,
} from "../utils.js";
import { parsePrFromUrl } from "../utils/pr.js";
import type { OrchestratorConfig } from "../types.js";

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

describe("validateUrl", () => {
  it("accepts https URLs without throwing", () => {
    expect(() => validateUrl("https://example.com", "test")).not.toThrow();
  });

  it("accepts http URLs without throwing", () => {
    expect(() => validateUrl("http://example.com", "test")).not.toThrow();
  });

  it("throws for ftp URLs", () => {
    expect(() => validateUrl("ftp://example.com", "test")).toThrow(
      '[test] Invalid url: must be http(s), got "ftp://example.com"',
    );
  });

  it("throws for URLs without protocol", () => {
    expect(() => validateUrl("example.com", "test-label")).toThrow("[test-label]");
  });

  it("throws for empty string", () => {
    expect(() => validateUrl("", "empty")).toThrow('[empty] Invalid url: must be http(s), got ""');
  });

  it("includes the label in the error message", () => {
    expect(() => validateUrl("ws://socket", "WebSocket")).toThrow("[WebSocket]");
  });

  it("throws for file:// protocol", () => {
    expect(() => validateUrl("file:///etc/passwd", "file")).toThrow("Invalid url");
  });
});

describe("escapeAppleScript", () => {
  it("returns unchanged string when no special characters", () => {
    expect(escapeAppleScript("hello world")).toBe("hello world");
  });

  it("escapes double quotes", () => {
    expect(escapeAppleScript('say "hello"')).toBe('say \\"hello\\"');
  });

  it("escapes backslashes", () => {
    expect(escapeAppleScript("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("escapes both backslashes and double quotes together", () => {
    expect(escapeAppleScript('path\\to\\"file"')).toBe('path\\\\to\\\\\\"file\\"');
  });

  it("handles empty string", () => {
    expect(escapeAppleScript("")).toBe("");
  });

  it("handles string with only backslashes", () => {
    expect(escapeAppleScript("\\\\")).toBe("\\\\\\\\");
  });

  it("handles string with only quotes", () => {
    expect(escapeAppleScript('""')).toBe('\\"\\"');
  });
});

describe("shellEscape", () => {
  it("wraps a simple string in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("wraps strings with spaces", () => {
    expect(shellEscape("hello world")).toBe("'hello world'");
  });

  it("handles strings with special shell characters", () => {
    expect(shellEscape("$HOME")).toBe("'$HOME'");
    expect(shellEscape("foo;bar")).toBe("'foo;bar'");
    expect(shellEscape("a|b")).toBe("'a|b'");
  });

  it("escapes multiple single quotes", () => {
    expect(shellEscape("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });
});

describe("normalizeRetryConfig - additional", () => {
  it("uses custom defaults when provided", () => {
    const result = normalizeRetryConfig(undefined, { retries: 5, retryDelayMs: 2000 });
    expect(result).toEqual({ retries: 5, retryDelayMs: 2000 });
  });

  it("handles NaN retries by falling back to defaults", () => {
    const result = normalizeRetryConfig({ retries: NaN, retryDelayMs: 100 });
    expect(result.retries).toBe(2); // default
    expect(result.retryDelayMs).toBe(100);
  });

  it("handles Infinity retries by falling back to defaults", () => {
    const result = normalizeRetryConfig({ retries: Infinity, retryDelayMs: 100 });
    expect(result.retries).toBe(2); // default
  });

  it("clamps retries of 0 to 0", () => {
    const result = normalizeRetryConfig({ retries: 0 });
    expect(result.retries).toBe(0);
  });

  it("handles retryDelayMs of 0", () => {
    const result = normalizeRetryConfig({ retryDelayMs: 0 });
    expect(result.retryDelayMs).toBe(0);
  });

  it("handles undefined config fields individually", () => {
    const result = normalizeRetryConfig({ retries: 3 });
    expect(result.retries).toBe(3);
    expect(result.retryDelayMs).toBe(1000); // default
  });

  it("handles non-numeric values by falling back to defaults", () => {
    const result = normalizeRetryConfig({ retries: "abc" as unknown, retryDelayMs: "xyz" as unknown });
    expect(result.retries).toBe(2);
    expect(result.retryDelayMs).toBe(1000);
  });
});

describe("resolveProjectIdForSessionId", () => {
  const config: OrchestratorConfig = {
    configPath: "/tmp/test/agent-orchestrator.yaml",
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/tmp/my-app",
        defaultBranch: "main",
        sessionPrefix: "app",
      },
      "web-service": {
        name: "Web Service",
        repo: "org/web",
        path: "/tmp/web",
        defaultBranch: "main",
        sessionPrefix: "web",
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    readyThresholdMs: 300_000,
  };

  it("resolves project ID from session ID with prefix and number", () => {
    expect(resolveProjectIdForSessionId(config, "app-1")).toBe("my-app");
  });

  it("resolves project ID from session ID with prefix and longer suffix", () => {
    expect(resolveProjectIdForSessionId(config, "app-42-extra")).toBe("my-app");
  });

  it("resolves exact prefix match (session ID equals prefix)", () => {
    expect(resolveProjectIdForSessionId(config, "app")).toBe("my-app");
  });

  it("resolves a different project correctly", () => {
    expect(resolveProjectIdForSessionId(config, "web-5")).toBe("web-service");
  });

  it("returns undefined for unknown session prefix", () => {
    expect(resolveProjectIdForSessionId(config, "unknown-1")).toBeUndefined();
  });

  it("returns undefined for empty session ID", () => {
    expect(resolveProjectIdForSessionId(config, "")).toBeUndefined();
  });

  it("does not match partial prefixes", () => {
    // "ap" should NOT match "app" prefix
    expect(resolveProjectIdForSessionId(config, "ap-1")).toBeUndefined();
  });

  it("requires dash separator after prefix", () => {
    // "appx" should not match "app" prefix (no dash separator)
    expect(resolveProjectIdForSessionId(config, "appx")).toBeUndefined();
  });

  it("handles config with no projects", () => {
    const emptyConfig: OrchestratorConfig = {
      ...config,
      projects: {},
    };
    expect(resolveProjectIdForSessionId(emptyConfig, "app-1")).toBeUndefined();
  });
});

describe("isRetryableHttpStatus - additional", () => {
  it("marks 200 as non-retryable", () => {
    expect(isRetryableHttpStatus(200)).toBe(false);
  });

  it("marks 301 as non-retryable", () => {
    expect(isRetryableHttpStatus(301)).toBe(false);
  });

  it("marks 502 as retryable", () => {
    expect(isRetryableHttpStatus(502)).toBe(true);
  });

  it("marks 504 as retryable", () => {
    expect(isRetryableHttpStatus(504)).toBe(true);
  });

  it("marks 499 as non-retryable", () => {
    expect(isRetryableHttpStatus(499)).toBe(false);
  });
});
