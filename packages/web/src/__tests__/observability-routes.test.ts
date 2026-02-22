import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock fns ────────────────────────────────────────────────────────────

const mockReadLogsFromDir = vi.fn();
const mockTailLogs = vi.fn();
const mockResolveProjectLogDir = vi.fn();
const mockLoadConfig = vi.fn();
const mockLogWriterAppend = vi.fn();
const mockGetRequestStats = vi.fn();

vi.mock("@composio/ao-core", () => ({
  resolveProjectLogDir: (...args: unknown[]) => mockResolveProjectLogDir(...args),
  readLogsFromDir: (...args: unknown[]) => mockReadLogsFromDir(...args),
  tailLogs: (...args: unknown[]) => mockTailLogs(...args),
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  LogWriter: vi.fn().mockImplementation(() => ({
    append: mockLogWriterAppend,
    appendLine: vi.fn(),
    close: vi.fn(),
  })),
}));

// Mock request-logger.js at the module boundary — perf/route.ts delegates
// to getRequestStats, so we test the HTTP contract without re-implementing core logic.
vi.mock("../lib/request-logger.js", () => ({
  getRequestStats: (...args: unknown[]) => mockGetRequestStats(...args),
  logApiRequest: vi.fn(),
}));

// ── Import routes after mocking ─────────────────────────────────────────

const { GET: logsGET } = await import("../app/api/logs/route.js");
const { GET: perfGET } = await import("../app/api/perf/route.js");
const { POST: clientLogsPost } = await import("../app/api/client-logs/route.js");

// ── Helpers ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({});
  mockResolveProjectLogDir.mockReturnValue("/tmp/test-logs");
  mockGetRequestStats.mockReturnValue({ routes: {}, slowest: [], latestCacheStats: null });
});

// ── GET /api/logs ───────────────────────────────────────────────────────

describe("GET /api/logs", () => {
  it("returns entries when logs exist", async () => {
    const fakeEntries = [
      {
        ts: "2026-01-01T00:00:00Z",
        level: "info",
        source: "events",
        sessionId: null,
        message: "session spawned",
      },
      {
        ts: "2026-01-01T00:01:00Z",
        level: "warn",
        source: "events",
        sessionId: "s-1",
        message: "timeout",
      },
    ];
    mockReadLogsFromDir.mockReturnValue(fakeEntries);

    const req = new Request("http://localhost:3000/api/logs?limit=100");
    const res = await logsGET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.entries).toHaveLength(2);
    expect(json.count).toBe(2);
    expect(json.entries[0].message).toBe("session spawned");
  });

  it("applies source filter (maps to file prefix)", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request("http://localhost:3000/api/logs?source=api&limit=50");
    await logsGET(req);

    // readLogsFromDir should be called with the log dir and prefix "api"
    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "api",
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("defaults source to events when not specified", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request("http://localhost:3000/api/logs");
    await logsGET(req);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "events",
      expect.any(Object),
    );
  });

  it("applies tail parameter (calls tailLogs instead of readLogsFromDir)", async () => {
    const tailEntries = [
      {
        ts: "2026-01-01T00:05:00Z",
        level: "info",
        source: "events",
        sessionId: null,
        message: "last line",
      },
    ];
    mockTailLogs.mockReturnValue(tailEntries);

    const req = new Request("http://localhost:3000/api/logs?tail=10");
    const res = await logsGET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0].message).toBe("last line");

    // tailLogs should be called, NOT readLogsFromDir
    expect(mockTailLogs).toHaveBeenCalledWith("/tmp/test-logs/events.jsonl", 10);
    expect(mockReadLogsFromDir).not.toHaveBeenCalled();
  });

  it("returns 500 when config has no projects", async () => {
    mockResolveProjectLogDir.mockReturnValue(null);
    // resolveLogDir() will throw "No projects configured."

    const req = new Request("http://localhost:3000/api/logs");
    const res = await logsGET(req);
    expect(res.status).toBe(500);

    const json = await res.json();
    expect(json.error).toMatch(/No projects configured/);
  });

  it("passes since parameter as a Date object to query options", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/logs?since=2026-01-15T10:00:00Z",
    );
    await logsGET(req);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "events",
      expect.objectContaining({
        since: new Date("2026-01-15T10:00:00Z"),
        limit: 200,
      }),
    );
  });

  it("parses comma-separated level parameter into an array", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/logs?level=info,warn,error",
    );
    await logsGET(req);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "events",
      expect.objectContaining({
        level: ["info", "warn", "error"],
      }),
    );
  });

  it("passes sessionId parameter to query options", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/logs?sessionId=backend-3",
    );
    await logsGET(req);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "events",
      expect.objectContaining({
        sessionId: "backend-3",
      }),
    );
  });

  it("applies combined filters (source + level + since)", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/logs?source=dashboard&level=error,warn&since=2026-02-01T00:00:00Z&limit=50",
    );
    await logsGET(req);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "dashboard",
      {
        since: new Date("2026-02-01T00:00:00Z"),
        level: ["error", "warn"],
        limit: 50,
      },
    );
  });

  it("handles non-numeric limit parameter gracefully (defaults to NaN)", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/logs?limit=notanumber",
    );
    await logsGET(req);

    // parseInt("notanumber", 10) returns NaN — still passed to readLogsFromDir
    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "events",
      expect.objectContaining({ limit: NaN }),
    );
  });

  it("handles non-numeric tail parameter gracefully", async () => {
    mockTailLogs.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/logs?tail=abc",
    );
    const res = await logsGET(req);
    expect(res.status).toBe(200);

    // parseInt("abc", 10) returns NaN — still calls tailLogs with NaN
    expect(mockTailLogs).toHaveBeenCalledWith(
      "/tmp/test-logs/events.jsonl",
      NaN,
    );
    expect(mockReadLogsFromDir).not.toHaveBeenCalled();
  });
});

