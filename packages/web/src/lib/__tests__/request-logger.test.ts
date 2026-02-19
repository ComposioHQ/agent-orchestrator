/**
 * Tests for request-logger: logApiRequest, getRequestStats, normalizePath, percentile.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { getRequestStats as GetRequestStatsFn } from "../request-logger.js";

// ── Mock fns (hoisted) ────────────────────────────────────────────────

const mockLoadConfig = vi.fn();
const mockGetLogsDir = vi.fn();
const mockReadLogsFromDir = vi.fn();
const mockLogWriterAppend = vi.fn();
const mockLogWriterClose = vi.fn();

/** Inline percentile impl (matches core's implementation) used in every mock below. */
function mockPercentileImpl(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Inline normalizeRoutePath impl (matches core's implementation) used in every mock below. */
function mockNormalizeRoutePathImpl(path: string): string {
  return path
    .replace(/\/sessions\/[^/]+/g, "/sessions/:id")
    .replace(/\/prs\/[^/]+/g, "/prs/:id");
}

vi.mock("@composio/ao-core", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  getLogsDir: (...args: unknown[]) => mockGetLogsDir(...args),
  readLogsFromDir: (...args: unknown[]) => mockReadLogsFromDir(...args),
  percentile: mockPercentileImpl,
  normalizeRoutePath: mockNormalizeRoutePathImpl,
  LogWriter: vi.fn().mockImplementation(() => ({
    append: mockLogWriterAppend,
    appendLine: vi.fn(),
    close: mockLogWriterClose,
  })),
}));

// ── Import after mocking ──────────────────────────────────────────────

// We need a fresh module for each describe block that tests logApiRequest
// because of the module-level logWriter cache. For getRequestStats tests,
// we can reuse the same import since it doesn't depend on the cached writer.

beforeEach(() => {
  vi.clearAllMocks();
});

// ── logApiRequest ─────────────────────────────────────────────────────

