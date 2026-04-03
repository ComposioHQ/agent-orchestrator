import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/* ------------------------------------------------------------------ */
/*  Hoisted mocks                                                      */
/* ------------------------------------------------------------------ */

const mockSessionManager = vi.hoisted(() => ({
  list: vi.fn(async () => []),
}));

const mockConfig = vi.hoisted(() => ({
  projects: {
    "my-project": {
      name: "my-project",
      repo: "acme/my-project",
      path: "/tmp/my-project",
      defaultBranch: "main",
      sessionPrefix: "my-project",
      scm: { plugin: "github" },
    },
  },
}));

const mockRegistry = vi.hoisted(() => ({
  get: vi.fn(() => null),
}));

const mockGetServices = vi.hoisted(() =>
  vi.fn(async () => ({
    config: mockConfig,
    registry: mockRegistry,
    sessionManager: mockSessionManager,
  })),
);

const mockGetPortfolioServices = vi.hoisted(() =>
  vi.fn(() => ({
    portfolio: [
      {
        id: "proj-a",
        name: "Project A",
        degraded: false,
        degradedReason: null,
      },
    ],
  })),
);

const mockGetCachedPortfolioSessions = vi.hoisted(() => vi.fn(async () => []));

const mockSessionToDashboard = vi.hoisted(() =>
  vi.fn((s: Record<string, unknown>) => ({
    id: s.id,
    status: s.status ?? "working",
    activity: s.activity ?? "active",
    lastActivityAt: new Date().toISOString(),
    pr: s.pr ? { url: (s.pr as Record<string, unknown>).url } : undefined,
  })),
);

const mockResolveProject = vi.hoisted(() => vi.fn(() => mockConfig.projects["my-project"]));
const mockEnrichSessionPR = vi.hoisted(() => vi.fn(async () => {}));
const mockEnrichSessionsMetadata = vi.hoisted(() => vi.fn(async () => {}));
const mockComputeStats = vi.hoisted(() =>
  vi.fn(() => ({ total: 0, active: 0, idle: 0, done: 0 })),
);
const mockListDashboardOrchestrators = vi.hoisted(() => vi.fn(() => []));
const mockGetCorrelationId = vi.hoisted(() => vi.fn(() => "test-corr-id"));
const mockJsonWithCorrelation = vi.hoisted(() =>
  vi.fn((body: unknown, init: ResponseInit | undefined, correlationId: string) => {
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    headers.set("x-correlation-id", correlationId);
    return new Response(JSON.stringify(body), {
      ...init,
      headers,
    });
  }),
);
const mockRecordApiObservation = vi.hoisted(() => vi.fn());
const mockResolveGlobalPause = vi.hoisted(() => vi.fn(() => null));
const mockFilterProjectSessions = vi.hoisted(() =>
  vi.fn((sessions: unknown[]) => sessions),
);
const mockGetAttentionLevel = vi.hoisted(() => vi.fn(() => "working" as const));
const mockGetTriageRank = vi.hoisted(() => vi.fn(() => 5));
const mockIsOrchestratorSession = vi.hoisted(() => vi.fn(() => false));
const mockResolveProjectConfig = vi.hoisted(() => vi.fn(() => null));
const mockGetSCM = vi.hoisted(() => vi.fn(() => null));

/* ------------------------------------------------------------------ */
/*  vi.mock calls                                                      */
/* ------------------------------------------------------------------ */

vi.mock("@composio/ao-core", () => ({
  ACTIVITY_STATE: { EXITED: "exited", ACTIVE: "active", IDLE: "idle" },
  isOrchestratorSession: mockIsOrchestratorSession,
  resolveProjectConfig: mockResolveProjectConfig,
}));

vi.mock("@/lib/services", () => ({
  getServices: mockGetServices,
  getSCM: mockGetSCM,
}));

vi.mock("@/lib/portfolio-services", () => ({
  getPortfolioServices: mockGetPortfolioServices,
  getCachedPortfolioSessions: mockGetCachedPortfolioSessions,
}));