// ── GET /api/perf ───────────────────────────────────────────────────────
//
// perf/route.ts delegates to getRequestStats (mocked above).
// These tests verify the HTTP contract: JSON shape, URL param forwarding,
// totalRequests aggregation, and error handling. Core logic (parseApiLogs,
// computeApiStats, route normalization) is tested in @composio/ao-core.

describe("GET /api/perf", () => {
  it("returns 200 with routes, slowest, cacheStats, and totalRequests", async () => {
    mockGetRequestStats.mockReturnValue({
      routes: {
        "GET /api/sessions": { count: 2, avgMs: 200, p50Ms: 150, p95Ms: 500, p99Ms: 800, errors: 0 },
        "POST /api/spawn": { count: 1, avgMs: 3000, p50Ms: 3000, p95Ms: 3000, p99Ms: 3000, errors: 1 },
      },
      slowest: [
        { method: "POST", path: "/api/spawn", durationMs: 3000 },
        { method: "GET", path: "/api/sessions", durationMs: 250 },
      ],
      latestCacheStats: { hits: 10, misses: 2, hitRate: 0.83, size: 12 },
    });

    const req = new Request("http://localhost:3000/api/perf");
    const res = await perfGET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.routes["GET /api/sessions"].count).toBe(2);
    expect(json.routes["POST /api/spawn"].errors).toBe(1);
    expect(json.slowest).toHaveLength(2);
    expect(json.cacheStats).toEqual({ hits: 10, misses: 2, hitRate: 0.83, size: 12 });
    expect(json.totalRequests).toBe(3); // 2 + 1
  });

  it("computes totalRequests as sum of all route counts", async () => {
    mockGetRequestStats.mockReturnValue({
      routes: {
        "GET /api/sessions": { count: 5, avgMs: 100, p50Ms: 90, p95Ms: 200, p99Ms: 300, errors: 0 },
        "GET /api/sessions/:id": { count: 3, avgMs: 50, p50Ms: 45, p95Ms: 80, p99Ms: 100, errors: 0 },
        "POST /api/spawn": { count: 2, avgMs: 2000, p50Ms: 1800, p95Ms: 3000, p99Ms: 3000, errors: 1 },
      },
      slowest: [],
      latestCacheStats: null,
    });

    const req = new Request("http://localhost:3000/api/perf");
    const res = await perfGET(req);
    const json = await res.json();
    expect(json.totalRequests).toBe(10); // 5 + 3 + 2
  });

  it("returns empty stats shape when getRequestStats returns nothing", async () => {
    // default beforeEach mock already returns empty stats
    const req = new Request("http://localhost:3000/api/perf");
    const res = await perfGET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.routes).toEqual({});
    expect(json.slowest).toEqual([]);
    expect(json.cacheStats).toBeNull();
    expect(json.totalRequests).toBe(0);
  });

  it("returns 500 when no projects configured", async () => {
    mockResolveProjectLogDir.mockReturnValue(null);

    const req = new Request("http://localhost:3000/api/perf");
    const res = await perfGET(req);
    expect(res.status).toBe(500);

    const json = await res.json();
    expect(json.error).toMatch(/No projects configured/);
  });

  it("forwards since param as Date to getRequestStats", async () => {
    const req = new Request("http://localhost:3000/api/perf?since=2026-02-01T12:00:00Z");
    await perfGET(req);

    expect(mockGetRequestStats).toHaveBeenCalledWith(
      "/tmp/test-logs",
      expect.objectContaining({ since: new Date("2026-02-01T12:00:00Z") }),
    );
  });

  it("forwards route param to getRequestStats", async () => {
    const req = new Request("http://localhost:3000/api/perf?route=sessions");
    await perfGET(req);

    expect(mockGetRequestStats).toHaveBeenCalledWith(
      "/tmp/test-logs",
      expect.objectContaining({ route: "sessions" }),
    );
  });

  it("passes both since and route when both provided", async () => {
    const req = new Request("http://localhost:3000/api/perf?since=2026-01-01T00:00:00Z&route=spawn");
    await perfGET(req);

    expect(mockGetRequestStats).toHaveBeenCalledWith(
      "/tmp/test-logs",
      { since: new Date("2026-01-01T00:00:00Z"), route: "spawn" },
    );
  });
});