describe("logApiRequest", () => {
  beforeEach(() => {
    vi.resetModules();

    // Re-apply mock after resetModules (must include all imports from @composio/ao-core)
    vi.doMock("@composio/ao-core", () => ({
      loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
      getLogsDir: (...args: unknown[]) => mockGetLogsDir(...args),
      readLogsFromDir: (...args: unknown[]) => mockReadLogsFromDir(...args),
      percentile: mockPercentileImpl,
      normalizeRoutePath: mockNormalizeRoutePathImpl,
      LogWriter: vi.fn().mockImplementation(() => ({
        append: mockLogWriterAppend,
        appendLine: vi.fn(),
        close: mockLogWriterClose,
      })),
    }));
  });

  it("logs request with all required fields", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/config.yaml",
      projects: { myProject: { path: "/tmp/project" } },
    });
    mockGetLogsDir.mockReturnValue("/tmp/logs");

    const { logApiRequest } = await import("../request-logger.js");

    logApiRequest({
      ts: "2026-01-15T10:00:00Z",
      method: "GET",
      path: "/api/sessions",
      sessionId: null,
      statusCode: 200,
      durationMs: 42,
    });

    expect(mockLogWriterAppend).toHaveBeenCalledTimes(1);
    const entry = mockLogWriterAppend.mock.calls[0][0];
    expect(entry.ts).toBe("2026-01-15T10:00:00Z");
    expect(entry.level).toBe("info");
    expect(entry.source).toBe("api");
    expect(entry.sessionId).toBeNull();
    expect(entry.message).toBe("GET /api/sessions 200 42ms");
    expect(entry.data.method).toBe("GET");
    expect(entry.data.path).toBe("/api/sessions");
    expect(entry.data.statusCode).toBe(200);
    expect(entry.data.durationMs).toBe(42);
  });

  it("logs error level when error field is present", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/config.yaml",
      projects: { myProject: { path: "/tmp/project" } },
    });
    mockGetLogsDir.mockReturnValue("/tmp/logs");

    const { logApiRequest } = await import("../request-logger.js");

    logApiRequest({
      ts: "2026-01-15T10:00:00Z",
      method: "POST",
      path: "/api/spawn",
      sessionId: null,
      statusCode: 500,
      durationMs: 100,
      error: "spawn failed",
    });

    const entry = mockLogWriterAppend.mock.calls[0][0];
    expect(entry.level).toBe("error");
    expect(entry.data.error).toBe("spawn failed");
  });

  it("includes optional timings field when provided", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/config.yaml",
      projects: { myProject: { path: "/tmp/project" } },
    });
    mockGetLogsDir.mockReturnValue("/tmp/logs");

    const { logApiRequest } = await import("../request-logger.js");

    const timings = {
      serviceInit: 5,
      sessionList: 20,
      prEnrichment: 100,
    };

    logApiRequest({
      ts: "2026-01-15T10:00:00Z",
      method: "GET",
      path: "/api/sessions",
      sessionId: null,
      statusCode: 200,
      durationMs: 130,
      timings,
    });

    const entry = mockLogWriterAppend.mock.calls[0][0];
    expect(entry.data.timings).toEqual(timings);
  });

  it("includes optional cacheStats field when provided", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/config.yaml",
      projects: { myProject: { path: "/tmp/project" } },
    });
    mockGetLogsDir.mockReturnValue("/tmp/logs");

    const { logApiRequest } = await import("../request-logger.js");

    const cacheStats = { hits: 5, misses: 2, hitRate: 0.71, size: 10 };

    logApiRequest({
      ts: "2026-01-15T10:00:00Z",
      method: "GET",
      path: "/api/sessions",
      sessionId: null,
      statusCode: 200,
      durationMs: 50,
      cacheStats,
    });

    const entry = mockLogWriterAppend.mock.calls[0][0];
    expect(entry.data.cacheStats).toEqual(cacheStats);
  });

  it("omits optional fields from data when not provided", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/config.yaml",
      projects: { myProject: { path: "/tmp/project" } },
    });
    mockGetLogsDir.mockReturnValue("/tmp/logs");

    const { logApiRequest } = await import("../request-logger.js");

    logApiRequest({
      ts: "2026-01-15T10:00:00Z",
      method: "GET",
      path: "/api/sessions",
      sessionId: null,
      statusCode: 200,
      durationMs: 42,
    });

    const entry = mockLogWriterAppend.mock.calls[0][0];
    expect(entry.data).not.toHaveProperty("error");
    expect(entry.data).not.toHaveProperty("timings");
    expect(entry.data).not.toHaveProperty("cacheStats");
  });

  it("handles missing logDir gracefully (no projects)", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/config.yaml",
      projects: {},
    });

    const { logApiRequest } = await import("../request-logger.js");

    // Should not throw
    logApiRequest({
      ts: "2026-01-15T10:00:00Z",
      method: "GET",
      path: "/api/sessions",
      sessionId: null,
      statusCode: 200,
      durationMs: 42,
    });

    expect(mockLogWriterAppend).not.toHaveBeenCalled();
  });

  it("handles loadConfig throwing an error gracefully", async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("No config file found");
    });

    const { logApiRequest } = await import("../request-logger.js");

    // Should not throw
    logApiRequest({
      ts: "2026-01-15T10:00:00Z",
      method: "GET",
      path: "/api/sessions",
      sessionId: null,
      statusCode: 200,
      durationMs: 42,
    });

    expect(mockLogWriterAppend).not.toHaveBeenCalled();
  });

  it("caches the LogWriter after first successful initialization", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/config.yaml",
      projects: { myProject: { path: "/tmp/project" } },
    });
    mockGetLogsDir.mockReturnValue("/tmp/logs");

    const { logApiRequest } = await import("../request-logger.js");

    logApiRequest({
      ts: "2026-01-15T10:00:00Z",
      method: "GET",
      path: "/api/sessions",
      sessionId: null,
      statusCode: 200,
      durationMs: 42,
    });

    logApiRequest({
      ts: "2026-01-15T10:01:00Z",
      method: "GET",
      path: "/api/sessions",
      sessionId: null,
      statusCode: 200,
      durationMs: 55,
    });

    // loadConfig should only be called once (writer is cached)
    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
    // But append should be called twice
    expect(mockLogWriterAppend).toHaveBeenCalledTimes(2);
  });

  it("includes sessionId in log entry", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/config.yaml",
      projects: { myProject: { path: "/tmp/project" } },
    });
    mockGetLogsDir.mockReturnValue("/tmp/logs");

    const { logApiRequest } = await import("../request-logger.js");

    logApiRequest({
      ts: "2026-01-15T10:00:00Z",
      method: "GET",
      path: "/api/sessions/ao-5",
      sessionId: "ao-5",
      statusCode: 200,
      durationMs: 42,
    });

    const entry = mockLogWriterAppend.mock.calls[0][0];
    expect(entry.sessionId).toBe("ao-5");
  });
});

