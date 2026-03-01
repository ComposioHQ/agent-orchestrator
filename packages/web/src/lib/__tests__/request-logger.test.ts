/**
 * Tests for request-logger: logApiRequest (write path) and getRequestStats (delegation).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock fns (hoisted) ────────────────────────────────────────────────

const mockLoadConfig = vi.fn();
const mockGetLogsDir = vi.fn();
const mockParseApiLogs = vi.fn();
const mockComputeApiStats = vi.fn();
const mockLogWriterAppend = vi.fn();
const mockLogWriterClose = vi.fn();

vi.mock("@composio/ao-core", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  getLogsDir: (...args: unknown[]) => mockGetLogsDir(...args),
  parseApiLogs: (...args: unknown[]) => mockParseApiLogs(...args),
  computeApiStats: (...args: unknown[]) => mockComputeApiStats(...args),
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
      parseApiLogs: (...args: unknown[]) => mockParseApiLogs(...args),
      computeApiStats: (...args: unknown[]) => mockComputeApiStats(...args),
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
//
// getRequestStats is a thin delegation wrapper around parseApiLogs + computeApiStats.
// The logic is tested in @composio/ao-core's log-reader.test.ts. Here we only
// verify the delegation contract.

describe("getRequestStats", () => {
  let getRequestStats: (logDir: string, opts?: { since?: Date; route?: string }) => unknown;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("@composio/ao-core", () => ({
      loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
      getLogsDir: (...args: unknown[]) => mockGetLogsDir(...args),
      parseApiLogs: (...args: unknown[]) => mockParseApiLogs(...args),
      computeApiStats: (...args: unknown[]) => mockComputeApiStats(...args),
      LogWriter: vi.fn().mockImplementation(() => ({
        append: mockLogWriterAppend,
        appendLine: vi.fn(),
        close: mockLogWriterClose,
      })),
    }));

    const mod = await import("../request-logger.js");
    getRequestStats = mod.getRequestStats;
  });

  it("delegates: calls parseApiLogs then computeApiStats, returns result", () => {
    const fakeEntries = [{ method: "GET", path: "/api/sessions", statusCode: 200, durationMs: 42 }];
    const fakeResult = { routes: { "GET /api/sessions": { count: 1 } }, slowest: [], latestCacheStats: null };
    mockParseApiLogs.mockReturnValue(fakeEntries);
    mockComputeApiStats.mockReturnValue(fakeResult);

    const result = getRequestStats("/tmp/logs");

    expect(mockParseApiLogs).toHaveBeenCalledWith("/tmp/logs", undefined);
    expect(mockComputeApiStats).toHaveBeenCalledWith(fakeEntries);
    expect(result).toBe(fakeResult);
  });

  it("forwards since and route options to parseApiLogs", () => {
    mockParseApiLogs.mockReturnValue([]);
    mockComputeApiStats.mockReturnValue({ routes: {}, slowest: [], latestCacheStats: null });

    const since = new Date("2026-01-15T00:00:00Z");
    getRequestStats("/tmp/logs", { since, route: "sessions" });

    expect(mockParseApiLogs).toHaveBeenCalledWith("/tmp/logs", { since, route: "sessions" });
  });

  it("returns computeApiStats result unchanged", () => {
    const expected = {
      routes: { "GET /api/sessions": { count: 5, avgMs: 100, p50Ms: 90, p95Ms: 200, p99Ms: 300, errors: 0 } },
      slowest: [],
      latestCacheStats: { hits: 10, misses: 2, hitRate: 0.83, size: 12 },
    };
    mockParseApiLogs.mockReturnValue([]);
    mockComputeApiStats.mockReturnValue(expected);

    const result = getRequestStats("/tmp/logs");

    expect(result).toBe(expected);
  });
});