// ── POST /api/client-logs ───────────────────────────────────────────────

describe("POST /api/client-logs", () => {
  it("returns 400 when body has no entries array", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({ something: "else" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toMatch(/Missing entries/);
  });

  it("returns 400 when body is not an object", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify("just a string"),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toMatch(/Invalid request/);
  });

  it("returns 400 when body is invalid JSON", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: "not json at all",
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(400);
  });

  it("logs valid entries and skips invalid ones", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          { level: "info", message: "page loaded", url: "/dashboard" },
          { level: "error", message: "fetch failed", stack: "Error: 500\n  at ..." },
          { level: "invalid-level", message: "bad level" }, // invalid: level not in set
          { notAMessage: true }, // invalid: no message field
          { level: "warn", message: "slow render", timing: { ttfb: 120 } },
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.logged).toBe(3); // info, error, warn are valid; 2 invalid skipped

    // Verify append was called 3 times with correct structure
    expect(mockLogWriterAppend).toHaveBeenCalledTimes(3);

    // Check first call (info entry)
    const firstCall = mockLogWriterAppend.mock.calls[0][0];
    expect(firstCall.level).toBe("info");
    expect(firstCall.source).toBe("browser");
    expect(firstCall.message).toBe("page loaded");
    expect(firstCall.data).toEqual({ url: "/dashboard" });

    // Check second call (error entry with stack)
    const secondCall = mockLogWriterAppend.mock.calls[1][0];
    expect(secondCall.level).toBe("error");
    expect(secondCall.message).toBe("fetch failed");
    expect(secondCall.data).toHaveProperty("stack");

    // Check third call (warn entry with timing)
    const thirdCall = mockLogWriterAppend.mock.calls[2][0];
    expect(thirdCall.level).toBe("warn");
    expect(thirdCall.message).toBe("slow render");
    expect(thirdCall.data).toEqual({ timing: { ttfb: 120 } });
  });

  it("returns logged: 0 when writer is unavailable", async () => {
    mockResolveProjectLogDir.mockReturnValue(null);

    // Force re-import to reset the cached logWriter
    // Since logWriter is module-level, we need a fresh module
    vi.resetModules();

    // Re-apply the mock after resetModules
    vi.doMock("@composio/ao-core", () => ({
      resolveProjectLogDir: () => null,
      loadConfig: () => ({}),
      LogWriter: vi.fn().mockImplementation(() => ({
        append: mockLogWriterAppend,
        appendLine: vi.fn(),
        close: vi.fn(),
      })),
    }));

    const { POST: freshPost } = await import("../app/api/client-logs/route.js");

    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({
        entries: [{ level: "info", message: "test" }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await freshPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.logged).toBe(0);
  });

  it("returns correct count for empty entries array", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({ entries: [] }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.logged).toBe(0);
  });

  it("includes optional fields (url, stack, timing) in data when present", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          {
            level: "error",
            message: "API call failed",
            url: "/api/sessions",
            stack: "TypeError: fetch failed\n  at fetchSessions (app.js:42)",
            timing: { fetchMs: 2500, renderMs: 12 },
          },
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.logged).toBe(1);

    const call = mockLogWriterAppend.mock.calls[0][0];
    expect(call.level).toBe("error");
    expect(call.message).toBe("API call failed");
    expect(call.data).toEqual({
      url: "/api/sessions",
      stack: "TypeError: fetch failed\n  at fetchSessions (app.js:42)",
      timing: { fetchMs: 2500, renderMs: 12 },
    });
  });

  it("omits optional fields from data when they are falsy", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          {
            level: "info",
            message: "page loaded",
            url: undefined,
            stack: null,
            timing: undefined,
          },
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.logged).toBe(1);

    // Falsy optional fields should not appear in data
    const call = mockLogWriterAppend.mock.calls[0][0];
    expect(call.data).toEqual({});
    expect(call.data).not.toHaveProperty("url");
    expect(call.data).not.toHaveProperty("stack");
    expect(call.data).not.toHaveProperty("timing");
  });

  it("logs multiple valid entries in a batch and returns correct count", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          { level: "info", message: "page loaded" },
          { level: "warn", message: "slow render" },
          { level: "error", message: "crash detected" },
          { level: "info", message: "navigation complete" },
          { level: "warn", message: "memory high" },
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.logged).toBe(5);
    expect(mockLogWriterAppend).toHaveBeenCalledTimes(5);

    // Verify each call has source: "browser" and sessionId: null
    for (let i = 0; i < 5; i++) {
      const call = mockLogWriterAppend.mock.calls[i][0];
      expect(call.source).toBe("browser");
      expect(call.sessionId).toBeNull();
      expect(call.ts).toBeDefined();
    }
  });

  it("accepts a mix of valid and invalid entries (partial acceptance)", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          { level: "info", message: "good entry 1" },            // valid
          { level: "debug", message: "bad level" },               // invalid: "debug" not in VALID_LEVELS
          { level: "error", message: "good entry 2" },            // valid
          42,                                                      // invalid: not an object
          null,                                                    // invalid: null
          { level: "warn" },                                      // invalid: no message
          { message: "no level" },                                // invalid: no level
          { level: "warn", message: "good entry 3" },             // valid
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.logged).toBe(3); // Only 3 valid entries

    expect(mockLogWriterAppend).toHaveBeenCalledTimes(3);
    expect(mockLogWriterAppend.mock.calls[0][0].message).toBe("good entry 1");
    expect(mockLogWriterAppend.mock.calls[1][0].message).toBe("good entry 2");
    expect(mockLogWriterAppend.mock.calls[2][0].message).toBe("good entry 3");
  });
});