// ── getRequestStats ───────────────────────────────────────────────────

describe("getRequestStats", () => {
  // getRequestStats calls readLogsFromDir directly, no cached writer involved
  let getRequestStats: GetRequestStatsFn;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("@composio/ao-core", () => ({
      loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
      getLogsDir: (...args: unknown[]) => mockGetLogsDir(...args),
      readLogsFromDir: (...args: unknown[]) => mockReadLogsFromDir(...args),
      percentile: mockPercentileImpl,
      normalizeRoutePath: mockNormalizeRoutePathImpl,
      LogWriter: vi.fn().mockImplementation(() => ({
        append: mockLogWriterAppend,
        appendLine: vi.fn(),
        close: mockLogWriterClose,
      })),
    }));

    const mod = await import("../request-logger.js");
    getRequestStats = mod.getRequestStats;
  });

  it("computes per-route stats with count, avgMs, percentiles", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/sessions", 200, 100),
      makeLogEntry("GET", "/api/sessions", 200, 200),
      makeLogEntry("GET", "/api/sessions", 200, 300),
      makeLogEntry("GET", "/api/sessions", 200, 400),
    ]);

    const result = getRequestStats("/tmp/logs");

    const route = result.routes["GET /api/sessions"];
    expect(route).toBeDefined();
    expect(route.count).toBe(4);
    expect(route.avgMs).toBe(250); // (100+200+300+400)/4
    expect(route.errors).toBe(0);
  });

  it("counts errors when statusCode >= 400", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/sessions", 200, 100),
      makeLogEntry("GET", "/api/sessions", 400, 50),
      makeLogEntry("GET", "/api/sessions", 500, 200),
    ]);

    const result = getRequestStats("/tmp/logs");

    const route = result.routes["GET /api/sessions"];
    expect(route.errors).toBe(2);
  });

  it("counts errors when error field is present", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("POST", "/api/spawn", 200, 100, "something went wrong"),
    ]);

    const result = getRequestStats("/tmp/logs");

    const route = result.routes["POST /api/spawn"];
    expect(route.errors).toBe(1);
  });

  it("groups by normalized path (dynamic segments replaced)", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/sessions/abc123", 200, 100),
      makeLogEntry("GET", "/api/sessions/def456", 200, 200),
      makeLogEntry("GET", "/api/prs/42/merge", 200, 50),
      makeLogEntry("GET", "/api/prs/99/merge", 200, 150),
    ]);

    const result = getRequestStats("/tmp/logs");

    // Both session paths should be grouped under :id
    expect(result.routes["GET /api/sessions/:id"]).toBeDefined();
    expect(result.routes["GET /api/sessions/:id"].count).toBe(2);

    // Both PR paths should be grouped under :id
    expect(result.routes["GET /api/prs/:id/merge"]).toBeDefined();
    expect(result.routes["GET /api/prs/:id/merge"].count).toBe(2);

    // Original paths should NOT exist as separate routes
    expect(result.routes["GET /api/sessions/abc123"]).toBeUndefined();
    expect(result.routes["GET /api/prs/42/merge"]).toBeUndefined();
  });

  it("returns slowest requests sorted by duration (descending)", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/sessions", 200, 50),
      makeLogEntry("GET", "/api/sessions", 200, 3000),
      makeLogEntry("GET", "/api/sessions", 200, 500),
    ]);

    const result = getRequestStats("/tmp/logs");

    expect(result.slowest).toHaveLength(3);
    expect(result.slowest[0].durationMs).toBe(3000);
    expect(result.slowest[1].durationMs).toBe(500);
    expect(result.slowest[2].durationMs).toBe(50);
  });

  it("limits slowest to 10 entries", () => {
    const entries = [];
    for (let i = 0; i < 15; i++) {
      entries.push(makeLogEntry("GET", "/api/sessions", 200, (i + 1) * 10));
    }
    mockReadLogsFromDir.mockReturnValue(entries);

    const result = getRequestStats("/tmp/logs");

    expect(result.slowest).toHaveLength(10);
    // The slowest should be 150ms (15*10), not 10ms (1*10)
    expect(result.slowest[0].durationMs).toBe(150);
  });

  it("handles empty log directory (no entries)", () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const result = getRequestStats("/tmp/logs");

    expect(result.routes).toEqual({});
    expect(result.slowest).toEqual([]);
  });

  it("passes since filter to readLogsFromDir", () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const since = new Date("2026-01-15T00:00:00Z");
    getRequestStats("/tmp/logs", { since });

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/logs",
      "api",
      expect.objectContaining({ since }),
    );
  });

  it("filters by route pattern", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/sessions", 200, 100),
      makeLogEntry("GET", "/api/prs", 200, 200),
      makeLogEntry("POST", "/api/sessions/abc/kill", 200, 50),
    ]);

    const result = getRequestStats("/tmp/logs", { route: "sessions" });

    // Only routes containing "sessions" should be included
    expect(Object.keys(result.routes)).toEqual(
      expect.arrayContaining(["GET /api/sessions"]),
    );
    expect(result.routes["GET /api/prs"]).toBeUndefined();
    expect(result.slowest.every((r) => r.path.includes("sessions"))).toBe(true);
  });

  it("skips entries without method or path in data", () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2026-01-15T10:00:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "some log without method/path",
        data: { statusCode: 200, durationMs: 50 },
      },
      makeLogEntry("GET", "/api/sessions", 200, 100),
    ]);

    const result = getRequestStats("/tmp/logs");

    expect(Object.keys(result.routes)).toHaveLength(1);
    expect(result.routes["GET /api/sessions"].count).toBe(1);
  });

  it("handles entries with missing data object", () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2026-01-15T10:00:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "bare entry",
      },
      makeLogEntry("GET", "/api/sessions", 200, 100),
    ]);

    const result = getRequestStats("/tmp/logs");

    expect(Object.keys(result.routes)).toHaveLength(1);
  });

  it("separates routes by HTTP method", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/sessions", 200, 100),
      makeLogEntry("POST", "/api/sessions", 201, 200),
    ]);

    const result = getRequestStats("/tmp/logs");

    expect(result.routes["GET /api/sessions"]).toBeDefined();
    expect(result.routes["POST /api/sessions"]).toBeDefined();
    expect(result.routes["GET /api/sessions"].count).toBe(1);
    expect(result.routes["POST /api/sessions"].count).toBe(1);
  });
});

