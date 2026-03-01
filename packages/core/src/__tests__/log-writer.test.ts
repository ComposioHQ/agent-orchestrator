import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { LogEntry } from "../types.js";
import { LogWriter } from "../log-writer.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `ao-test-log-writer-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: "2026-01-15T12:00:00.000Z",
    level: "info",
    source: "cli",
    sessionId: null,
    message: "test message",
    ...overrides,
  };
}

describe("append", () => {
  it("writes valid JSONL lines", () => {
    const filePath = join(testDir, "test.jsonl");
    const writer = new LogWriter({ filePath });

    const entry = makeEntry({ message: "hello world" });
    writer.append(entry);

    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed).toEqual(entry);
  });

  it("each line is valid JSON", () => {
    const filePath = join(testDir, "test.jsonl");
    const writer = new LogWriter({ filePath });

    const entry1 = makeEntry({ message: "first" });
    const entry2 = makeEntry({ message: "second", level: "error", sessionId: "sess-1" });
    writer.append(entry1);
    writer.append(entry2);

    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(entry1);
    expect(JSON.parse(lines[1])).toEqual(entry2);
  });

  it("preserves optional data field", () => {
    const filePath = join(testDir, "test.jsonl");
    const writer = new LogWriter({ filePath });

    const entry = makeEntry({
      message: "with data",
      data: { exitCode: 1, pid: 12345 },
    });
    writer.append(entry);

    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.data).toEqual({ exitCode: 1, pid: 12345 });
  });
});

describe("appendLine", () => {
  it("creates a proper LogEntry with all fields", () => {
    const filePath = join(testDir, "test.jsonl");
    const writer = new LogWriter({ filePath });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-19T10:30:00.000Z"));

    writer.appendLine("something happened", "warn", "dashboard", "sess-42");

    vi.useRealTimers();

    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.ts).toBe("2026-02-19T10:30:00.000Z");
    expect(parsed.level).toBe("warn");
    expect(parsed.source).toBe("dashboard");
    expect(parsed.sessionId).toBe("sess-42");
    expect(parsed.message).toBe("something happened");
  });

  it("defaults sessionId to null when omitted", () => {
    const filePath = join(testDir, "test.jsonl");
    const writer = new LogWriter({ filePath });

    writer.appendLine("no session", "info", "lifecycle");

    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.sessionId).toBeNull();
  });
});

describe("multiple appends", () => {
  it("creates one line per entry", () => {
    const filePath = join(testDir, "test.jsonl");
    const writer = new LogWriter({ filePath });

    for (let i = 0; i < 5; i++) {
      writer.append(makeEntry({ message: `line ${i}` }));
    }

    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(5);

    lines.forEach((line, i) => {
      const parsed = JSON.parse(line);
      expect(parsed.message).toBe(`line ${i}`);
    });
  });
});

describe("close", () => {
  it("prevents further writes after close", () => {
    const filePath = join(testDir, "test.jsonl");
    const writer = new LogWriter({ filePath });

    writer.append(makeEntry({ message: "before close" }));
    writer.close();
    writer.append(makeEntry({ message: "after close" }));

    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).message).toBe("before close");
  });

  it("appendLine is also blocked after close", () => {
    const filePath = join(testDir, "test.jsonl");
    const writer = new LogWriter({ filePath });

    writer.appendLine("before", "info", "cli");
    writer.close();
    writer.appendLine("after", "info", "cli");

    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});

