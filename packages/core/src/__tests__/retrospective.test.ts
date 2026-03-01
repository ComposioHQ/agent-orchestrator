import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Retrospective, SessionReportCard, LogEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Mocks for generateRetrospective dependencies (hoisted before imports)
// ---------------------------------------------------------------------------

const { mockReadMetadataRaw, mockGenerateReportCard, mockReadLogs, mockGetSessionsDir, mockGetLogsDir } =
  vi.hoisted(() => ({
    mockReadMetadataRaw: vi.fn(),
    mockGenerateReportCard: vi.fn(),
    mockReadLogs: vi.fn(),
    mockGetSessionsDir: vi.fn(),
    mockGetLogsDir: vi.fn(),
  }));

vi.mock("../metadata.js", () => ({
  readMetadataRaw: mockReadMetadataRaw,
}));

vi.mock("../session-report-card.js", () => ({
  generateReportCard: mockGenerateReportCard,
}));

vi.mock("../log-reader.js", () => ({
  readLogs: mockReadLogs,
}));

vi.mock("../paths.js", () => ({
  getSessionsDir: mockGetSessionsDir,
  getLogsDir: mockGetLogsDir,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks so they resolve the mocked modules
// ---------------------------------------------------------------------------

import { saveRetrospective, loadRetrospectives, generateRetrospective } from "../retrospective.js";

let tmpDir: string;
let retroDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-retrospective-${randomUUID()}`);
  retroDir = join(tmpDir, "retrospectives");
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper to build a Retrospective object with sensible defaults. */
function makeRetro(overrides: Partial<Retrospective> = {}): Retrospective {
  return {
    sessionId: "test-1",
    projectId: "my-project",
    generatedAt: "2025-06-01T12:00:00.000Z",
    outcome: "success",
    timeline: [
      { event: "info", at: "2025-06-01T10:00:00.000Z", detail: "session started" },
      { event: "info", at: "2025-06-01T12:00:00.000Z", detail: "session merged" },
    ],
    metrics: {
      totalDurationMs: 7_200_000,
      ciFailures: 0,
      reviewRounds: 0,
    },
    lessons: ["Clean execution: merged quickly with minimal CI/review iterations."],
    reportCard: {
      sessionId: "test-1",
      projectId: "my-project",
      duration: {
        startedAt: "2025-06-01T10:00:00.000Z",
        endedAt: "2025-06-01T12:00:00.000Z",
        totalMs: 7_200_000,
      },
      stateTransitions: [],
      ciAttempts: 0,
      reviewRounds: 0,
      outcome: "merged",
      prUrl: null,
    },
    ...overrides,
  };
}

describe("saveRetrospective", () => {
  it("creates the directory and writes a JSON file", () => {
    const retro = makeRetro();

    saveRetrospective(retro, retroDir);

    const files = readdirSync(retroDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^test-1-.*\.json$/);

    const content = readFileSync(join(retroDir, files[0]), "utf-8");
    const parsed = JSON.parse(content) as Retrospective;
    expect(parsed.sessionId).toBe("test-1");
    expect(parsed.projectId).toBe("my-project");
    expect(parsed.outcome).toBe("success");
  });

  it("writes to existing directory without error", () => {
    mkdirSync(retroDir, { recursive: true });
    const retro = makeRetro();

    expect(() => saveRetrospective(retro, retroDir)).not.toThrow();

    const files = readdirSync(retroDir);
    expect(files).toHaveLength(1);
  });

  it("writes multiple retrospectives for different sessions", () => {
    saveRetrospective(makeRetro({ sessionId: "test-1" }), retroDir);
    saveRetrospective(makeRetro({ sessionId: "test-2" }), retroDir);
    saveRetrospective(makeRetro({ sessionId: "test-3" }), retroDir);

    const files = readdirSync(retroDir);
    expect(files).toHaveLength(3);
  });

  it("preserves all fields in the written JSON", () => {
    const retro = makeRetro({
      lessons: ["Lesson 1", "Lesson 2"],
      metrics: { totalDurationMs: 100_000, ciFailures: 3, reviewRounds: 2 },
    });

    saveRetrospective(retro, retroDir);

    const files = readdirSync(retroDir);
    const content = readFileSync(join(retroDir, files[0]), "utf-8");
    const parsed = JSON.parse(content) as Retrospective;

    expect(parsed.lessons).toEqual(["Lesson 1", "Lesson 2"]);
    expect(parsed.metrics.ciFailures).toBe(3);
    expect(parsed.metrics.reviewRounds).toBe(2);
    expect(parsed.reportCard).toBeDefined();
  });
});

describe("loadRetrospectives", () => {
  it("returns empty array for non-existent directory", () => {
    const result = loadRetrospectives(join(tmpDir, "nonexistent"));
    expect(result).toEqual([]);
  });

  it("returns empty array for empty directory", () => {
    mkdirSync(retroDir, { recursive: true });

    const result = loadRetrospectives(retroDir);
    expect(result).toEqual([]);
  });

  it("loads saved retrospectives", () => {
    const retro = makeRetro();
    saveRetrospective(retro, retroDir);

    const results = loadRetrospectives(retroDir);
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("test-1");
    expect(results[0].projectId).toBe("my-project");
    expect(results[0].outcome).toBe("success");
  });

  it("loads multiple retrospectives sorted newest first", () => {
    // Manually write files with controlled names to verify sort order
    mkdirSync(retroDir, { recursive: true });

    writeFileSync(
      join(retroDir, "test-1-2025-06-01T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-1", generatedAt: "2025-06-01T10:00:00.000Z" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "test-2-2025-06-02T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-2", generatedAt: "2025-06-02T10:00:00.000Z" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "test-3-2025-06-03T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-3", generatedAt: "2025-06-03T10:00:00.000Z" })),
      "utf-8",
    );

    const results = loadRetrospectives(retroDir);
    expect(results).toHaveLength(3);
    // Sorted reverse alphabetically by filename, so newest first
    expect(results[0].sessionId).toBe("test-3");
    expect(results[1].sessionId).toBe("test-2");
    expect(results[2].sessionId).toBe("test-1");
  });

  it("filters by sessionId", () => {
    mkdirSync(retroDir, { recursive: true });

    writeFileSync(
      join(retroDir, "test-1-2025-06-01T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-1" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "test-2-2025-06-01T11-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-2" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "test-1-2025-06-02T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-1" })),
      "utf-8",
    );

    const results = loadRetrospectives(retroDir, { sessionId: "test-1" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.sessionId === "test-1")).toBe(true);
  });

  it("filters by projectId", () => {
    mkdirSync(retroDir, { recursive: true });

    writeFileSync(
      join(retroDir, "test-1-2025-06-01T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-1", projectId: "project-a" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "test-2-2025-06-01T11-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-2", projectId: "project-b" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "test-3-2025-06-01T12-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-3", projectId: "project-a" })),
      "utf-8",
    );

    const results = loadRetrospectives(retroDir, { projectId: "project-a" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.projectId === "project-a")).toBe(true);
  });

  it("respects limit option", () => {
    mkdirSync(retroDir, { recursive: true });

    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(retroDir, `test-${i}-2025-06-0${i}T10-00-00-000Z.json`),
        JSON.stringify(makeRetro({ sessionId: `test-${i}` })),
        "utf-8",
      );
    }

    const results = loadRetrospectives(retroDir, { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("combines sessionId filter with limit", () => {
    mkdirSync(retroDir, { recursive: true });

    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(retroDir, `sess-a-2025-06-0${i}T10-00-00-000Z.json`),
        JSON.stringify(makeRetro({ sessionId: "sess-a" })),
        "utf-8",
      );
    }

    const results = loadRetrospectives(retroDir, { sessionId: "sess-a", limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("skips corrupted JSON files", () => {
    mkdirSync(retroDir, { recursive: true });

    writeFileSync(
      join(retroDir, "good-1-2025-06-01T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "good-1" })),
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "bad-1-2025-06-02T10-00-00-000Z.json"),
      "THIS IS NOT VALID JSON {{{",
      "utf-8",
    );
    writeFileSync(
      join(retroDir, "good-2-2025-06-03T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "good-2" })),
      "utf-8",
    );

    const results = loadRetrospectives(retroDir);
    expect(results).toHaveLength(2);
    const sessionIds = results.map((r) => r.sessionId);
    expect(sessionIds).toContain("good-1");
    expect(sessionIds).toContain("good-2");
  });

  it("ignores non-JSON files", () => {
    mkdirSync(retroDir, { recursive: true });

    writeFileSync(
      join(retroDir, "test-1-2025-06-01T10-00-00-000Z.json"),
      JSON.stringify(makeRetro({ sessionId: "test-1" })),
      "utf-8",
    );
    writeFileSync(join(retroDir, "readme.txt"), "not a retro", "utf-8");
    writeFileSync(join(retroDir, ".hidden"), "hidden file", "utf-8");

    const results = loadRetrospectives(retroDir);
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("test-1");
  });

  it("round-trips save and load", () => {
    const retro = makeRetro({
      sessionId: "roundtrip-1",
      projectId: "proj-x",
      outcome: "failure",
      lessons: ["CI failed 4 times before passing.", "Multiple review rounds (3)."],
      metrics: { totalDurationMs: 50_000_000, ciFailures: 4, reviewRounds: 3 },
    });

    saveRetrospective(retro, retroDir);
    const results = loadRetrospectives(retroDir);

    expect(results).toHaveLength(1);
    const loaded = results[0];
    expect(loaded.sessionId).toBe("roundtrip-1");
    expect(loaded.projectId).toBe("proj-x");
    expect(loaded.outcome).toBe("failure");
    expect(loaded.lessons).toEqual([
      "CI failed 4 times before passing.",
      "Multiple review rounds (3).",
    ]);
    expect(loaded.metrics.ciFailures).toBe(4);
    expect(loaded.metrics.reviewRounds).toBe(3);
    expect(loaded.metrics.totalDurationMs).toBe(50_000_000);
    expect(loaded.reportCard.sessionId).toBe("test-1"); // from default makeRetro
    expect(loaded.timeline).toHaveLength(2);
  });
});

// ===========================================================================
// generateRetrospective + extractLessons (via mocked dependencies)
// ===========================================================================

/** Helper to build a SessionReportCard with sensible defaults. */
function makeReportCard(overrides: Partial<SessionReportCard> = {}): SessionReportCard {
  return {
    sessionId: "test-1",
    projectId: "my-project",
    duration: {
      startedAt: "2025-06-01T10:00:00.000Z",
      endedAt: "2025-06-01T12:00:00.000Z",
      totalMs: 7_200_000, // 2 hours
    },
    stateTransitions: [],
    ciAttempts: 0,
    reviewRounds: 0,
    outcome: "merged",
    prUrl: "https://github.com/org/repo/pull/42",
    ...overrides,
  };
}

/** Helper to build a LogEntry with sensible defaults. */
function makeLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: "2025-06-01T10:00:00.000Z",
    level: "info",
    source: "lifecycle",
    sessionId: "test-1",
    message: "event",
    ...overrides,
  };
}

/** Config fixture for generateRetrospective. */
function makeConfig(): {
  config: { configPath: string; projects: Record<string, { path: string }> };
} {
  return {
    config: {
      configPath: "/tmp/agent-orchestrator.yaml",
      projects: {
        "my-project": { path: "/tmp/repos/my-project" },
      },
    },
  };
}

/**
 * Set up standard mocks for generateRetrospective.
 * Returns the default report card so tests can override fields.
 */
function setupGenerateMocks(opts?: {
  metadata?: Record<string, string> | null;
  archiveMetadata?: Record<string, string> | null;
  reportCard?: Partial<SessionReportCard>;
  logEntries?: LogEntry[];
}): SessionReportCard {
  mockGetSessionsDir.mockReturnValue("/tmp/sessions");
  mockGetLogsDir.mockReturnValue("/tmp/logs");

  // First call: live metadata. Second call: archive metadata.
  if (opts?.metadata !== undefined) {
    mockReadMetadataRaw.mockReturnValueOnce(opts.metadata);
  } else {
    mockReadMetadataRaw.mockReturnValueOnce({ project: "my-project" });
  }
  if (opts?.archiveMetadata !== undefined) {
    mockReadMetadataRaw.mockReturnValueOnce(opts.archiveMetadata);
  }

  const card = makeReportCard(opts?.reportCard);
  mockGenerateReportCard.mockReturnValue(card);

  const entries = opts?.logEntries ?? [];
  mockReadLogs.mockReturnValue(entries);

  return card;
}

describe("generateRetrospective", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for unknown project", () => {
    const { config } = makeConfig();

    const result = generateRetrospective("test-1", config as never, "nonexistent");

    expect(result).toBeNull();
  });

  it("generates a retrospective for a successful session (merged PR)", () => {
    const { config } = makeConfig();
    const entries = [
      makeLogEntry({ ts: "2025-06-01T10:00:00.000Z", message: "session spawned", data: { type: "spawned" } }),
      makeLogEntry({ ts: "2025-06-01T10:30:00.000Z", message: "PR opened", data: { type: "pr.opened" } }),
      makeLogEntry({ ts: "2025-06-01T11:00:00.000Z", message: "PR merged", data: { type: "pr.merged" } }),
    ];
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        ciAttempts: 0,
        reviewRounds: 0,
        prUrl: "https://github.com/org/repo/pull/42",
        duration: {
          startedAt: "2025-06-01T10:00:00.000Z",
          endedAt: "2025-06-01T11:00:00.000Z",
          totalMs: 3_600_000, // 1 hour
        },
      },
      logEntries: entries,
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("test-1");
    expect(result!.projectId).toBe("my-project");
    expect(result!.outcome).toBe("success");
    expect(result!.timeline).toHaveLength(3);
    expect(result!.metrics.totalDurationMs).toBe(3_600_000);
    expect(result!.metrics.ciFailures).toBe(0);
    expect(result!.metrics.reviewRounds).toBe(0);
    expect(result!.reportCard.outcome).toBe("merged");
    expect(result!.lessons).toContain(
      "Clean execution: merged quickly with minimal CI/review iterations.",
    );
  });

  it("generates a retrospective for a failed session (killed, no PR)", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "killed",
        prUrl: null,
        ciAttempts: 0,
        reviewRounds: 0,
        duration: {
          startedAt: "2025-06-01T10:00:00.000Z",
          endedAt: "2025-06-01T11:00:00.000Z",
          totalMs: 3_600_000,
        },
      },
      logEntries: [
        makeLogEntry({ ts: "2025-06-01T10:00:00.000Z", message: "session spawned" }),
        makeLogEntry({ ts: "2025-06-01T11:00:00.000Z", message: "session killed" }),
      ],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("failure");
    expect(result!.lessons).toContain(
      "Session was killed without creating a PR. May indicate a stuck or misdirected session.",
    );
  });

  it("generates a retrospective for partial success (PR open but killed)", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "active",
        prUrl: "https://github.com/org/repo/pull/99",
        ciAttempts: 1,
        reviewRounds: 0,
        duration: {
          startedAt: "2025-06-01T10:00:00.000Z",
          endedAt: "2025-06-01T14:00:00.000Z",
          totalMs: 14_400_000, // 4 hours
        },
      },
      logEntries: [
        makeLogEntry({ ts: "2025-06-01T10:00:00.000Z", message: "session spawned" }),
      ],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("partial");
  });

  it("maps abandoned outcome to failure", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "abandoned",
        prUrl: null,
        ciAttempts: 0,
        reviewRounds: 0,
      },
      logEntries: [],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("failure");
  });

  it("extracts timeline events from log entries", () => {
    const { config } = makeConfig();
    const entries = [
      makeLogEntry({
        ts: "2025-06-01T10:00:00.000Z",
        message: "session spawned",
        data: { type: "spawned" },
      }),
      makeLogEntry({
        ts: "2025-06-01T10:30:00.000Z",
        message: "CI passed",
        data: { type: "ci.passing" },
      }),
      makeLogEntry({
        ts: "2025-06-01T11:00:00.000Z",
        level: "warn",
        message: "warning event",
      }),
    ];
    setupGenerateMocks({
      reportCard: { outcome: "merged" },
      logEntries: entries,
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.timeline).toHaveLength(3);
    expect(result!.timeline[0]).toEqual({
      event: "spawned",
      at: "2025-06-01T10:00:00.000Z",
      detail: "session spawned",
    });
    expect(result!.timeline[1]).toEqual({
      event: "ci.passing",
      at: "2025-06-01T10:30:00.000Z",
      detail: "CI passed",
    });
    // When data.type is absent, falls back to entry.level
    expect(result!.timeline[2]).toEqual({
      event: "warn",
      at: "2025-06-01T11:00:00.000Z",
      detail: "warning event",
    });
  });

  it("falls back to level when data.type is missing in timeline", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: { outcome: "merged" },
      logEntries: [
        makeLogEntry({ level: "error", message: "something broke" }),
      ],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.timeline[0].event).toBe("error");
  });

  it("falls back to archive dir when live metadata is missing", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      metadata: null,
      archiveMetadata: { project: "my-project", branch: "feat/old" },
      reportCard: { outcome: "merged" },
      logEntries: [],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result).not.toBeNull();
    // readMetadataRaw called twice: once for live, once for archive
    expect(mockReadMetadataRaw).toHaveBeenCalledTimes(2);
    expect(mockReadMetadataRaw).toHaveBeenNthCalledWith(1, "/tmp/sessions", "test-1");
    expect(mockReadMetadataRaw).toHaveBeenNthCalledWith(
      2,
      join("/tmp/sessions", "archive"),
      "test-1",
    );
  });

  it("uses fallback metadata when no files found (live or archive)", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      metadata: null,
      archiveMetadata: null,
      reportCard: { outcome: "active" },
      logEntries: [],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result).not.toBeNull();
    // generateReportCard receives { project: projectId } as fallback
    expect(mockGenerateReportCard).toHaveBeenCalledWith(
      "test-1",
      join("/tmp/logs", "events.jsonl"),
      { project: "my-project" },
    );
  });

  it("passes the correct eventsLogPath to generateReportCard and readLogs", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: { outcome: "merged" },
      logEntries: [],
    });

    generateRetrospective("test-1", config as never, "my-project");

    const expectedPath = join("/tmp/logs", "events.jsonl");
    expect(mockGenerateReportCard).toHaveBeenCalledWith("test-1", expectedPath, expect.any(Object));
    expect(mockReadLogs).toHaveBeenCalledWith(expectedPath, { sessionId: "test-1" });
  });

  it("includes generatedAt timestamp", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: { outcome: "merged" },
      logEntries: [],
    });

    const before = new Date().toISOString();
    const result = generateRetrospective("test-1", config as never, "my-project");
    const after = new Date().toISOString();

    expect(result!.generatedAt).toBeDefined();
    expect(result!.generatedAt >= before).toBe(true);
    expect(result!.generatedAt <= after).toBe(true);
  });
});

// ===========================================================================
// extractLessons — exercised through generateRetrospective
// ===========================================================================

describe("extractLessons (via generateRetrospective)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flags high CI failure count (>3 failures)", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        ciAttempts: 5,
        reviewRounds: 0,
        duration: { startedAt: "2025-06-01T10:00:00.000Z", endedAt: "2025-06-01T14:00:00.000Z", totalMs: 14_400_000 },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons).toContain(
      "High CI failure count (5 failures). Consider running tests locally before pushing.",
    );
  });

  it("flags moderate CI failures (>1 but <=3)", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        ciAttempts: 2,
        reviewRounds: 0,
        duration: { startedAt: "2025-06-01T10:00:00.000Z", endedAt: "2025-06-01T14:00:00.000Z", totalMs: 14_400_000 },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons).toContain("CI failed 2 times before passing.");
    // Should NOT contain the "High CI failure count" message
    expect(result!.lessons.some((l) => l.includes("High CI failure count"))).toBe(false);
  });

  it("flags exactly 3 CI failures with moderate message (not high)", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        ciAttempts: 3,
        reviewRounds: 0,
        duration: { startedAt: "2025-06-01T10:00:00.000Z", endedAt: "2025-06-01T14:00:00.000Z", totalMs: 14_400_000 },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons).toContain("CI failed 3 times before passing.");
    expect(result!.lessons.some((l) => l.includes("High CI failure count"))).toBe(false);
  });

  it("flags multiple review rounds (>2)", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        ciAttempts: 0,
        reviewRounds: 3,
        duration: { startedAt: "2025-06-01T10:00:00.000Z", endedAt: "2025-06-01T14:00:00.000Z", totalMs: 14_400_000 },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons).toContain(
      "Multiple review rounds (3). Breaking changes into smaller PRs may help.",
    );
  });

  it("does not flag review rounds when <=2", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        ciAttempts: 0,
        reviewRounds: 2,
        duration: { startedAt: "2025-06-01T10:00:00.000Z", endedAt: "2025-06-01T14:00:00.000Z", totalMs: 14_400_000 },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons.some((l) => l.includes("Multiple review rounds"))).toBe(false);
  });

  it("flags long-running sessions (>24 hours)", () => {
    const { config } = makeConfig();
    const thirtyHoursMs = 30 * 3_600_000;
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        ciAttempts: 0,
        reviewRounds: 0,
        duration: {
          startedAt: "2025-06-01T00:00:00.000Z",
          endedAt: "2025-06-02T06:00:00.000Z",
          totalMs: thirtyHoursMs,
        },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons).toContain(
      "Session ran for 30 hours. Long-running sessions may indicate complexity or blocking.",
    );
  });

  it("does not flag sessions under 24 hours for duration", () => {
    const { config } = makeConfig();
    const twentyHoursMs = 20 * 3_600_000;
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        ciAttempts: 0,
        reviewRounds: 0,
        duration: {
          startedAt: "2025-06-01T00:00:00.000Z",
          endedAt: "2025-06-01T20:00:00.000Z",
          totalMs: twentyHoursMs,
        },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons.some((l) => l.includes("Long-running sessions"))).toBe(false);
  });

  it("flags quick success (<1 hour, merged, no CI or review issues)", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        ciAttempts: 0,
        reviewRounds: 0,
        duration: {
          startedAt: "2025-06-01T10:00:00.000Z",
          endedAt: "2025-06-01T10:30:00.000Z",
          totalMs: 1_800_000, // 30 minutes
        },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons).toContain(
      "Clean execution: merged quickly with minimal CI/review iterations.",
    );
  });

  it("does not flag quick success when CI failed once", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        ciAttempts: 2,
        reviewRounds: 0,
        duration: {
          startedAt: "2025-06-01T10:00:00.000Z",
          endedAt: "2025-06-01T10:30:00.000Z",
          totalMs: 1_800_000,
        },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons.some((l) => l.includes("Clean execution"))).toBe(false);
  });

  it("does not flag quick success when not merged", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "active",
        ciAttempts: 0,
        reviewRounds: 0,
        duration: {
          startedAt: "2025-06-01T10:00:00.000Z",
          endedAt: "2025-06-01T10:30:00.000Z",
          totalMs: 1_800_000,
        },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons.some((l) => l.includes("Clean execution"))).toBe(false);
  });

  it("flags quick success under 2 hours threshold", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        ciAttempts: 1,
        reviewRounds: 1,
        duration: {
          startedAt: "2025-06-01T10:00:00.000Z",
          endedAt: "2025-06-01T11:30:00.000Z",
          totalMs: 5_400_000, // 1.5 hours
        },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons).toContain(
      "Clean execution: merged quickly with minimal CI/review iterations.",
    );
  });

  it("does not flag quick success at exactly 2 hours", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        ciAttempts: 0,
        reviewRounds: 0,
        duration: {
          startedAt: "2025-06-01T10:00:00.000Z",
          endedAt: "2025-06-01T12:00:00.000Z",
          totalMs: 7_200_000, // exactly 2 hours
        },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons.some((l) => l.includes("Clean execution"))).toBe(false);
  });

  it("flags killed without PR", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "killed",
        prUrl: null,
        ciAttempts: 0,
        reviewRounds: 0,
        duration: { startedAt: "2025-06-01T10:00:00.000Z", endedAt: "2025-06-01T11:00:00.000Z", totalMs: 3_600_000 },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons).toContain(
      "Session was killed without creating a PR. May indicate a stuck or misdirected session.",
    );
  });

  it("does not flag killed with PR", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "killed",
        prUrl: "https://github.com/org/repo/pull/42",
        ciAttempts: 0,
        reviewRounds: 0,
        duration: { startedAt: "2025-06-01T10:00:00.000Z", endedAt: "2025-06-01T11:00:00.000Z", totalMs: 3_600_000 },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons.some((l) => l.includes("killed without creating a PR"))).toBe(false);
  });

  it("flags no events recorded (empty timeline)", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "active",
        ciAttempts: 0,
        reviewRounds: 0,
        duration: { startedAt: "2025-06-01T10:00:00.000Z", endedAt: null, totalMs: 1_000 },
      },
      logEntries: [],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons).toContain(
      "No lifecycle events recorded. Session may have been very short-lived or logging was not active.",
    );
  });

  it("returns multiple lessons when multiple patterns match", () => {
    const { config } = makeConfig();
    const fiftyHoursMs = 50 * 3_600_000;
    setupGenerateMocks({
      reportCard: {
        outcome: "killed",
        prUrl: null,
        ciAttempts: 5,
        reviewRounds: 4,
        duration: {
          startedAt: "2025-06-01T00:00:00.000Z",
          endedAt: "2025-06-03T02:00:00.000Z",
          totalMs: fiftyHoursMs,
        },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    // Should have: high CI failure, multiple review rounds, long duration, killed without PR
    expect(result!.lessons).toContain(
      "High CI failure count (5 failures). Consider running tests locally before pushing.",
    );
    expect(result!.lessons).toContain(
      "Multiple review rounds (4). Breaking changes into smaller PRs may help.",
    );
    expect(result!.lessons).toContain(
      "Session ran for 50 hours. Long-running sessions may indicate complexity or blocking.",
    );
    expect(result!.lessons).toContain(
      "Session was killed without creating a PR. May indicate a stuck or misdirected session.",
    );
    expect(result!.lessons).toHaveLength(4);
  });

  it("returns empty lessons for a clean session (no issues)", () => {
    const { config } = makeConfig();
    setupGenerateMocks({
      reportCard: {
        outcome: "merged",
        prUrl: "https://github.com/org/repo/pull/42",
        ciAttempts: 0,
        reviewRounds: 0,
        duration: {
          startedAt: "2025-06-01T10:00:00.000Z",
          endedAt: "2025-06-01T14:00:00.000Z",
          totalMs: 14_400_000, // 4 hours (between 2h and 24h, so no quick success or duration flag)
        },
      },
      logEntries: [makeLogEntry()],
    });

    const result = generateRetrospective("test-1", config as never, "my-project");

    expect(result!.lessons).toEqual([]);
  });
});