vi.mock("@/lib/serialize", () => ({
  sessionToDashboard: mockSessionToDashboard,
  resolveProject: mockResolveProject,
  enrichSessionPR: mockEnrichSessionPR,
  enrichSessionsMetadata: mockEnrichSessionsMetadata,
  computeStats: mockComputeStats,
  listDashboardOrchestrators: mockListDashboardOrchestrators,
}));

vi.mock("@/lib/observability", () => ({
  getCorrelationId: mockGetCorrelationId,
  jsonWithCorrelation: mockJsonWithCorrelation,
  recordApiObservation: mockRecordApiObservation,
}));

vi.mock("@/lib/global-pause", () => ({
  resolveGlobalPause: mockResolveGlobalPause,
}));

vi.mock("@/lib/project-utils", () => ({
  filterProjectSessions: mockFilterProjectSessions,
}));

vi.mock("@/lib/types", () => ({
  getAttentionLevel: mockGetAttentionLevel,
  getTriageRank: mockGetTriageRank,
}));

/* ------------------------------------------------------------------ */
/*  Import under test                                                  */
/* ------------------------------------------------------------------ */

import { GET } from "../route";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "sess-1",
    projectId: "my-project",
    status: "working",
    activity: "active",
    metadata: {},
    pr: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();

  // Defaults
  mockSessionManager.list.mockResolvedValue([]);
  mockGetCachedPortfolioSessions.mockResolvedValue([]);
  mockFilterProjectSessions.mockImplementation((sessions: unknown[]) => sessions);
  mockListDashboardOrchestrators.mockReturnValue([]);
  mockIsOrchestratorSession.mockReturnValue(false);
  mockEnrichSessionsMetadata.mockResolvedValue(undefined);
  mockComputeStats.mockReturnValue({ total: 0, active: 0, idle: 0, done: 0 });
  mockResolveGlobalPause.mockReturnValue(null);
});

