/**
 * Tests for with-timing: withTiming, extractSessionId, createTimingContext.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock logApiRequest from request-logger ────────────────────────────

const mockLogApiRequest = vi.fn();

vi.mock("../request-logger.js", () => ({
  logApiRequest: (...args: unknown[]) => mockLogApiRequest(...args),
}));

// ── Import after mocking ──────────────────────────────────────────────

import { withTiming, createTimingContext } from "../with-timing.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── withTiming ────────────────────────────────────────────────────────

describe("withTiming", () => {
  it("wraps handler and calls it with the request", async () => {
    const innerHandler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/sessions");
    await wrapped(req);

    expect(innerHandler).toHaveBeenCalledTimes(1);
    expect(innerHandler).toHaveBeenCalledWith(req, undefined);
  });

  it("passes context argument through to handler", async () => {
    const innerHandler = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const ctx = { params: { id: "abc" } };

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/sessions/abc");
    await wrapped(req, ctx);

    expect(innerHandler).toHaveBeenCalledWith(req, ctx);
  });

  it("returns the original response unchanged on success", async () => {
    const body = JSON.stringify({ sessions: [] });
    const originalResponse = new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const innerHandler = vi.fn().mockResolvedValue(originalResponse);

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/sessions");
    const result = await wrapped(req);

    expect(result).toBe(originalResponse);
    expect(result.status).toBe(200);
  });

  it("calls logApiRequest with correct fields for successful response", async () => {
    const innerHandler = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/sessions");
    await wrapped(req);

    expect(mockLogApiRequest).toHaveBeenCalledTimes(1);
    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.method).toBe("GET");
    expect(log.path).toBe("/api/sessions");
    expect(log.statusCode).toBe(200);
    expect(typeof log.durationMs).toBe("number");
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
    expect(log.error).toBeUndefined();
    expect(log.ts).toBeDefined();
    expect(typeof log.ts).toBe("string");
  });

  it("logs correct method for POST requests", async () => {
    const innerHandler = vi.fn().mockResolvedValue(
      new Response("created", { status: 201 }),
    );

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/spawn", {
      method: "POST",
      body: JSON.stringify({ session: "ao-1" }),
    });
    await wrapped(req);

    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.method).toBe("POST");
    expect(log.statusCode).toBe(201);
  });

  it("logs error responses (4xx) without error field", async () => {
    const innerHandler = vi.fn().mockResolvedValue(
      new Response("not found", { status: 404 }),
    );

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/sessions/unknown");
    await wrapped(req);

    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.statusCode).toBe(404);
    // error field is only set when the handler throws, not for error status codes
    expect(log.error).toBeUndefined();
  });

  it("logs error responses (5xx) without error field when handler does not throw", async () => {
    const innerHandler = vi.fn().mockResolvedValue(
      new Response("internal error", { status: 500 }),
    );

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/sessions");
    await wrapped(req);

    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.statusCode).toBe(500);
    expect(log.error).toBeUndefined();
  });

  it("catches thrown errors, logs them, and returns 500 response", async () => {
    const innerHandler = vi.fn().mockRejectedValue(
      new Error("database connection failed"),
    );

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/sessions");
    const result = await wrapped(req);

    // Should return a 500 response with the error
    expect(result.status).toBe(500);
    const body = await result.json();
    expect(body.error).toBe("database connection failed");

    // Should have logged the error
    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.statusCode).toBe(500);
    expect(log.error).toBe("database connection failed");
  });

  it("handles non-Error thrown values", async () => {
    const innerHandler = vi.fn().mockRejectedValue("string error");

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/sessions");
    const result = await wrapped(req);

    expect(result.status).toBe(500);
    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.error).toBe("string error");
  });

  it("measures duration (durationMs is non-negative)", async () => {
    const innerHandler = vi.fn().mockImplementation(async () => {
      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response("ok", { status: 200 });
    });

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/sessions");
    await wrapped(req);

    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── extractSessionId (tested indirectly via withTiming) ───────────────

describe("extractSessionId (indirect via withTiming)", () => {
  it("extracts sessionId from /api/sessions/abc123", async () => {
    const innerHandler = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/sessions/abc123");
    await wrapped(req);

    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.sessionId).toBe("abc123");
  });

  it("extracts sessionId from /api/sessions/ao-1/kill", async () => {
    const innerHandler = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/sessions/ao-1/kill");
    await wrapped(req);

    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.sessionId).toBe("ao-1");
  });

  it("returns null for /api/sessions (no ID segment)", async () => {
    const innerHandler = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/sessions");
    await wrapped(req);

    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.sessionId).toBeNull();
  });

  it("returns null for /api/prs/42/merge (no sessions segment)", async () => {
    const innerHandler = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/prs/42/merge");
    await wrapped(req);

    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.sessionId).toBeNull();
  });

  it("returns null for /api/config (no sessions segment)", async () => {
    const innerHandler = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request("http://localhost:3000/api/config");
    await wrapped(req);

    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.sessionId).toBeNull();
  });

  it("decodes URL-encoded session IDs", async () => {
    const innerHandler = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const wrapped = withTiming(innerHandler, "test-route");
    const req = new Request(
      "http://localhost:3000/api/sessions/session%20with%20spaces",
    );
    await wrapped(req);

    const log = mockLogApiRequest.mock.calls[0][0];
    expect(log.sessionId).toBe("session with spaces");
  });
});

// ── createTimingContext ───────────────────────────────────────────────

describe("createTimingContext", () => {
  it("creates context with empty timings object", () => {
    const ctx = createTimingContext();
    expect(ctx.timings).toEqual({});
  });

  it("creates context with a start timestamp", () => {
    const before = Date.now();
    const ctx = createTimingContext();
    const after = Date.now();

    expect(ctx.start).toBeGreaterThanOrEqual(before);
    expect(ctx.start).toBeLessThanOrEqual(after);
  });

  it("has a mark function", () => {
    const ctx = createTimingContext();
    expect(typeof ctx.mark).toBe("function");
  });

  it("mark() records operation timing with name and duration", () => {
    const ctx = createTimingContext();
    const opStart = Date.now() - 50; // Simulate 50ms ago

    ctx.mark("serviceInit", opStart);

    expect(ctx.timings["serviceInit"]).toBeDefined();
    expect(ctx.timings["serviceInit"]).toBeGreaterThanOrEqual(49); // allow 1ms slack
  });

  it("mark() can record multiple operations", () => {
    const ctx = createTimingContext();

    const start1 = Date.now() - 100;
    ctx.mark("serviceInit", start1);

    const start2 = Date.now() - 50;
    ctx.mark("sessionList", start2);

    const start3 = Date.now() - 25;
    ctx.mark("prEnrichment", start3);

    expect(Object.keys(ctx.timings)).toHaveLength(3);
    expect(ctx.timings["serviceInit"]).toBeDefined();
    expect(ctx.timings["sessionList"]).toBeDefined();
    expect(ctx.timings["prEnrichment"]).toBeDefined();
  });

  it("mark() overwrites previous timing for same operation name", () => {
    const ctx = createTimingContext();

    const start1 = Date.now() - 100;
    ctx.mark("serviceInit", start1);
    const first = ctx.timings["serviceInit"];

    const start2 = Date.now() - 10;
    ctx.mark("serviceInit", start2);
    const second = ctx.timings["serviceInit"];

    // Second mark should record a shorter duration
    expect(second).toBeLessThan(first);
  });

  it("mark() computes duration as Date.now() - startMs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.100Z"));

    const ctx = createTimingContext();

    // Simulate an operation that started at T=0
    const opStart = new Date("2026-01-15T10:00:00.000Z").getTime();

    // Advance to T=100ms for mark
    ctx.mark("serviceInit", opStart);

    expect(ctx.timings["serviceInit"]).toBe(100);

    vi.useRealTimers();
  });
});
