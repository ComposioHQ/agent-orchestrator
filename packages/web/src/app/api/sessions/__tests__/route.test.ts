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
const mockIsOrchestratorSession = vi.hoisted(() => vi.fn(() => false));
const mockGetSCM = vi.hoisted(() => vi.fn(() => null));

/* ------------------------------------------------------------------ */
/*  vi.mock calls                                                      */
/* ------------------------------------------------------------------ */

vi.mock("@aoagents/ao-core", () => ({
  ACTIVITY_STATE: { EXITED: "exited", ACTIVE: "active", IDLE: "idle" },
  isOrchestratorSession: mockIsOrchestratorSession,
}));

vi.mock("@/lib/services", () => ({
  getServices: mockGetServices,
  getSCM: mockGetSCM,
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
  mockConfig.projects = {
    "my-project": {
      name: "my-project",
      repo: "acme/my-project",
      path: "/tmp/my-project",
      defaultBranch: "main",
      sessionPrefix: "my-project",
      scm: { plugin: "github" },
    },
  };

  // Defaults
  mockSessionManager.list.mockResolvedValue([]);
  mockFilterProjectSessions.mockImplementation((sessions: unknown[]) => sessions);
  mockListDashboardOrchestrators.mockReturnValue([]);
  mockIsOrchestratorSession.mockReturnValue(false);
  mockEnrichSessionsMetadata.mockResolvedValue(undefined);
  mockComputeStats.mockReturnValue({ total: 0, active: 0, idle: 0, done: 0 });
  mockResolveGlobalPause.mockReturnValue(null);
});

describe("GET /api/sessions — portfolio scope", () => {
  it("returns the standard sessions payload shape", async () => {
    const session = makeSession({ id: "ps-1", status: "working" });
    mockSessionManager.list.mockResolvedValue([session]);
    mockFilterProjectSessions.mockReturnValue([session]);

    const res = await GET(makeRequest("/api/sessions?scope=portfolio"));
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

  it("skips orchestrator sessions in portfolio", async () => {
    const orchSession = makeSession({ id: "orch-1" });
    const workerSession = makeSession({ id: "worker-1" });
    mockIsOrchestratorSession
      .mockReturnValueOnce(true) // first call: skip orch
      .mockReturnValueOnce(false) // second call: keep worker
      .mockReturnValueOnce(true) // PR enrichment: skip orch
      .mockReturnValueOnce(false); // PR enrichment: keep worker
    mockSessionManager.list.mockResolvedValue([orchSession, workerSession]);
    mockFilterProjectSessions.mockReturnValue([orchSession, workerSession]);

    await GET(makeRequest("/api/sessions?scope=portfolio"));

    // sessionToDashboard should only be called for the worker session
    expect(mockSessionToDashboard).toHaveBeenCalledTimes(1);
    expect(mockSessionToDashboard).toHaveBeenCalledWith(workerSession, 0, [workerSession]);
  });

  it("handles PR enrichment failure gracefully", async () => {
    const sessionWithPR = makeSession({
      id: "pr-1",
      pr: { url: "https://github.com/acme/repo/pull/1" },
    });
    mockSessionManager.list.mockResolvedValue([sessionWithPR]);
    mockFilterProjectSessions.mockReturnValue([sessionWithPR]);
    mockGetSCM.mockReturnValue({ getPRStatus: vi.fn() });
    mockEnrichSessionPR.mockRejectedValueOnce(new Error("service unavailable"));

    const res = await GET(makeRequest("/api/sessions?scope=portfolio"));
    expect(res.status).toBe(200);
  });

  it("skips PR enrichment when getSCM returns null", async () => {
    const sessionWithPR = makeSession({
      id: "pr-1",
      pr: { url: "https://github.com/acme/repo/pull/1" },
    });
    mockSessionManager.list.mockResolvedValue([sessionWithPR]);
    mockFilterProjectSessions.mockReturnValue([sessionWithPR]);
    mockGetSCM.mockReturnValue(null);

    await GET(makeRequest("/api/sessions?scope=portfolio"));

    expect(mockEnrichSessionPR).not.toHaveBeenCalled();
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

  it("excludes disabled-project orchestrators from orchestratorOnly responses", async () => {
    const enabledSession = makeSession({ id: "orch-enabled", projectId: "my-project" });
    const disabledSession = makeSession({ id: "orch-disabled", projectId: "disabled" });
    mockConfig.projects = {
      "my-project": { ...mockConfig.projects["my-project"] },
      disabled: {
        ...mockConfig.projects["my-project"],
        name: "disabled",
        path: "/tmp/disabled",
        enabled: false,
      },
    };
    mockSessionManager.list.mockResolvedValue([enabledSession, disabledSession]);
    mockFilterProjectSessions.mockImplementation((sessions, _filter, projects) =>
      (sessions as Array<{ projectId: string }>).filter((session) => Boolean(projects[session.projectId])),
    );
    mockListDashboardOrchestrators.mockImplementation((sessions, projects) =>
      (sessions as Array<{ id: string; projectId: string }>)
        .filter((session: { projectId: string }) => projects[session.projectId])
        .map((session: { id: string; projectId: string }) => ({
          id: session.id,
          projectId: session.projectId,
          projectName: projects[session.projectId].name,
        })),
    );

    const res = await GET(makeRequest("/api/sessions?orchestratorOnly=true"));
    expect(res.status).toBe(200);
    expect(mockJsonWithCorrelation).toHaveBeenCalledWith(
      expect.objectContaining({
        orchestrators: [{ id: "orch-enabled", projectId: "my-project", projectName: "my-project" }],
      }),
      { status: 200 },
      "test-corr-id",
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