describe("GET /api/sessions — portfolio scope", () => {
  it("returns portfolio sessions, action items, stats, and project summaries", async () => {
    const session = makeSession({ id: "ps-1", status: "working" });
    mockGetCachedPortfolioSessions.mockResolvedValue([
      { session, project: { id: "proj-a", name: "Project A" } },
    ]);
    mockGetAttentionLevel.mockReturnValue("working");
    mockGetTriageRank.mockReturnValue(5);

    const res = await GET(makeRequest("/api/sessions?scope=portfolio"));
    expect(res.status).toBe(200);

    // jsonWithCorrelation was called with portfolio payload
    expect(mockJsonWithCorrelation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessions: expect.any(Array),
        actionItems: expect.any(Array),
        stats: expect.any(Object),
        projectSummaries: expect.any(Array),
      }),
      { status: 200 },
      "test-corr-id",
    );
  });

  it("skips orchestrator sessions in portfolio", async () => {
    const orchSession = makeSession({ id: "orch-1" });
    const workerSession = makeSession({ id: "worker-1" });
    mockIsOrchestratorSession
      .mockReturnValueOnce(true) // first call: skip orch
      .mockReturnValueOnce(false) // second call: keep worker
      .mockReturnValueOnce(true) // PR enrichment: skip orch
      .mockReturnValueOnce(false); // PR enrichment: keep worker
    mockGetCachedPortfolioSessions.mockResolvedValue([
      { session: orchSession, project: { id: "proj-a", name: "Project A" } },
      { session: workerSession, project: { id: "proj-a", name: "Project A" } },
    ]);

    await GET(makeRequest("/api/sessions?scope=portfolio"));

    // sessionToDashboard should only be called for the worker session
    expect(mockSessionToDashboard).toHaveBeenCalledTimes(1);
    expect(mockSessionToDashboard).toHaveBeenCalledWith(workerSession);
  });

  it("enriches PR data for portfolio sessions with timeout", async () => {
    const sessionWithPR = makeSession({
      id: "pr-1",
      pr: { url: "https://github.com/acme/repo/pull/1" },
    });
    const project = { id: "proj-a", name: "Project A" };
    mockGetCachedPortfolioSessions.mockResolvedValue([
      { session: sessionWithPR, project },
    ]);
    mockResolveProjectConfig.mockReturnValue({ project: mockConfig.projects["my-project"] });
    mockGetSCM.mockReturnValue({ getPRStatus: vi.fn() });

    await GET(makeRequest("/api/sessions?scope=portfolio"));

    expect(mockEnrichSessionPR).toHaveBeenCalled();
  });

  it("handles PR enrichment failure gracefully", async () => {
    const sessionWithPR = makeSession({
      id: "pr-1",
      pr: { url: "https://github.com/acme/repo/pull/1" },
    });
    mockGetCachedPortfolioSessions.mockResolvedValue([
      { session: sessionWithPR, project: { id: "proj-a", name: "Project A" } },
    ]);
    // getServices throws during enrichment
    mockGetServices.mockRejectedValueOnce(new Error("service unavailable"));
    // But the first call (inside handlePortfolioScope) should succeed, so reset
    mockGetServices.mockResolvedValue({
      config: mockConfig,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    // Should not throw
    const res = await GET(makeRequest("/api/sessions?scope=portfolio"));
    expect(res.status).toBe(200);
  });

  it("sorts action items by triage rank then by last activity", async () => {
    const s1 = makeSession({ id: "s1" });
    const s2 = makeSession({ id: "s2" });
    mockGetCachedPortfolioSessions.mockResolvedValue([
      { session: s1, project: { id: "proj-a", name: "A" } },
      { session: s2, project: { id: "proj-b", name: "B" } },
    ]);
    mockGetTriageRank.mockReturnValueOnce(3).mockReturnValueOnce(1);

    await GET(makeRequest("/api/sessions?scope=portfolio"));

    const callArgs = mockJsonWithCorrelation.mock.calls[0][0] as {
      actionItems: Array<{ triageRank: number }>;
    };
    // Lower triage rank should come first
    expect(callArgs.actionItems[0].triageRank).toBeLessThanOrEqual(
      callArgs.actionItems[1].triageRank,
    );
  });

  it("maps portfolio to project summaries", async () => {
    mockGetPortfolioServices.mockReturnValue({
      portfolio: [
        { id: "proj-a", name: "Project A", degraded: true, degradedReason: "config error" },
      ],
    });

    await GET(makeRequest("/api/sessions?scope=portfolio"));

    const callArgs = mockJsonWithCorrelation.mock.calls[0][0] as {
      projectSummaries: Array<{ id: string; degraded: boolean; degradedReason: string | null }>;
    };
    expect(callArgs.projectSummaries).toEqual([
      { id: "proj-a", name: "Project A", degraded: true, degradedReason: "config error" },
    ]);
  });

  it("skips PR enrichment when resolveProjectConfig returns null", async () => {
    const sessionWithPR = makeSession({
      id: "pr-1",
      pr: { url: "https://github.com/acme/repo/pull/1" },
    });
    mockGetCachedPortfolioSessions.mockResolvedValue([
      { session: sessionWithPR, project: { id: "proj-a", name: "Project A" } },
    ]);
    mockResolveProjectConfig.mockReturnValue(null);

    await GET(makeRequest("/api/sessions?scope=portfolio"));

    expect(mockEnrichSessionPR).not.toHaveBeenCalled();
  });

  it("skips PR enrichment when getSCM returns null", async () => {
    const sessionWithPR = makeSession({
      id: "pr-1",
      pr: { url: "https://github.com/acme/repo/pull/1" },
    });
    mockGetCachedPortfolioSessions.mockResolvedValue([
      { session: sessionWithPR, project: { id: "proj-a", name: "Project A" } },
    ]);
    mockResolveProjectConfig.mockReturnValue({ project: mockConfig.projects["my-project"] });
    mockGetSCM.mockReturnValue(null);

    await GET(makeRequest("/api/sessions?scope=portfolio"));

    expect(mockEnrichSessionPR).not.toHaveBeenCalled();
  });

  it("recomputes attention levels after PR enrichment", async () => {
    const sessionWithPR = makeSession({
      id: "pr-1",
      pr: { url: "https://github.com/acme/repo/pull/1" },
    });
    mockGetCachedPortfolioSessions.mockResolvedValue([
      { session: sessionWithPR, project: { id: "proj-a", name: "Project A" } },
    ]);
    mockResolveProjectConfig.mockReturnValue({ project: mockConfig.projects["my-project"] });
    mockGetSCM.mockReturnValue({ getPRStatus: vi.fn() });

    // First call returns "working", second (after enrichment) returns "merge"
    mockGetAttentionLevel.mockReturnValueOnce("working").mockReturnValueOnce("merge");
    mockGetTriageRank.mockReturnValueOnce(5).mockReturnValueOnce(1);

    await GET(makeRequest("/api/sessions?scope=portfolio"));

    // getAttentionLevel should be called twice — once initially, once after enrichment
    expect(mockGetAttentionLevel).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/sessions — default scope", () => {
  it("returns sessions with stats and orchestrator info", async () => {
    const session = makeSession();
    mockSessionManager.list.mockResolvedValue([session]);
    mockFilterProjectSessions.mockReturnValue([session]);

    const res = await GET(makeRequest("/api/sessions"));
    expect(res.status).toBe(200);

    expect(mockJsonWithCorrelation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessions: expect.any(Array),
        stats: expect.any(Object),
        orchestratorId: null,
        orchestrators: expect.any(Array),
        globalPause: null,
      }),
      { status: 200 },
      "test-corr-id",
    );
  });

  it("returns orchestratorOnly response with empty sessions", async () => {
    mockSessionManager.list.mockResolvedValue([]);

    const res = await GET(makeRequest("/api/sessions?orchestratorOnly=true"));
    expect(res.status).toBe(200);

    expect(mockJsonWithCorrelation).toHaveBeenCalledWith(
      expect.objectContaining({
        orchestratorId: null,
        orchestrators: expect.any(Array),
        sessions: [],
      }),
      { status: 200 },
      "test-corr-id",
    );
    expect(mockRecordApiObservation).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orchestratorOnly: true }) }),
    );
  });

  it("filters active sessions when active=true", async () => {
    const activeSession = makeSession({ id: "active-1", activity: "active" });
    const exitedSession = makeSession({ id: "exited-1", activity: "exited" });
    mockSessionManager.list.mockResolvedValue([activeSession, exitedSession]);
    mockFilterProjectSessions.mockReturnValue([activeSession, exitedSession]);
    mockSessionToDashboard
      .mockReturnValueOnce({
        id: "active-1",
        status: "working",
        activity: "active",
        lastActivityAt: new Date().toISOString(),
      })
      .mockReturnValueOnce({
        id: "exited-1",
        status: "done",
        activity: "exited",
        lastActivityAt: new Date().toISOString(),
      });

    await GET(makeRequest("/api/sessions?active=true"));

    // computeStats should receive only the active session
    expect(mockComputeStats).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "active-1" })]),
    );
  });

  it("filters by project when project param is given", async () => {
    const session = makeSession({ projectId: "my-project" });
    mockSessionManager.list.mockResolvedValue([session]);
    mockFilterProjectSessions.mockReturnValue([session]);

    await GET(makeRequest("/api/sessions?project=my-project"));

    // list is called with projectId
    expect(mockSessionManager.list).toHaveBeenCalledWith("my-project");
    // Then also called without to get allSessions for globalPause
    expect(mockSessionManager.list).toHaveBeenCalledTimes(2);
  });

  it("ignores project filter 'all'", async () => {
    await GET(makeRequest("/api/sessions?project=all"));

    expect(mockSessionManager.list).toHaveBeenCalledWith(undefined);
    // Should NOT call list a second time since requestedProjectId is undefined
    expect(mockSessionManager.list).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown project filter", async () => {
    await GET(makeRequest("/api/sessions?project=unknown-proj"));

    expect(mockSessionManager.list).toHaveBeenCalledWith(undefined);
  });

  it("enriches session metadata and PRs when metadata settles in time", async () => {
    const sessionWithPR = makeSession({
      id: "pr-sess",
      pr: { url: "https://github.com/acme/repo/pull/1" },
    });
    mockSessionManager.list.mockResolvedValue([sessionWithPR]);
    mockFilterProjectSessions.mockReturnValue([sessionWithPR]);
    mockGetSCM.mockReturnValue({ getPRStatus: vi.fn() });

    await GET(makeRequest("/api/sessions"));

    expect(mockEnrichSessionsMetadata).toHaveBeenCalled();
    expect(mockEnrichSessionPR).toHaveBeenCalled();
  });

  it("skips PR enrichment when getSCM returns null", async () => {
    const sessionWithPR = makeSession({
      id: "pr-sess",
      pr: { url: "https://github.com/acme/repo/pull/1" },
    });
    mockSessionManager.list.mockResolvedValue([sessionWithPR]);
    mockFilterProjectSessions.mockReturnValue([sessionWithPR]);
    mockGetSCM.mockReturnValue(null);

    await GET(makeRequest("/api/sessions"));

    expect(mockEnrichSessionPR).not.toHaveBeenCalled();
  });

  it("sets orchestratorId when exactly one orchestrator exists", async () => {
    const orch = { id: "orch-1", name: "main-orch" };
    mockListDashboardOrchestrators.mockReturnValue([orch]);

    await GET(makeRequest("/api/sessions"));

    expect(mockJsonWithCorrelation).toHaveBeenCalledWith(
      expect.objectContaining({ orchestratorId: "orch-1" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("sets orchestratorId to null when multiple orchestrators exist", async () => {
    mockListDashboardOrchestrators.mockReturnValue([
      { id: "orch-1" },
      { id: "orch-2" },
    ]);

    await GET(makeRequest("/api/sessions"));

    expect(mockJsonWithCorrelation).toHaveBeenCalledWith(
      expect.objectContaining({ orchestratorId: null }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("records API observation on success", async () => {
    await GET(makeRequest("/api/sessions"));

    expect(mockRecordApiObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/sessions",
        outcome: "success",
        statusCode: 200,
      }),
    );
  });
});

describe("GET /api/sessions — error handling", () => {
  it("returns 500 with error message when getServices throws", async () => {
    mockGetServices.mockRejectedValue(new Error("config load failed"));

    const res = await GET(makeRequest("/api/sessions"));
    expect(res.status).toBe(500);

    expect(mockJsonWithCorrelation).toHaveBeenCalledWith(
      { error: "config load failed" },
      { status: 500 },
      "test-corr-id",
    );
  });

  it("returns generic error when non-Error is thrown", async () => {
    mockGetServices.mockRejectedValue("string error");

    await GET(makeRequest("/api/sessions"));

    expect(mockJsonWithCorrelation).toHaveBeenCalledWith(
      { error: "Failed to list sessions" },
      { status: 500 },
      "test-corr-id",
    );
  });

  it("records failure observation when config is available", async () => {
    // First call (inside try) fails, second call (inside catch) succeeds
    mockGetServices
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        config: mockConfig,
        registry: mockRegistry,
        sessionManager: mockSessionManager,
      });

    await GET(makeRequest("/api/sessions"));

    expect(mockRecordApiObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        statusCode: 500,
        reason: "boom",
      }),
    );
  });

  it("skips failure observation when getServices also fails in catch", async () => {
    mockGetServices.mockRejectedValue(new Error("total failure"));

    await GET(makeRequest("/api/sessions"));

    // recordApiObservation should not be called because config is undefined
    expect(mockRecordApiObservation).not.toHaveBeenCalled();
  });
});
