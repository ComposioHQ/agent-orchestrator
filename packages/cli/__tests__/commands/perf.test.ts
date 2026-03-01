import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ParsedRequest } from "../../src/lib/perf-utils.js";

const { mockResolveLogDir, mockLoadRequests } = vi.hoisted(() => ({
  mockResolveLogDir: vi.fn(() => "/tmp/logs"),
  mockLoadRequests: vi.fn(),
}));

// computeApiStats and percentile are pure functions — use real implementations.
// Only mock file I/O (perf-utils.js).
vi.mock("../../src/lib/perf-utils.js", () => ({
  resolveLogDir: mockResolveLogDir,
  loadRequests: mockLoadRequests,
}));

vi.mock("../../src/lib/format.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("../../src/lib/format.js")>();
  return { ...actual };
});

import { Command } from "commander";
import { registerPerf } from "../../src/commands/perf.js";

let program: Command;
let logs: string[];

beforeEach(() => {
  program = new Command();
  program.exitOverride();
  registerPerf(program);

  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockLoadRequests.mockReset();
  mockResolveLogDir.mockReturnValue("/tmp/logs");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRequest(overrides: Partial<ParsedRequest> = {}): ParsedRequest {
  return {
    ts: "2025-01-01T12:00:00Z",
    method: "GET",
    path: "/api/sessions",
    sessionId: null,
    statusCode: 200,
    durationMs: 50,
    ...overrides,
  };
}

describe("perf routes", () => {
  it("outputs grouped route stats with --json", async () => {
    mockLoadRequests.mockReturnValue([
      makeRequest({ path: "/api/sessions/abc", durationMs: 100 }),
      makeRequest({ path: "/api/sessions/def", durationMs: 200 }),
      makeRequest({ path: "/api/health", durationMs: 5 }),
    ]);

    await program.parseAsync(["node", "test", "perf", "routes", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed["GET /api/sessions/:id"]).toBeDefined();
    expect(parsed["GET /api/sessions/:id"].count).toBe(2);
    expect(parsed["GET /api/health"]).toBeDefined();
    expect(parsed["GET /api/health"].count).toBe(1);
  });

  it("shows empty message when no data", async () => {
    mockLoadRequests.mockReturnValue([]);

    await program.parseAsync(["node", "test", "perf", "routes"]);

    const output = logs.join("\n");
    expect(output).toContain("No API request logs found.");
  });

  it("outputs empty object as JSON when no data with --json", async () => {
    mockLoadRequests.mockReturnValue([]);

    await program.parseAsync(["node", "test", "perf", "routes", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({});
  });

  it("tracks errors per route in JSON output", async () => {
    mockLoadRequests.mockReturnValue([
      makeRequest({ statusCode: 200 }),
      makeRequest({ statusCode: 500, error: "server error" }),
    ]);

    await program.parseAsync(["node", "test", "perf", "routes", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    const routeKey = Object.keys(parsed)[0];
    expect(parsed[routeKey].errors).toBe(1);
  });

  it("displays table format without --json", async () => {
    mockLoadRequests.mockReturnValue([
      makeRequest({ durationMs: 100 }),
      makeRequest({ durationMs: 200 }),
    ]);

    await program.parseAsync(["node", "test", "perf", "routes"]);

    const output = logs.join("\n");
    expect(output).toContain("Route");
    expect(output).toContain("Count");
    expect(output).toContain("total requests");
  });
});

describe("perf slow", () => {
  it("outputs slowest requests with --json --limit 2", async () => {
    mockLoadRequests.mockReturnValue([
      makeRequest({ durationMs: 500, path: "/api/slow" }),
      makeRequest({ durationMs: 300, path: "/api/medium" }),
      makeRequest({ durationMs: 100, path: "/api/fast" }),
    ]);

    await program.parseAsync(["node", "test", "perf", "slow", "--json", "--limit", "2"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].durationMs).toBe(500);
    expect(parsed[1].durationMs).toBe(300);
  });

  it("shows empty message when no data without --json", async () => {
    mockLoadRequests.mockReturnValue([]);

    await program.parseAsync(["node", "test", "perf", "slow"]);

    const output = logs.join("\n");
    expect(output).toContain("No API request logs found.");
  });

  it("outputs empty array as JSON when no data", async () => {
    mockLoadRequests.mockReturnValue([]);

    await program.parseAsync(["node", "test", "perf", "slow", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed).toEqual([]);
  });
});

describe("perf cache", () => {
  it("outputs cache stats with --json", async () => {
    mockLoadRequests.mockReturnValue([
      makeRequest({
        cacheStats: { hits: 15, misses: 5, hitRate: 0.75, size: 20 },
      }),
    ]);

    await program.parseAsync(["node", "test", "perf", "cache", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.hits).toBe(15);
    expect(parsed.misses).toBe(5);
    expect(parsed.hitRate).toBe(0.75);
    expect(parsed.size).toBe(20);
  });

  it("outputs empty object as JSON when no cache stats", async () => {
    mockLoadRequests.mockReturnValue([makeRequest()]);

    await program.parseAsync(["node", "test", "perf", "cache", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({});
  });

  it("shows human-readable output without --json", async () => {
    mockLoadRequests.mockReturnValue([
      makeRequest({
        cacheStats: { hits: 10, misses: 2, hitRate: 0.83, size: 12 },
      }),
    ]);

    await program.parseAsync(["node", "test", "perf", "cache"]);

    const output = logs.join("\n");
    expect(output).toContain("Cache Statistics");
    expect(output).toContain("83.0%");
  });

  it("uses the most recent cache stats entry", async () => {
    mockLoadRequests.mockReturnValue([
      makeRequest({
        cacheStats: { hits: 1, misses: 1, hitRate: 0.5, size: 2 },
      }),
      makeRequest(),
      makeRequest({
        cacheStats: { hits: 20, misses: 5, hitRate: 0.8, size: 25 },
      }),
    ]);

    await program.parseAsync(["node", "test", "perf", "cache", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.hits).toBe(20);
  });
});

describe("perf enrichment", () => {
  it("outputs timing data with --json", async () => {
    mockLoadRequests.mockReturnValue([
      makeRequest({
        path: "/api/sessions",
        timings: { prEnrichment: 120, sessionList: 30 },
      }),
      makeRequest({
        path: "/api/sessions/abc",
        timings: { prEnrichment: 80, sessionList: 20 },
      }),
    ]);

    await program.parseAsync(["node", "test", "perf", "enrichment", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.enrichTimes).toEqual([120, 80]);
    expect(parsed.listTimes).toEqual([30, 20]);
  });

  it("outputs empty arrays as JSON when no enrichment data", async () => {
    mockLoadRequests.mockReturnValue([
      makeRequest({ path: "/api/sessions" }),
    ]);

    await program.parseAsync(["node", "test", "perf", "enrichment", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.enrichTimes).toEqual([]);
    expect(parsed.listTimes).toEqual([]);
  });

  it("shows human-readable output without --json", async () => {
    mockLoadRequests.mockReturnValue([
      makeRequest({
        path: "/api/sessions",
        timings: { prEnrichment: 150, sessionList: 40 },
      }),
    ]);

    await program.parseAsync(["node", "test", "perf", "enrichment"]);

    const output = logs.join("\n");
    expect(output).toContain("PR Enrichment Performance");
    expect(output).toContain("Samples");
  });
});
