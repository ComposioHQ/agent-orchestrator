import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatDuration,
  isRetryableHttpStatus,
  normalizeRetryConfig,
  readLastJsonlEntry,
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

describe("formatDuration", () => {
  it("formats milliseconds for durations under 1 second", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(1)).toBe("1ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("rounds milliseconds to nearest integer", () => {
    expect(formatDuration(500.4)).toBe("500ms");
    expect(formatDuration(500.6)).toBe("501ms");
  });

  it("formats seconds for durations under 1 minute", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(45000)).toBe("45s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("formats minutes and seconds for durations under 1 hour", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(5 * 60000 + 10000)).toBe("5m 10s");
    expect(formatDuration(59 * 60000 + 59000)).toBe("59m 59s");
  });

  it("formats hours and minutes for durations under 1 day", () => {
    expect(formatDuration(60 * 60000)).toBe("1h");
    expect(formatDuration(2 * 60 * 60000 + 30 * 60000)).toBe("2h 30m");
    expect(formatDuration(23 * 60 * 60000 + 59 * 60000)).toBe("23h 59m");
  });

  it("formats days and hours for longer durations", () => {
    expect(formatDuration(24 * 60 * 60000)).toBe("1d");
    expect(formatDuration(24 * 60 * 60000 + 3 * 60 * 60000)).toBe("1d 3h");
    expect(formatDuration(7 * 24 * 60 * 60000 + 12 * 60 * 60000)).toBe("7d 12h");
  });

  it("omits zero units in the second position", () => {
    expect(formatDuration(2 * 60 * 60000)).toBe("2h");
    expect(formatDuration(5 * 60000)).toBe("5m");
    expect(formatDuration(2 * 24 * 60 * 60000)).toBe("2d");
  });

  it("handles negative values", () => {
    expect(formatDuration(-1)).toBe("0ms");
    expect(formatDuration(-1000)).toBe("0ms");
  });
});
