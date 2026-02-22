import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatAge,
  statusColor,
  header,
  banner,
  formatMs,
  parseSinceArg,
  colorLevel,
  formatLogEntry,
  padCol,
  ciStatusIcon,
  reviewDecisionIcon,
  activityIcon,
} from "../../src/lib/format.js";
import type { LogEntry } from "@composio/ao-core";

describe("formatAge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats seconds ago", () => {
    const thirtySecsAgo = Date.now() - 30_000;
    expect(formatAge(thirtySecsAgo)).toBe("30s ago");
  });

  it("formats minutes ago", () => {
    const fiveMinsAgo = Date.now() - 5 * 60_000;
    expect(formatAge(fiveMinsAgo)).toBe("5m ago");
  });

  it("formats hours ago", () => {
    const twoHoursAgo = Date.now() - 2 * 3600_000;
    expect(formatAge(twoHoursAgo)).toBe("2h ago");
  });

  it("formats days ago", () => {
    const threeDaysAgo = Date.now() - 3 * 86400_000;
    expect(formatAge(threeDaysAgo)).toBe("3d ago");
  });

  it("handles zero difference", () => {
    expect(formatAge(Date.now())).toBe("0s ago");
  });
});

describe("statusColor", () => {
  it("returns colored string for known statuses", () => {
    // We just check it returns a non-empty string (chalk will wrap it)
    expect(statusColor("working")).toBeTruthy();
    expect(statusColor("idle")).toBeTruthy();
    expect(statusColor("ci_failed")).toBeTruthy();
    expect(statusColor("approved")).toBeTruthy();
    expect(statusColor("merged")).toBeTruthy();
    expect(statusColor("spawning")).toBeTruthy();
    expect(statusColor("killed")).toBeTruthy();
    expect(statusColor("needs_input")).toBeTruthy();
    expect(statusColor("pr_open")).toBeTruthy();
    expect(statusColor("review_pending")).toBeTruthy();
    expect(statusColor("changes_requested")).toBeTruthy();
  });

  it("returns the raw string for unknown statuses", () => {
    expect(statusColor("unknown_state")).toBe("unknown_state");
  });
});

describe("header", () => {
  it("returns multiline box drawing string", () => {
    const result = header("My Project");
    expect(result).toContain("My Project");
    // Should have 3 lines (top border, content, bottom border)
    const lines = result.split("\n");
    expect(lines.length).toBe(3);
  });
});

describe("banner", () => {
  it("returns multiline double-line box string", () => {
    const result = banner("STATUS");
    expect(result).toContain("STATUS");
    const lines = result.split("\n");
    expect(lines.length).toBe(3);
  });
});

describe("formatMs", () => {
  it("formats sub-second durations with ms suffix", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(1)).toBe("1ms");
    expect(formatMs(500)).toBe("500ms");
    expect(formatMs(999)).toBe("999ms");
  });

  it("formats 1 second exactly as seconds", () => {
    expect(formatMs(1000)).toBe("1.0s");
  });

  it("formats multi-second durations with one decimal", () => {
    expect(formatMs(1500)).toBe("1.5s");
    expect(formatMs(2000)).toBe("2.0s");
    expect(formatMs(12345)).toBe("12.3s");
  });
});

describe("parseSinceArg", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses seconds suffix", () => {
    const result = parseSinceArg("30s");
    const expectedMs = Date.now() - 30 * 1000;
    expect(result.getTime()).toBe(expectedMs);
  });

  it("parses minutes suffix", () => {
    const result = parseSinceArg("5m");
    const expectedMs = Date.now() - 5 * 60_000;
    expect(result.getTime()).toBe(expectedMs);
  });

  it("parses hours suffix", () => {
    const result = parseSinceArg("2h");
    const expectedMs = Date.now() - 2 * 3_600_000;
    expect(result.getTime()).toBe(expectedMs);
  });

  it("parses days suffix", () => {
    const result = parseSinceArg("3d");
    const expectedMs = Date.now() - 3 * 86_400_000;
    expect(result.getTime()).toBe(expectedMs);
  });

  it("parses ISO 8601 date string", () => {
    const iso = "2026-01-01T00:00:00Z";
    const result = parseSinceArg(iso);
    expect(result).toEqual(new Date(iso));
  });

  it("throws on invalid format", () => {
    expect(() => parseSinceArg("bad")).toThrow(/Invalid time format/);
    expect(() => parseSinceArg("5x")).toThrow(/Invalid time format/);
    expect(() => parseSinceArg("not-a-date")).toThrow(/Invalid time format/);
  });
});

describe("colorLevel", () => {
  it("returns non-empty string for each level", () => {
    const levels: LogEntry["level"][] = ["error", "warn", "stderr", "stdout", "info"];
    for (const level of levels) {
      expect(colorLevel(level)).toBeTruthy();
    }
  });

  it("error level contains ERR", () => {
    expect(colorLevel("error")).toContain("ERR");
  });

  it("warn level contains WRN", () => {
    expect(colorLevel("warn")).toContain("WRN");
  });

  it("stderr level contains err", () => {
    expect(colorLevel("stderr")).toContain("err");
  });

  it("stdout level contains out", () => {
    expect(colorLevel("stdout")).toContain("out");
  });

  it("info level contains inf", () => {
    expect(colorLevel("info")).toContain("inf");
  });
});