describe("rotation", () => {
  it("rotates file to .1.jsonl when maxSizeBytes exceeded", () => {
    const filePath = join(testDir, "app.jsonl");
    const writer = new LogWriter({ filePath, maxSizeBytes: 100, maxBackups: 2 });

    // Write enough data to exceed 100 bytes
    const longEntry = makeEntry({ message: "A".repeat(80) });
    writer.append(longEntry);

    // File should exist and be over 100 bytes now
    expect(existsSync(filePath)).toBe(true);
    const sizeAfterFirst = readFileSync(filePath, "utf-8").length;
    expect(sizeAfterFirst).toBeGreaterThan(100);

    // Next append triggers rotation
    const smallEntry = makeEntry({ message: "after rotation" });
    writer.append(smallEntry);

    // Original file should now contain only the new entry
    const currentContent = readFileSync(filePath, "utf-8").trim();
    const currentParsed = JSON.parse(currentContent);
    expect(currentParsed.message).toBe("after rotation");

    // Rotated file should contain the old entry
    const rotatedPath = join(testDir, "app.1.jsonl");
    expect(existsSync(rotatedPath)).toBe(true);
    const rotatedContent = readFileSync(rotatedPath, "utf-8").trim();
    const rotatedParsed = JSON.parse(rotatedContent);
    expect(rotatedParsed.message).toBe("A".repeat(80));
  });

  it("shifts existing backups on rotation", () => {
    const filePath = join(testDir, "app.jsonl");
    const writer = new LogWriter({ filePath, maxSizeBytes: 100, maxBackups: 3 });

    // Write first batch -> exceeds limit
    writer.append(makeEntry({ message: "batch-1-" + "X".repeat(80) }));
    // Trigger rotation with second append
    writer.append(makeEntry({ message: "batch-2-" + "Y".repeat(80) }));
    // batch-1 is now in .1.jsonl, batch-2 is in app.jsonl
    // Trigger another rotation
    writer.append(makeEntry({ message: "batch-3" }));
    // batch-1 -> .2.jsonl, batch-2 -> .1.jsonl, batch-3 -> app.jsonl

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(join(testDir, "app.1.jsonl"))).toBe(true);
    expect(existsSync(join(testDir, "app.2.jsonl"))).toBe(true);

    const current = JSON.parse(readFileSync(filePath, "utf-8").trim());
    expect(current.message).toBe("batch-3");

    const backup1 = JSON.parse(readFileSync(join(testDir, "app.1.jsonl"), "utf-8").trim());
    expect(backup1.message).toContain("batch-2-");

    const backup2 = JSON.parse(readFileSync(join(testDir, "app.2.jsonl"), "utf-8").trim());
    expect(backup2.message).toContain("batch-1-");
  });

  it("deletes oldest backup when maxBackups exceeded", () => {
    const filePath = join(testDir, "app.jsonl");
    const writer = new LogWriter({ filePath, maxSizeBytes: 100, maxBackups: 2 });

    // Rotation 1: batch-1 -> .1.jsonl
    writer.append(makeEntry({ message: "batch-1-" + "A".repeat(80) }));
    writer.append(makeEntry({ message: "batch-2-" + "B".repeat(80) }));
    // Now: app.jsonl=batch-2, app.1.jsonl=batch-1

    // Rotation 2: batch-1 -> .2.jsonl, batch-2 -> .1.jsonl
    writer.append(makeEntry({ message: "batch-3-" + "C".repeat(80) }));
    // Now: app.jsonl=batch-3, app.1.jsonl=batch-2, app.2.jsonl=batch-1

    // Rotation 3: .2 is deleted (maxBackups=2), batch-2 -> .2, batch-3 -> .1
    writer.append(makeEntry({ message: "batch-4" }));
    // Now: app.jsonl=batch-4, app.1.jsonl=batch-3, app.2.jsonl=batch-2
    // batch-1 should be gone

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(join(testDir, "app.1.jsonl"))).toBe(true);
    expect(existsSync(join(testDir, "app.2.jsonl"))).toBe(true);

    // Verify batch-1 is gone — none of the remaining files should contain it
    const currentMsg = JSON.parse(readFileSync(filePath, "utf-8").trim()).message;
    const backup1Msg = JSON.parse(
      readFileSync(join(testDir, "app.1.jsonl"), "utf-8").trim(),
    ).message;
    const backup2Msg = JSON.parse(
      readFileSync(join(testDir, "app.2.jsonl"), "utf-8").trim(),
    ).message;

    expect(currentMsg).toBe("batch-4");
    expect(backup1Msg).toContain("batch-3-");
    expect(backup2Msg).toContain("batch-2-");
    // batch-1 content should not appear in any file
    expect(currentMsg).not.toContain("batch-1-");
    expect(backup1Msg).not.toContain("batch-1-");
    expect(backup2Msg).not.toContain("batch-1-");
  });
});

describe("auto-create directory", () => {
  it("creates parent directories if they do not exist", () => {
    const nestedDir = join(testDir, "a", "b", "c");
    const filePath = join(nestedDir, "test.jsonl");

    expect(existsSync(nestedDir)).toBe(false);

    const writer = new LogWriter({ filePath });
    writer.append(makeEntry({ message: "in nested dir" }));

    expect(existsSync(nestedDir)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.message).toBe("in nested dir");
  });
});

describe("write failure", () => {
  it("does not throw on write failure", () => {
    // Create a read-only directory so writes fail
    const readOnlyDir = join(testDir, "readonly");
    mkdirSync(readOnlyDir, { recursive: true });
    const filePath = join(readOnlyDir, "test.jsonl");

    const writer = new LogWriter({ filePath });

    // Make directory read-only after construction (so mkdirSync in constructor succeeds)
    chmodSync(readOnlyDir, 0o444);

    expect(() => {
      writer.append(makeEntry({ message: "should not throw" }));
    }).not.toThrow();

    // Restore permissions for cleanup
    chmodSync(readOnlyDir, 0o755);
  });
});