// ── normalizePath (tested indirectly via getRequestStats) ─────────────

describe("normalizePath (indirect)", () => {
  let getRequestStats: GetRequestStatsFn;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("@composio/ao-core", () => ({
      loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
      getLogsDir: (...args: unknown[]) => mockGetLogsDir(...args),
      readLogsFromDir: (...args: unknown[]) => mockReadLogsFromDir(...args),
      percentile: mockPercentileImpl,
      normalizeRoutePath: mockNormalizeRoutePathImpl,
      LogWriter: vi.fn().mockImplementation(() => ({
        append: mockLogWriterAppend,
        appendLine: vi.fn(),
        close: mockLogWriterClose,
      })),
    }));

    const mod = await import("../request-logger.js");
    getRequestStats = mod.getRequestStats;
  });

  it("/api/sessions/abc123 normalizes to /api/sessions/:id", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/sessions/abc123", 200, 100),
    ]);

    const result = getRequestStats("/tmp/logs");
    expect(result.routes["GET /api/sessions/:id"]).toBeDefined();
  });

  it("/api/prs/42/merge normalizes to /api/prs/:id/merge", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/prs/42/merge", 200, 100),
    ]);

    const result = getRequestStats("/tmp/logs");
    expect(result.routes["GET /api/prs/:id/merge"]).toBeDefined();
  });

  it("/api/sessions remains unchanged (no dynamic segment)", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/sessions", 200, 100),
    ]);

    const result = getRequestStats("/tmp/logs");
    expect(result.routes["GET /api/sessions"]).toBeDefined();
  });

  it("normalizes multiple dynamic segments in one path", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/sessions/abc123/prs/42", 200, 100),
    ]);

    const result = getRequestStats("/tmp/logs");
    // sessions/:id and prs/:id should both be replaced
    expect(result.routes["GET /api/sessions/:id/prs/:id"]).toBeDefined();
  });

  it("non-matching paths remain unchanged", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/config", 200, 100),
    ]);

    const result = getRequestStats("/tmp/logs");
    expect(result.routes["GET /api/config"]).toBeDefined();
  });
});