describe("formatLogEntry", () => {
  const baseEntry: LogEntry = {
    ts: "2026-01-15T12:00:00Z",
    level: "info",
    source: "lifecycle",
    sessionId: null,
    message: "session spawned",
  };

  it("includes the message text", () => {
    const result = formatLogEntry(baseEntry);
    expect(result).toContain("session spawned");
  });

  it("includes the level indicator", () => {
    const result = formatLogEntry(baseEntry);
    expect(result).toContain("inf");
  });

  it("includes the formatted timestamp", () => {
    const result = formatLogEntry(baseEntry);
    // toLocaleTimeString output varies by locale but should be non-empty
    expect(result.length).toBeGreaterThan("inf session spawned".length);
  });

  it("includes sessionId when present", () => {
    const entry = { ...baseEntry, sessionId: "sess-abc" };
    const result = formatLogEntry(entry);
    expect(result).toContain("sess-abc");
  });

  it("omits sessionId prefix when null", () => {
    const result = formatLogEntry(baseEntry);
    // No extra whitespace from sessionId prefix
    expect(result).not.toContain("null");
  });

  it("formats error entries with ERR indicator", () => {
    const entry = { ...baseEntry, level: "error" as const, message: "something failed" };
    const result = formatLogEntry(entry);
    expect(result).toContain("ERR");
    expect(result).toContain("something failed");
  });
});

describe("padCol", () => {
  it("pads short strings to the target width", () => {
    const result = padCol("hi", 10);
    expect(result.length).toBe(10);
    expect(result).toContain("hi");
  });

  it("returns string unchanged when exactly at width", () => {
    const result = padCol("hello", 5);
    expect(result.length).toBe(5);
    expect(result).toBe("hello");
  });

  it("truncates long strings with ellipsis", () => {
    const result = padCol("abcdefghij", 5);
    expect(result.length).toBe(5);
    expect(result).toContain("…");
  });

  it("handles ANSI escape codes correctly (visible width)", () => {
    // A chalk-colored string: ANSI codes are invisible characters
    const colored = "\u001b[32mgreen\u001b[0m"; // visible: "green" (5 chars)
    const result = padCol(colored, 10);
    // Visible content is "green" (5 chars) + 5 spaces = 10 visible chars
    // But actual string is longer due to ANSI codes
    // eslint-disable-next-line no-control-regex
    const stripped = result.replace(/\u001b\[[0-9;]*m/g, "");
    expect(stripped.length).toBe(10);
  });

  it("handles empty string", () => {
    const result = padCol("", 5);
    expect(result.length).toBe(5);
    expect(result.trim()).toBe("");
  });
});

describe("ciStatusIcon", () => {
  it("returns pass for passing", () => {
    expect(ciStatusIcon("passing")).toContain("pass");
  });

  it("returns fail for failing", () => {
    expect(ciStatusIcon("failing")).toContain("fail");
  });

  it("returns pend for pending", () => {
    expect(ciStatusIcon("pending")).toContain("pend");
  });

  it("returns dash for none", () => {
    expect(ciStatusIcon("none")).toContain("-");
  });

  it("returns dash for null", () => {
    expect(ciStatusIcon(null)).toContain("-");
  });
});

describe("reviewDecisionIcon", () => {
  it("returns ok for approved", () => {
    expect(reviewDecisionIcon("approved")).toContain("ok");
  });

  it("returns change indicator for changes_requested", () => {
    expect(reviewDecisionIcon("changes_requested")).toContain("chg!");
  });

  it("returns review indicator for pending", () => {
    expect(reviewDecisionIcon("pending")).toContain("rev?");
  });

  it("returns dash for none", () => {
    expect(reviewDecisionIcon("none")).toContain("-");
  });

  it("returns dash for null", () => {
    expect(reviewDecisionIcon(null)).toContain("-");
  });
});

describe("activityIcon", () => {
  it("returns working for active", () => {
    expect(activityIcon("active")).toContain("working");
  });

  it("returns ready for ready", () => {
    expect(activityIcon("ready")).toContain("ready");
  });

  it("returns idle for idle", () => {
    expect(activityIcon("idle")).toContain("idle");
  });

  it("returns waiting for waiting_input", () => {
    expect(activityIcon("waiting_input")).toContain("waiting");
  });

  it("returns blocked for blocked", () => {
    expect(activityIcon("blocked")).toContain("blocked");
  });

  it("returns exited for exited", () => {
    expect(activityIcon("exited")).toContain("exited");
  });

  it("returns unknown for null", () => {
    expect(activityIcon(null)).toContain("unknown");
  });
});
