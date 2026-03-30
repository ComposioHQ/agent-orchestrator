import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeRecoveryLog,
  createLogEntry,
  formatRecoveryReport,
  createEmptyReport,
} from "../recovery/logger.js";
import type { RecoveryLogEntry, RecoveryReport } from "../recovery/types.js";

describe("writeRecoveryLog", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-recovery-logger-test-"));
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the file and writes a JSON line", () => {
    const logPath = join(tmpDir, "recovery.log");
    const entry: RecoveryLogEntry = {
      timestamp: "2025-01-01T00:00:00.000Z",
      sessionId: "app-1",
      action: "recovered",
    };

    writeRecoveryLog(logPath, entry);

    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.sessionId).toBe("app-1");
    expect(parsed.action).toBe("recovered");
  });

  it("appends multiple entries on separate lines", () => {
    const logPath = join(tmpDir, "recovery.log");

    const entry1: RecoveryLogEntry = {
      timestamp: "2025-01-01T00:00:00.000Z",
      sessionId: "app-1",
      action: "recovered",
    };
    const entry2: RecoveryLogEntry = {
      timestamp: "2025-01-01T00:01:00.000Z",
      sessionId: "app-2",
      action: "cleaned_up",
    };

    writeRecoveryLog(logPath, entry1);
    writeRecoveryLog(logPath, entry2);

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).sessionId).toBe("app-1");
    expect(JSON.parse(lines[1]).sessionId).toBe("app-2");
  });

  it("creates intermediate directories when they do not exist", () => {
    const logPath = join(tmpDir, "nested", "deep", "recovery.log");

    const entry: RecoveryLogEntry = {
      timestamp: "2025-01-01T00:00:00.000Z",
      sessionId: "app-1",
      action: "recovered",
    };

    writeRecoveryLog(logPath, entry);

    expect(existsSync(logPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(parsed.sessionId).toBe("app-1");
  });

  it("does not fail when directory already exists", () => {
    const logPath = join(tmpDir, "recovery.log");
    const entry: RecoveryLogEntry = {
      timestamp: "2025-01-01T00:00:00.000Z",
      sessionId: "app-1",
      action: "recovered",
    };

    // Write twice to the same existing directory
    writeRecoveryLog(logPath, entry);
    writeRecoveryLog(logPath, entry);

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("includes all optional fields in the JSON output", () => {
    const logPath = join(tmpDir, "recovery.log");
    const entry: RecoveryLogEntry = {
      timestamp: "2025-01-01T00:00:00.000Z",
      sessionId: "app-1",
      action: "error",
      previousStatus: "working",
      reason: "test reason",
      error: "something went wrong",
      details: { extra: "data" },
    };

    writeRecoveryLog(logPath, entry);

    const parsed = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(parsed.previousStatus).toBe("working");
    expect(parsed.reason).toBe("test reason");
    expect(parsed.error).toBe("something went wrong");
    expect(parsed.details).toEqual({ extra: "data" });
  });
});

describe("createLogEntry", () => {
  it("creates a basic log entry with timestamp", () => {
    const entry = createLogEntry("app-1", "recovered");

    expect(entry.sessionId).toBe("app-1");
    expect(entry.action).toBe("recovered");
    expect(entry.timestamp).toBeDefined();
    // Timestamp should be a valid ISO string
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  it("creates a log entry without optional fields when none provided", () => {
    const entry = createLogEntry("app-2", "skipped");

    expect(entry.sessionId).toBe("app-2");
    expect(entry.action).toBe("skipped");
    expect(entry.previousStatus).toBeUndefined();
    expect(entry.reason).toBeUndefined();
    expect(entry.error).toBeUndefined();
    expect(entry.details).toBeUndefined();
  });

  it("includes previousStatus when provided", () => {
    const entry = createLogEntry("app-1", "recovered", {
      previousStatus: "working",
    });

    expect(entry.previousStatus).toBe("working");
  });

  it("includes reason when provided", () => {
    const entry = createLogEntry("app-1", "escalated", {
      reason: "Runtime missing",
    });

    expect(entry.reason).toBe("Runtime missing");
  });

  it("includes error when provided", () => {
    const entry = createLogEntry("app-1", "error", {
      error: "Failed to recover session",
    });

    expect(entry.error).toBe("Failed to recover session");
  });

  it("includes details when provided", () => {
    const entry = createLogEntry("app-1", "cleaned_up", {
      details: { runtimeId: "rt-42", workspacePath: "/tmp/ws" },
    });

    expect(entry.details).toEqual({ runtimeId: "rt-42", workspacePath: "/tmp/ws" });
  });

  it("includes all optional fields together", () => {
    const entry = createLogEntry("app-3", "error", {
      previousStatus: "spawning",
      reason: "Timed out",
      error: "Connection refused",
      details: { attempts: 3 },
    });

    expect(entry.sessionId).toBe("app-3");
    expect(entry.action).toBe("error");
    expect(entry.previousStatus).toBe("spawning");
    expect(entry.reason).toBe("Timed out");
    expect(entry.error).toBe("Connection refused");
    expect(entry.details).toEqual({ attempts: 3 });
  });

  it("supports all valid action types", () => {
    const actions: RecoveryLogEntry["action"][] = [
      "recovered",
      "cleaned_up",
      "escalated",
      "skipped",
      "error",
    ];

    for (const action of actions) {
      const entry = createLogEntry("app-1", action);
      expect(entry.action).toBe(action);
    }
  });
});

describe("formatRecoveryReport", () => {
  it("formats a minimal report with no sessions", () => {
    const report: RecoveryReport = {
      timestamp: new Date("2025-06-01T12:00:00.000Z"),
      totalScanned: 0,
      recovered: [],
      cleanedUp: [],
      escalated: [],
      skipped: [],
      errors: [],
      durationMs: 42,
    };

    const output = formatRecoveryReport(report);
    expect(output).toContain("Recovery Report - 2025-06-01T12:00:00.000Z");
    expect(output).toContain("Duration: 42ms");
    expect(output).toContain("Sessions scanned: 0");
    expect(output).not.toContain("Recovered");
    expect(output).not.toContain("Cleaned up");
    expect(output).not.toContain("Escalated");
    expect(output).not.toContain("Skipped");
    expect(output).not.toContain("Errors");
  });

  it("includes recovered sessions section", () => {
    const report: RecoveryReport = {
      timestamp: new Date("2025-06-01T12:00:00.000Z"),
      totalScanned: 2,
      recovered: ["app-1", "app-2"],
      cleanedUp: [],
      escalated: [],
      skipped: [],
      errors: [],
      durationMs: 100,
    };

    const output = formatRecoveryReport(report);
    expect(output).toContain("Recovered (2): app-1, app-2");
  });

  it("includes cleaned up sessions section", () => {
    const report: RecoveryReport = {
      timestamp: new Date("2025-06-01T12:00:00.000Z"),
      totalScanned: 1,
      recovered: [],
      cleanedUp: ["app-3"],
      escalated: [],
      skipped: [],
      errors: [],
      durationMs: 50,
    };

    const output = formatRecoveryReport(report);
    expect(output).toContain("Cleaned up (1): app-3");
  });

  it("includes escalated sessions section", () => {
    const report: RecoveryReport = {
      timestamp: new Date("2025-06-01T12:00:00.000Z"),
      totalScanned: 1,
      recovered: [],
      cleanedUp: [],
      escalated: ["app-4"],
      skipped: [],
      errors: [],
      durationMs: 50,
    };

    const output = formatRecoveryReport(report);
    expect(output).toContain("Escalated (1): app-4");
  });

  it("includes skipped sessions section", () => {
    const report: RecoveryReport = {
      timestamp: new Date("2025-06-01T12:00:00.000Z"),
      totalScanned: 3,
      recovered: [],
      cleanedUp: [],
      escalated: [],
      skipped: ["app-5", "app-6", "app-7"],
      errors: [],
      durationMs: 10,
    };

    const output = formatRecoveryReport(report);
    expect(output).toContain("Skipped (3): app-5, app-6, app-7");
  });

  it("includes errors section with per-session details", () => {
    const report: RecoveryReport = {
      timestamp: new Date("2025-06-01T12:00:00.000Z"),
      totalScanned: 2,
      recovered: [],
      cleanedUp: [],
      escalated: [],
      skipped: [],
      errors: [
        { sessionId: "app-8", error: "Connection refused" },
        { sessionId: "app-9", error: "Timeout" },
      ],
      durationMs: 200,
    };

    const output = formatRecoveryReport(report);
    expect(output).toContain("Errors:");
    expect(output).toContain("app-8: Connection refused");
    expect(output).toContain("app-9: Timeout");
  });

  it("formats a full report with all sections populated", () => {
    const report: RecoveryReport = {
      timestamp: new Date("2025-06-01T12:00:00.000Z"),
      totalScanned: 10,
      recovered: ["s-1"],
      cleanedUp: ["s-2"],
      escalated: ["s-3"],
      skipped: ["s-4"],
      errors: [{ sessionId: "s-5", error: "Failed" }],
      durationMs: 500,
    };

    const output = formatRecoveryReport(report);
    expect(output).toContain("Sessions scanned: 10");
    expect(output).toContain("Recovered (1): s-1");
    expect(output).toContain("Cleaned up (1): s-2");
    expect(output).toContain("Escalated (1): s-3");
    expect(output).toContain("Skipped (1): s-4");
    expect(output).toContain("s-5: Failed");
  });
});

describe("createEmptyReport", () => {
  it("returns a report with all arrays empty", () => {
    const report = createEmptyReport();

    expect(report.recovered).toEqual([]);
    expect(report.cleanedUp).toEqual([]);
    expect(report.escalated).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it("returns totalScanned as 0", () => {
    const report = createEmptyReport();
    expect(report.totalScanned).toBe(0);
  });

  it("returns durationMs as 0", () => {
    const report = createEmptyReport();
    expect(report.durationMs).toBe(0);
  });

  it("returns timestamp as a Date instance", () => {
    const report = createEmptyReport();
    expect(report.timestamp).toBeInstanceOf(Date);
  });

  it("returns a new object on each call (not shared reference)", () => {
    const report1 = createEmptyReport();
    const report2 = createEmptyReport();

    report1.recovered.push("app-1");
    expect(report2.recovered).toEqual([]);
  });
});
