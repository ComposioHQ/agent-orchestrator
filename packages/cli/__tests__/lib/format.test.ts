import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatAge, statusColor, header, banner } from "../../src/lib/format.js";

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
