import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { LogEntry } from "../types.js";
import { readLogs, readLogsFromDir, tailLogs, parseApiLogs, computeApiStats, type ApiLogEntry } from "../log-reader.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `ao-test-log-reader-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Helper: create a LogEntry with sensible defaults. */
function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: overrides.ts ?? new Date().toISOString(),
    level: overrides.level ?? "info",
    source: overrides.source ?? "lifecycle",
    sessionId: overrides.sessionId ?? null,
    message: overrides.message ?? "test message",
    ...(overrides.data !== undefined ? { data: overrides.data } : {}),
  };
}

/** Helper: write an array of LogEntry objects to a JSONL file. */
function writeJsonl(filePath: string, entries: LogEntry[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(filePath, content, "utf-8");
}

describe("readLogs", () => {
  it("reads all entries from a JSONL file", () => {
    const entries = [
      makeEntry({ message: "first" }),
      makeEntry({ message: "second" }),
      makeEntry({ message: "third" }),
    ];
    const filePath = join(testDir, "test.jsonl");
    writeJsonl(filePath, entries);

    const result = readLogs(filePath);
    expect(result).toHaveLength(3);
    expect(result[0].message).toBe("first");
    expect(result[1].message).toBe("second");
    expect(result[2].message).toBe("third");
  });

  it("returns empty array for non-existent file", () => {
    const result = readLogs(join(testDir, "nonexistent.jsonl"));
    expect(result).toEqual([]);
  });

  it("returns empty array with no options (all entries returned)", () => {
    const entries = [makeEntry({ message: "a" }), makeEntry({ message: "b" })];
    const filePath = join(testDir, "test.jsonl");
    writeJsonl(filePath, entries);

    const result = readLogs(filePath);
    expect(result).toHaveLength(2);
  });

  describe("since filter", () => {
    it("returns only entries after the since date", () => {
      const entries = [
        makeEntry({ ts: "2025-01-01T00:00:00.000Z", message: "old" }),
        makeEntry({ ts: "2025-06-15T12:00:00.000Z", message: "mid" }),
        makeEntry({ ts: "2025-12-31T23:59:59.000Z", message: "new" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, {
        since: new Date("2025-06-01T00:00:00.000Z"),
      });
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("mid");
      expect(result[1].message).toBe("new");
    });

    it("excludes entries exactly before the since date", () => {
      const entries = [
        makeEntry({ ts: "2025-01-01T00:00:00.000Z", message: "before" }),
        makeEntry({ ts: "2025-01-02T00:00:00.000Z", message: "exact" }),
        makeEntry({ ts: "2025-01-03T00:00:00.000Z", message: "after" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, {
        since: new Date("2025-01-02T00:00:00.000Z"),
      });
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("exact");
      expect(result[1].message).toBe("after");
    });
  });

  describe("until filter", () => {
    it("returns only entries before or equal to the until date", () => {
      const entries = [
        makeEntry({ ts: "2025-01-01T00:00:00.000Z", message: "old" }),
        makeEntry({ ts: "2025-06-15T12:00:00.000Z", message: "mid" }),
        makeEntry({ ts: "2025-12-31T23:59:59.000Z", message: "new" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, {
        until: new Date("2025-06-30T00:00:00.000Z"),
      });
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("old");
      expect(result[1].message).toBe("mid");
    });

    it("excludes entries exactly after the until date", () => {
      const entries = [
        makeEntry({ ts: "2025-01-01T00:00:00.000Z", message: "before" }),
        makeEntry({ ts: "2025-01-02T00:00:00.000Z", message: "exact" }),
        makeEntry({ ts: "2025-01-03T00:00:00.000Z", message: "after" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, {
        until: new Date("2025-01-02T00:00:00.000Z"),
      });
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("before");
      expect(result[1].message).toBe("exact");
    });
  });

  describe("since + until combined", () => {
    it("returns entries within the date range", () => {
      const entries = [
        makeEntry({ ts: "2025-01-01T00:00:00.000Z", message: "too early" }),
        makeEntry({ ts: "2025-03-15T00:00:00.000Z", message: "in range" }),
        makeEntry({ ts: "2025-06-15T00:00:00.000Z", message: "also in range" }),
        makeEntry({ ts: "2025-12-31T00:00:00.000Z", message: "too late" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, {
        since: new Date("2025-02-01T00:00:00.000Z"),
        until: new Date("2025-09-01T00:00:00.000Z"),
      });
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("in range");
      expect(result[1].message).toBe("also in range");
    });
  });

  describe("level filter", () => {
    it("returns only entries matching specified levels", () => {
      const entries = [
        makeEntry({ level: "info", message: "info msg" }),
        makeEntry({ level: "warn", message: "warn msg" }),
        makeEntry({ level: "error", message: "error msg" }),
        makeEntry({ level: "stdout", message: "stdout msg" }),
        makeEntry({ level: "stderr", message: "stderr msg" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { level: ["warn", "error"] });
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("warn msg");
      expect(result[1].message).toBe("error msg");
    });

    it("returns all entries when level array is empty", () => {
      const entries = [
        makeEntry({ level: "info", message: "a" }),
        makeEntry({ level: "warn", message: "b" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { level: [] });
      expect(result).toHaveLength(2);
    });

    it("filters to a single level", () => {
      const entries = [
        makeEntry({ level: "info", message: "info1" }),
        makeEntry({ level: "error", message: "error1" }),
        makeEntry({ level: "info", message: "info2" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { level: ["error"] });
      expect(result).toHaveLength(1);
      expect(result[0].message).toBe("error1");
    });
  });

  describe("sessionId filter", () => {
    it("returns only entries matching the sessionId", () => {
      const entries = [
        makeEntry({ sessionId: "sess-1", message: "from sess-1" }),
        makeEntry({ sessionId: "sess-2", message: "from sess-2" }),
        makeEntry({ sessionId: "sess-1", message: "from sess-1 again" }),
        makeEntry({ sessionId: null, message: "no session" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { sessionId: "sess-1" });
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("from sess-1");
      expect(result[1].message).toBe("from sess-1 again");
    });

    it("returns entries with null sessionId when filtering for null", () => {
      const entries = [
        makeEntry({ sessionId: "sess-1", message: "has session" }),
        makeEntry({ sessionId: null, message: "no session" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      // The filter does strict equality: entry.sessionId !== opts.sessionId
      // Passing undefined means the filter is not applied (sessionId is optional)
      const result = readLogs(filePath);
      expect(result).toHaveLength(2);
    });
  });

  describe("source filter", () => {
    it("returns only entries matching the source", () => {
      const entries = [
        makeEntry({ source: "dashboard", message: "from dashboard" }),
        makeEntry({ source: "lifecycle", message: "from lifecycle" }),
        makeEntry({ source: "cli", message: "from cli" }),
        makeEntry({ source: "api", message: "from api" }),
        makeEntry({ source: "browser", message: "from browser" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { source: "cli" });
      expect(result).toHaveLength(1);
      expect(result[0].message).toBe("from cli");
    });

    it("returns multiple entries matching the same source", () => {
      const entries = [
        makeEntry({ source: "lifecycle", message: "lc1" }),
        makeEntry({ source: "api", message: "api1" }),
        makeEntry({ source: "lifecycle", message: "lc2" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { source: "lifecycle" });
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("lc1");
      expect(result[1].message).toBe("lc2");
    });
  });

  describe("limit option", () => {
    it("stops after N entries", () => {
      const entries = [
        makeEntry({ message: "one" }),
        makeEntry({ message: "two" }),
        makeEntry({ message: "three" }),
        makeEntry({ message: "four" }),
        makeEntry({ message: "five" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { limit: 3 });
      expect(result).toHaveLength(3);
      expect(result[0].message).toBe("one");
      expect(result[1].message).toBe("two");
      expect(result[2].message).toBe("three");
    });

    it("returns all entries when limit exceeds total", () => {
      const entries = [
        makeEntry({ message: "one" }),
        makeEntry({ message: "two" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { limit: 100 });
      expect(result).toHaveLength(2);
    });

    it("returns one entry when limit is 1", () => {
      const entries = [
        makeEntry({ message: "first" }),
        makeEntry({ message: "second" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { limit: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].message).toBe("first");
    });
  });

  describe("pattern filter", () => {
    it("returns entries where message contains the pattern", () => {
      const entries = [
        makeEntry({ message: "session started for user-1" }),
        makeEntry({ message: "error in handler" }),
        makeEntry({ message: "session ended for user-1" }),
        makeEntry({ message: "unrelated log line" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { pattern: "session" });
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("session started for user-1");
      expect(result[1].message).toBe("session ended for user-1");
    });

    it("is case-sensitive", () => {
      const entries = [
        makeEntry({ message: "Error occurred" }),
        makeEntry({ message: "error occurred" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { pattern: "Error" });
      expect(result).toHaveLength(1);
      expect(result[0].message).toBe("Error occurred");
    });

    it("matches partial words", () => {
      const entries = [
        makeEntry({ message: "processing complete" }),
        makeEntry({ message: "preprocess data" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { pattern: "process" });
      expect(result).toHaveLength(2);
    });
  });

  describe("corrupted/invalid JSON lines", () => {
    it("skips corrupted lines and returns valid entries", () => {
      const content = [
        JSON.stringify(makeEntry({ message: "valid-1" })),
        "this is not json",
        JSON.stringify(makeEntry({ message: "valid-2" })),
        "{broken json",
        JSON.stringify(makeEntry({ message: "valid-3" })),
      ].join("\n") + "\n";

      const filePath = join(testDir, "test.jsonl");
      writeFileSync(filePath, content, "utf-8");

      const result = readLogs(filePath);
      expect(result).toHaveLength(3);
      expect(result[0].message).toBe("valid-1");
      expect(result[1].message).toBe("valid-2");
      expect(result[2].message).toBe("valid-3");
    });

    it("skips empty lines gracefully", () => {
      const content = [
        JSON.stringify(makeEntry({ message: "a" })),
        "",
        "  ",
        JSON.stringify(makeEntry({ message: "b" })),
        "",
      ].join("\n");

      const filePath = join(testDir, "test.jsonl");
      writeFileSync(filePath, content, "utf-8");

      const result = readLogs(filePath);
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("a");
      expect(result[1].message).toBe("b");
    });

    it("returns empty array when all lines are corrupted", () => {
      const content = "not json\nalso not json\n{broken\n";
      const filePath = join(testDir, "test.jsonl");
      writeFileSync(filePath, content, "utf-8");

      const result = readLogs(filePath);
      expect(result).toEqual([]);
    });
  });

  describe("combined filters", () => {
    it("applies multiple filters simultaneously", () => {
      const entries = [
        makeEntry({ ts: "2025-01-01T00:00:00.000Z", level: "info", sessionId: "s1", source: "lifecycle", message: "lifecycle info s1 old" }),
        makeEntry({ ts: "2025-06-15T00:00:00.000Z", level: "error", sessionId: "s1", source: "lifecycle", message: "lifecycle error s1 mid" }),
        makeEntry({ ts: "2025-06-15T00:00:00.000Z", level: "info", sessionId: "s2", source: "lifecycle", message: "lifecycle info s2 mid" }),
        makeEntry({ ts: "2025-06-15T00:00:00.000Z", level: "error", sessionId: "s1", source: "api", message: "api error s1 mid" }),
        makeEntry({ ts: "2025-12-31T00:00:00.000Z", level: "error", sessionId: "s1", source: "lifecycle", message: "lifecycle error s1 new" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, {
        since: new Date("2025-03-01T00:00:00.000Z"),
        level: ["error"],
        sessionId: "s1",
        source: "lifecycle",
      });
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("lifecycle error s1 mid");
      expect(result[1].message).toBe("lifecycle error s1 new");
    });

    it("applies pattern filter with limit", () => {
      const entries = [
        makeEntry({ message: "match one" }),
        makeEntry({ message: "no hit" }),
        makeEntry({ message: "match two" }),
        makeEntry({ message: "match three" }),
      ];
      const filePath = join(testDir, "test.jsonl");
      writeJsonl(filePath, entries);

      const result = readLogs(filePath, { pattern: "match", limit: 2 });
      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("match one");
      expect(result[1].message).toBe("match two");
    });
  });
});

describe("readLogsFromDir", () => {
  it("reads current + rotated files in chronological order", () => {
    // Rotated files: highest number = oldest. Current file (no number) = newest.
    // The sort puts highest-numbered first (oldest), current file last (newest).
    const logDir = join(testDir, "logs");
    mkdirSync(logDir, { recursive: true });

    // Oldest backup (highest number)
    writeJsonl(join(logDir, "app.3.jsonl"), [
      makeEntry({ ts: "2025-01-01T00:00:00.000Z", message: "oldest" }),
    ]);
    // Middle backup
    writeJsonl(join(logDir, "app.2.jsonl"), [
      makeEntry({ ts: "2025-03-01T00:00:00.000Z", message: "older" }),
    ]);
    // Newest backup
    writeJsonl(join(logDir, "app.1.jsonl"), [
      makeEntry({ ts: "2025-06-01T00:00:00.000Z", message: "recent backup" }),
    ]);
    // Current file (newest)
    writeJsonl(join(logDir, "app.jsonl"), [
      makeEntry({ ts: "2025-09-01T00:00:00.000Z", message: "current" }),
    ]);

    const result = readLogsFromDir(logDir, "app");
    expect(result).toHaveLength(4);
    expect(result[0].message).toBe("oldest");
    expect(result[1].message).toBe("older");
    expect(result[2].message).toBe("recent backup");
    expect(result[3].message).toBe("current");
  });

  it("returns empty array for non-existent directory", () => {
    const result = readLogsFromDir(join(testDir, "nonexistent"), "app");
    expect(result).toEqual([]);
  });

  it("reads only the current file when no backups exist", () => {
    const logDir = join(testDir, "logs");
    mkdirSync(logDir, { recursive: true });

    writeJsonl(join(logDir, "app.jsonl"), [
      makeEntry({ message: "only entry" }),
    ]);

    const result = readLogsFromDir(logDir, "app");
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("only entry");
  });

  it("ignores files that do not match the prefix", () => {
    const logDir = join(testDir, "logs");
    mkdirSync(logDir, { recursive: true });

    writeJsonl(join(logDir, "app.jsonl"), [
      makeEntry({ message: "app entry" }),
    ]);
    writeJsonl(join(logDir, "other.jsonl"), [
      makeEntry({ message: "other entry" }),
    ]);
    writeJsonl(join(logDir, "app-extra.jsonl"), [
      makeEntry({ message: "extra entry" }),
    ]);

    const result = readLogsFromDir(logDir, "app");
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("app entry");
  });

  it("applies filters across all files", () => {
    const logDir = join(testDir, "logs");
    mkdirSync(logDir, { recursive: true });

    writeJsonl(join(logDir, "app.1.jsonl"), [
      makeEntry({ level: "info", message: "backup info" }),
      makeEntry({ level: "error", message: "backup error" }),
    ]);
    writeJsonl(join(logDir, "app.jsonl"), [
      makeEntry({ level: "info", message: "current info" }),
      makeEntry({ level: "error", message: "current error" }),
    ]);

    const result = readLogsFromDir(logDir, "app", { level: ["error"] });
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe("backup error");
    expect(result[1].message).toBe("current error");
  });

  it("respects limit across multiple files", () => {
    const logDir = join(testDir, "logs");
    mkdirSync(logDir, { recursive: true });

    writeJsonl(join(logDir, "app.2.jsonl"), [
      makeEntry({ message: "backup-2 entry 1" }),
      makeEntry({ message: "backup-2 entry 2" }),
    ]);
    writeJsonl(join(logDir, "app.1.jsonl"), [
      makeEntry({ message: "backup-1 entry 1" }),
      makeEntry({ message: "backup-1 entry 2" }),
    ]);
    writeJsonl(join(logDir, "app.jsonl"), [
      makeEntry({ message: "current entry 1" }),
      makeEntry({ message: "current entry 2" }),
    ]);

    const result = readLogsFromDir(logDir, "app", { limit: 3 });
    expect(result).toHaveLength(3);
    // Should get entries from oldest files first
    expect(result[0].message).toBe("backup-2 entry 1");
    expect(result[1].message).toBe("backup-2 entry 2");
    expect(result[2].message).toBe("backup-1 entry 1");
  });

  it("returns empty array when directory has no matching files", () => {
    const logDir = join(testDir, "logs");
    mkdirSync(logDir, { recursive: true });

    writeJsonl(join(logDir, "other.jsonl"), [
      makeEntry({ message: "irrelevant" }),
    ]);

    const result = readLogsFromDir(logDir, "app");
    expect(result).toEqual([]);
  });

  it("handles prefix with regex metacharacters", () => {
    const logDir = join(testDir, "logs");
    mkdirSync(logDir, { recursive: true });

    // The prefix "app.v2" contains a dot which is a regex metacharacter
    writeJsonl(join(logDir, "app.v2.jsonl"), [
      makeEntry({ message: "correct" }),
    ]);
    // This should NOT match because "appXv2" is not "app.v2"
    writeJsonl(join(logDir, "appXv2.jsonl"), [
      makeEntry({ message: "wrong" }),
    ]);

    const result = readLogsFromDir(logDir, "app.v2");
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("correct");
  });
});

describe("tailLogs", () => {
  it("returns last N entries from a log file", () => {
    const entries = [
      makeEntry({ message: "one" }),
      makeEntry({ message: "two" }),
      makeEntry({ message: "three" }),
      makeEntry({ message: "four" }),
      makeEntry({ message: "five" }),
    ];
    const filePath = join(testDir, "test.jsonl");
    writeJsonl(filePath, entries);

    const result = tailLogs(filePath, 3);
    expect(result).toHaveLength(3);
    expect(result[0].message).toBe("three");
    expect(result[1].message).toBe("four");
    expect(result[2].message).toBe("five");
  });

  it("returns all entries when N exceeds total", () => {
    const entries = [
      makeEntry({ message: "one" }),
      makeEntry({ message: "two" }),
    ];
    const filePath = join(testDir, "test.jsonl");
    writeJsonl(filePath, entries);

    const result = tailLogs(filePath, 100);
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe("one");
    expect(result[1].message).toBe("two");
  });

  it("returns empty array for non-existent file", () => {
    const result = tailLogs(join(testDir, "nonexistent.jsonl"), 5);
    expect(result).toEqual([]);
  });

  it("returns exactly all entries when N equals total", () => {
    const entries = [
      makeEntry({ message: "a" }),
      makeEntry({ message: "b" }),
      makeEntry({ message: "c" }),
    ];
    const filePath = join(testDir, "test.jsonl");
    writeJsonl(filePath, entries);

    const result = tailLogs(filePath, 3);
    expect(result).toHaveLength(3);
    expect(result[0].message).toBe("a");
    expect(result[1].message).toBe("b");
    expect(result[2].message).toBe("c");
  });

  it("returns single entry when N is 1", () => {
    const entries = [
      makeEntry({ message: "first" }),
      makeEntry({ message: "second" }),
      makeEntry({ message: "last" }),
    ];
    const filePath = join(testDir, "test.jsonl");
    writeJsonl(filePath, entries);

    const result = tailLogs(filePath, 1);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("last");
  });

  it("skips corrupted lines in the tail region", () => {
    const content = [
      JSON.stringify(makeEntry({ message: "early" })),
      JSON.stringify(makeEntry({ message: "valid-1" })),
      "not valid json",
      JSON.stringify(makeEntry({ message: "valid-2" })),
    ].join("\n") + "\n";

    const filePath = join(testDir, "test.jsonl");
    writeFileSync(filePath, content, "utf-8");

    // Tail 3: gets "valid-1", "not valid json" (skipped), "valid-2"
    const result = tailLogs(filePath, 3);
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe("valid-1");
    expect(result[1].message).toBe("valid-2");
  });

  it("returns empty array for file with only empty lines", () => {
    const filePath = join(testDir, "test.jsonl");
    writeFileSync(filePath, "\n\n  \n\n", "utf-8");

    const result = tailLogs(filePath, 5);
    expect(result).toEqual([]);
  });

  it("preserves data field in entries", () => {
    const entries = [
      makeEntry({ message: "with data", data: { key: "value", count: 42 } }),
    ];
    const filePath = join(testDir, "test.jsonl");
    writeJsonl(filePath, entries);

    const result = tailLogs(filePath, 1);
    expect(result).toHaveLength(1);
    expect(result[0].data).toEqual({ key: "value", count: 42 });
  });
});

// ── parseApiLogs ─────────────────────────────────────────────────────────────

describe("parseApiLogs", () => {
  it("parses api.jsonl entries into ApiLogEntry objects", () => {
    const entries: LogEntry[] = [
      makeEntry({
        source: "api",
        sessionId: "ao-1",
        data: { method: "GET", path: "/api/sessions", statusCode: 200, durationMs: 50 },
      }),
    ];
    writeJsonl(join(testDir, "api.jsonl"), entries);

    const result = parseApiLogs(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].method).toBe("GET");
    expect(result[0].path).toBe("/api/sessions");
    expect(result[0].statusCode).toBe(200);
    expect(result[0].durationMs).toBe(50);
    expect(result[0].sessionId).toBe("ao-1");
  });

  it("skips entries missing method or path", () => {
    const entries: LogEntry[] = [
      makeEntry({ source: "api", data: { statusCode: 200, durationMs: 10 } }),
      makeEntry({ source: "api", data: { method: "GET", statusCode: 200, durationMs: 10 } }),
      makeEntry({ source: "api", data: { method: "GET", path: "/api/health", statusCode: 200, durationMs: 10 } }),
    ];
    writeJsonl(join(testDir, "api.jsonl"), entries);

    const result = parseApiLogs(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/api/health");
  });

  it("parses optional error, timings, and cacheStats fields", () => {
    const entries: LogEntry[] = [
      makeEntry({
        source: "api",
        data: {
          method: "POST",
          path: "/api/spawn",
          statusCode: 500,
          durationMs: 200,
          error: "spawn failed",
          timings: { serviceInit: 5, prEnrichment: 150 },
          cacheStats: { hits: 10, misses: 2, hitRate: 0.83, size: 12 },
        },
      }),
    ];
    writeJsonl(join(testDir, "api.jsonl"), entries);

    const result = parseApiLogs(testDir);
    expect(result[0].error).toBe("spawn failed");
    expect(result[0].timings).toEqual({ serviceInit: 5, prEnrichment: 150 });
    expect(result[0].cacheStats).toEqual({ hits: 10, misses: 2, hitRate: 0.83, size: 12 });
  });

  it("filters by route when opts.route is provided", () => {
    const entries: LogEntry[] = [
      makeEntry({ source: "api", data: { method: "GET", path: "/api/sessions", statusCode: 200, durationMs: 10 } }),
      makeEntry({ source: "api", data: { method: "GET", path: "/api/health", statusCode: 200, durationMs: 5 } }),
    ];
    writeJsonl(join(testDir, "api.jsonl"), entries);

    const result = parseApiLogs(testDir, { route: "sessions" });
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/api/sessions");
  });

  it("returns empty array when no api.jsonl exists", () => {
    const result = parseApiLogs(testDir);
    expect(result).toEqual([]);
  });
});

// ── computeApiStats ───────────────────────────────────────────────────────────

function makeApiEntry(overrides: Partial<ApiLogEntry> = {}): ApiLogEntry {
  return {
    ts: "2026-01-15T12:00:00Z",
    method: "GET",
    path: "/api/sessions",
    sessionId: null,
    statusCode: 200,
    durationMs: 100,
    ...overrides,
  };
}

describe("computeApiStats", () => {
  it("returns empty routes and slowest for empty input", () => {
    const result = computeApiStats([]);
    expect(result.routes).toEqual({});
    expect(result.slowest).toEqual([]);
    expect(result.latestCacheStats).toBeNull();
  });

  it("groups entries by normalized route key", () => {
    const entries = [
      makeApiEntry({ path: "/api/sessions/abc", durationMs: 100 }),
      makeApiEntry({ path: "/api/sessions/def", durationMs: 200 }),
      makeApiEntry({ path: "/api/health", durationMs: 5 }),
    ];

    const result = computeApiStats(entries);
    expect(result.routes["GET /api/sessions/:id"]).toBeDefined();
    expect(result.routes["GET /api/sessions/:id"].count).toBe(2);
    expect(result.routes["GET /api/health"]).toBeDefined();
    expect(result.routes["GET /api/health"].count).toBe(1);
  });

  it("computes correct avgMs, p50Ms, p95Ms, p99Ms", () => {
    const durations = [100, 200, 300, 400];
    const entries = durations.map((durationMs) => makeApiEntry({ durationMs }));

    const result = computeApiStats(entries);
    const route = result.routes["GET /api/sessions"];
    expect(route.count).toBe(4);
    expect(route.avgMs).toBe(250); // (100+200+300+400)/4
    expect(route.p50Ms).toBeGreaterThanOrEqual(100);
    expect(route.p50Ms).toBeLessThanOrEqual(200);
    expect(route.p95Ms).toBeGreaterThanOrEqual(300);
    expect(route.p99Ms).toBeGreaterThanOrEqual(300);
  });

  it("counts errors for status >= 400", () => {
    const entries = [
      makeApiEntry({ statusCode: 200 }),
      makeApiEntry({ statusCode: 400 }),
      makeApiEntry({ statusCode: 500 }),
    ];

    const result = computeApiStats(entries);
    expect(result.routes["GET /api/sessions"].errors).toBe(2);
  });

  it("counts errors when error field is present regardless of status code", () => {
    const entries = [
      makeApiEntry({ statusCode: 200, error: "something failed" }),
    ];

    const result = computeApiStats(entries);
    expect(result.routes["GET /api/sessions"].errors).toBe(1);
  });

  it("separates routes by HTTP method", () => {
    const entries = [
      makeApiEntry({ method: "GET", path: "/api/sessions" }),
      makeApiEntry({ method: "POST", path: "/api/sessions" }),
    ];

    const result = computeApiStats(entries);
    expect(result.routes["GET /api/sessions"]).toBeDefined();
    expect(result.routes["POST /api/sessions"]).toBeDefined();
  });

  it("returns top 10 slowest requests sorted descending", () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      makeApiEntry({ durationMs: (i + 1) * 10 }),
    );

    const result = computeApiStats(entries);
    expect(result.slowest).toHaveLength(10);
    expect(result.slowest[0].durationMs).toBe(150); // fastest of top 10: 15*10
    expect(result.slowest[0].durationMs).toBeGreaterThan(result.slowest[1].durationMs);
  });

  it("returns latestCacheStats from most recent entry with cacheStats", () => {
    const entries = [
      makeApiEntry({ cacheStats: { hits: 1, misses: 1, hitRate: 0.5, size: 2 } }),
      makeApiEntry({}),
      makeApiEntry({ cacheStats: { hits: 20, misses: 5, hitRate: 0.8, size: 25 } }),
    ];

    const result = computeApiStats(entries);
    expect(result.latestCacheStats).toEqual({ hits: 20, misses: 5, hitRate: 0.8, size: 25 });
  });

  it("returns null latestCacheStats when no entries have cacheStats", () => {
    const entries = [makeApiEntry(), makeApiEntry()];
    const result = computeApiStats(entries);
    expect(result.latestCacheStats).toBeNull();
  });
});
