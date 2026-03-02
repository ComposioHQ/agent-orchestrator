import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { generateReportCard } from "../session-report-card.js";

let tmpDir: string;
let eventsLogPath: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-report-card-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  eventsLogPath = join(tmpDir, "events.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper to write JSONL lines to the events log file. */
function writeEvents(entries: Array<Record<string, unknown>>): void {
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(eventsLogPath, lines, "utf-8");
}

/** Helper to build a log entry with sensible defaults. */
function makeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    level: "info",
    source: "lifecycle",
    sessionId: "test-1",
    message: "event",
    ...overrides,
  };
}

describe("generateReportCard", () => {
  it("returns defaults for empty events (no log file)", () => {
    // eventsLogPath does not exist yet
    const card = generateReportCard("test-1", eventsLogPath, {});

    expect(card.sessionId).toBe("test-1");
    expect(card.projectId).toBe("");
    expect(card.stateTransitions).toEqual([]);
    expect(card.ciAttempts).toBe(0);
    expect(card.reviewRounds).toBe(0);
    expect(card.outcome).toBe("active");
    expect(card.prUrl).toBeNull();
  });

  it("returns defaults for empty events file", () => {
    writeFileSync(eventsLogPath, "", "utf-8");

    const card = generateReportCard("test-1", eventsLogPath, {});

    expect(card.stateTransitions).toEqual([]);
    expect(card.ciAttempts).toBe(0);
    expect(card.reviewRounds).toBe(0);
    expect(card.outcome).toBe("active");
  });

  it("tracks state transitions from oldStatus/newStatus in data", () => {
    const t1 = "2025-06-01T10:00:00.000Z";
    const t2 = "2025-06-01T10:05:00.000Z";
    const t3 = "2025-06-01T10:10:00.000Z";

    writeEvents([
      makeEntry({ ts: t1, data: { oldStatus: "spawning", newStatus: "working" } }),
      makeEntry({ ts: t2, data: { oldStatus: "working", newStatus: "pr_open" } }),
      makeEntry({ ts: t3, data: { oldStatus: "pr_open", newStatus: "merged" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});

    expect(card.stateTransitions).toHaveLength(3);
    expect(card.stateTransitions[0]).toEqual({ from: "spawning", to: "working", at: t1 });
    expect(card.stateTransitions[1]).toEqual({ from: "working", to: "pr_open", at: t2 });
    expect(card.stateTransitions[2]).toEqual({ from: "pr_open", to: "merged", at: t3 });
  });

  it("counts CI attempts from data.type=ci.failing", () => {
    writeEvents([
      makeEntry({ data: { type: "ci.failing" } }),
      makeEntry({ data: { type: "ci.failing" } }),
      makeEntry({ data: { type: "ci.failing" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});
    expect(card.ciAttempts).toBe(3);
  });

  it("counts CI attempts from data.newStatus=ci_failed", () => {
    writeEvents([
      makeEntry({ data: { oldStatus: "pr_open", newStatus: "ci_failed" } }),
      makeEntry({ data: { oldStatus: "ci_failed", newStatus: "working" } }),
      makeEntry({ data: { oldStatus: "working", newStatus: "ci_failed" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});
    expect(card.ciAttempts).toBe(2);
  });

  it("counts both ci.failing type and ci_failed newStatus without double-counting different events", () => {
    writeEvents([
      makeEntry({ data: { type: "ci.failing" } }),
      makeEntry({ data: { oldStatus: "pr_open", newStatus: "ci_failed" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});
    expect(card.ciAttempts).toBe(2);
  });

  it("counts review rounds from data.type=review.changes_requested", () => {
    writeEvents([
      makeEntry({ data: { type: "review.changes_requested" } }),
      makeEntry({ data: { type: "review.changes_requested" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});
    expect(card.reviewRounds).toBe(2);
  });

  it("counts review rounds from data.newStatus=changes_requested", () => {
    writeEvents([
      makeEntry({ data: { oldStatus: "review_pending", newStatus: "changes_requested" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});
    expect(card.reviewRounds).toBe(1);
  });

  it("determines outcome=merged from last transition", () => {
    writeEvents([
      makeEntry({ data: { oldStatus: "spawning", newStatus: "working" } }),
      makeEntry({ data: { oldStatus: "working", newStatus: "merged" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});
    expect(card.outcome).toBe("merged");
  });

  it("determines outcome=killed from last transition", () => {
    writeEvents([
      makeEntry({ data: { oldStatus: "spawning", newStatus: "working" } }),
      makeEntry({ data: { oldStatus: "working", newStatus: "killed" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});
    expect(card.outcome).toBe("killed");
  });

  it("determines outcome=abandoned from last transition", () => {
    writeEvents([
      makeEntry({ data: { oldStatus: "working", newStatus: "abandoned" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});
    expect(card.outcome).toBe("abandoned");
  });

  it("determines outcome=active for unrecognized last status", () => {
    writeEvents([
      makeEntry({ data: { oldStatus: "spawning", newStatus: "working" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});
    expect(card.outcome).toBe("active");
  });

  it("falls back to metadata status when there are no transitions", () => {
    writeEvents([
      makeEntry({ message: "session started" }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, { status: "merged" });
    expect(card.outcome).toBe("merged");
  });

  it("falls back to active when no transitions and no metadata status", () => {
    writeEvents([
      makeEntry({ message: "session started" }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});
    expect(card.outcome).toBe("active");
  });

  it("calculates duration from first to last event timestamps", () => {
    const start = "2025-06-01T10:00:00.000Z";
    const end = "2025-06-01T12:30:00.000Z";

    writeEvents([
      makeEntry({ ts: start, data: { oldStatus: "spawning", newStatus: "working" } }),
      makeEntry({ ts: "2025-06-01T11:00:00.000Z", message: "doing work" }),
      makeEntry({ ts: end, data: { oldStatus: "working", newStatus: "merged" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});

    expect(card.duration.startedAt).toBe(start);
    expect(card.duration.endedAt).toBe(end);
    // 2.5 hours = 9,000,000 ms
    expect(card.duration.totalMs).toBe(9_000_000);
  });

  it("endedAt is null for active sessions", () => {
    const start = "2025-06-01T10:00:00.000Z";

    writeEvents([
      makeEntry({ ts: start, data: { oldStatus: "spawning", newStatus: "working" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});

    expect(card.duration.startedAt).toBe(start);
    expect(card.duration.endedAt).toBeNull();
    // totalMs should be positive (now minus start)
    expect(card.duration.totalMs).toBeGreaterThan(0);
  });

  it("uses metadata createdAt when no events present", () => {
    const createdAt = "2025-06-01T08:00:00.000Z";

    // No events file at all
    const card = generateReportCard("test-1", eventsLogPath, { createdAt });

    expect(card.duration.startedAt).toBe(createdAt);
  });

  it("reads PR URL from metadata", () => {
    writeEvents([makeEntry({})]);

    const card = generateReportCard("test-1", eventsLogPath, {
      pr: "https://github.com/org/repo/pull/42",
    });

    expect(card.prUrl).toBe("https://github.com/org/repo/pull/42");
  });

  it("prUrl is null when metadata has no pr field", () => {
    writeEvents([makeEntry({})]);

    const card = generateReportCard("test-1", eventsLogPath, {});
    expect(card.prUrl).toBeNull();
  });

  it("reads projectId from metadata", () => {
    writeEvents([makeEntry({})]);

    const card = generateReportCard("test-1", eventsLogPath, {
      project: "my-project",
    });

    expect(card.projectId).toBe("my-project");
  });

  it("only includes events matching the given sessionId", () => {
    writeEvents([
      makeEntry({ sessionId: "test-1", data: { type: "ci.failing" } }),
      makeEntry({ sessionId: "other-session", data: { type: "ci.failing" } }),
      makeEntry({ sessionId: "test-1", data: { type: "ci.failing" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});
    expect(card.ciAttempts).toBe(2);
  });

  it("handles events without data gracefully", () => {
    writeEvents([
      makeEntry({ message: "plain event" }),
      makeEntry({ message: "another event" }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {});

    expect(card.stateTransitions).toEqual([]);
    expect(card.ciAttempts).toBe(0);
    expect(card.reviewRounds).toBe(0);
  });

  it("handles corrupted JSONL lines gracefully", () => {
    const content = [
      JSON.stringify(makeEntry({ data: { type: "ci.failing" } })),
      "THIS IS NOT VALID JSON",
      JSON.stringify(makeEntry({ data: { type: "ci.failing" } })),
    ].join("\n") + "\n";

    writeFileSync(eventsLogPath, content, "utf-8");

    const card = generateReportCard("test-1", eventsLogPath, {});
    // Corrupted line is skipped, two valid ci.failing events counted
    expect(card.ciAttempts).toBe(2);
  });

  it("full lifecycle scenario", () => {
    const t1 = "2025-06-01T10:00:00.000Z";
    const t2 = "2025-06-01T10:30:00.000Z";
    const t3 = "2025-06-01T11:00:00.000Z";
    const t4 = "2025-06-01T11:30:00.000Z";
    const t5 = "2025-06-01T12:00:00.000Z";
    const t6 = "2025-06-01T12:30:00.000Z";
    const t7 = "2025-06-01T13:00:00.000Z";

    writeEvents([
      makeEntry({ ts: t1, data: { oldStatus: "spawning", newStatus: "working" } }),
      makeEntry({ ts: t2, data: { oldStatus: "working", newStatus: "pr_open" } }),
      makeEntry({ ts: t3, data: { oldStatus: "pr_open", newStatus: "ci_failed" } }),
      makeEntry({ ts: t4, data: { oldStatus: "ci_failed", newStatus: "working" } }),
      makeEntry({ ts: t5, data: { oldStatus: "working", newStatus: "pr_open" } }),
      makeEntry({ ts: t6, data: { oldStatus: "pr_open", newStatus: "changes_requested" } }),
      makeEntry({ ts: t7, data: { oldStatus: "changes_requested", newStatus: "merged" } }),
    ]);

    const card = generateReportCard("test-1", eventsLogPath, {
      project: "my-app",
      pr: "https://github.com/org/repo/pull/99",
    });

    expect(card.sessionId).toBe("test-1");
    expect(card.projectId).toBe("my-app");
    expect(card.stateTransitions).toHaveLength(7);
    expect(card.ciAttempts).toBe(1);
    expect(card.reviewRounds).toBe(1);
    expect(card.outcome).toBe("merged");
    expect(card.prUrl).toBe("https://github.com/org/repo/pull/99");
    expect(card.duration.startedAt).toBe(t1);
    expect(card.duration.endedAt).toBe(t7);
    // 3 hours = 10,800,000 ms
    expect(card.duration.totalMs).toBe(10_800_000);
  });
});