// ── percentile (tested indirectly via getRequestStats) ────────────────

describe("percentile (indirect)", () => {
  let getRequestStats: GetRequestStatsFn;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("@composio/ao-core", () => ({
      loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
      getLogsDir: (...args: unknown[]) => mockGetLogsDir(...args),
      readLogsFromDir: (...args: unknown[]) => mockReadLogsFromDir(...args),
      percentile: mockPercentileImpl,
      normalizeRoutePath: mockNormalizeRoutePathImpl,
      LogWriter: vi.fn().mockImplementation(() => ({
        append: mockLogWriterAppend,
        appendLine: vi.fn(),
        close: mockLogWriterClose,
      })),
    }));

    const mod = await import("../request-logger.js");
    getRequestStats = mod.getRequestStats;
  });

  it("returns 0 for empty array (no entries)", () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const result = getRequestStats("/tmp/logs");

    // No routes means no percentiles to check, but verify no crash
    expect(result.routes).toEqual({});
  });

  it("returns the single element for single-entry route", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/sessions", 200, 42),
    ]);

    const result = getRequestStats("/tmp/logs");
    const route = result.routes["GET /api/sessions"];
    expect(route.p50Ms).toBe(42);
    expect(route.p95Ms).toBe(42);
    expect(route.p99Ms).toBe(42);
  });

  it("computes correct p50 for two elements", () => {
    mockReadLogsFromDir.mockReturnValue([
      makeLogEntry("GET", "/api/sessions", 200, 100),
      makeLogEntry("GET", "/api/sessions", 200, 200),
    ]);

    const result = getRequestStats("/tmp/logs");
    const route = result.routes["GET /api/sessions"];
    // sorted: [100, 200]
    // p50: ceil(50/100 * 2) - 1 = ceil(1) - 1 = 0 => sorted[0] = 100
    expect(route.p50Ms).toBe(100);
    // p95: ceil(95/100 * 2) - 1 = ceil(1.9) - 1 = 1 => sorted[1] = 200
    expect(route.p95Ms).toBe(200);
    // p99: ceil(99/100 * 2) - 1 = ceil(1.98) - 1 = 1 => sorted[1] = 200
    expect(route.p99Ms).toBe(200);
  });

  it("computes correct percentiles for a larger dataset", () => {
    // 100 entries with durations 1..100
    const entries = [];
    for (let i = 1; i <= 100; i++) {
      entries.push(makeLogEntry("GET", "/api/sessions", 200, i));
    }
    mockReadLogsFromDir.mockReturnValue(entries);

    const result = getRequestStats("/tmp/logs");
    const route = result.routes["GET /api/sessions"];

    expect(route.count).toBe(100);
    // p50: ceil(50/100 * 100) - 1 = 50 - 1 = 49 => sorted[49] = 50
    expect(route.p50Ms).toBe(50);
    // p95: ceil(95/100 * 100) - 1 = 95 - 1 = 94 => sorted[94] = 95
    expect(route.p95Ms).toBe(95);
    // p99: ceil(99/100 * 100) - 1 = 99 - 1 = 98 => sorted[98] = 99
    expect(route.p99Ms).toBe(99);
    expect(route.avgMs).toBe(51); // Math.round(5050 / 100) = 51 (rounded up from 50.5)
  });
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeLogEntry(
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
  error?: string,
) {
  return {
    ts: "2026-01-15T10:00:00Z",
    level: error ? "error" : "info",
    source: "api",
    sessionId: null,
    message: `${method} ${path} ${statusCode} ${durationMs}ms`,
    data: {
      method,
      path,
      statusCode,
      durationMs,
      ...(error && { error }),
    },
  };
}
