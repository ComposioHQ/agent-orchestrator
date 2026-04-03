import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockEnsureProjectOrchestrator,
  mockGetServices,
  mockGetSCM,
  mockSessionToDashboard,
  mockEnrichSessionPR,
  mockEnrichSessionsMetadata,
  mockListDashboardOrchestrators,
  mockResolveProject,
  mockFilterProjectSessions,
  mockResolveGlobalPause,
} = vi.hoisted(() => ({
  mockEnsureProjectOrchestrator: vi.fn(),
  mockGetServices: vi.fn(),
  mockGetSCM: vi.fn(),
  mockSessionToDashboard: vi.fn(),
  mockEnrichSessionPR: vi.fn(),
  mockEnrichSessionsMetadata: vi.fn(),
  mockListDashboardOrchestrators: vi.fn(),
  mockResolveProject: vi.fn(),
  mockFilterProjectSessions: vi.fn(),
  mockResolveGlobalPause: vi.fn(),
}));

vi.mock("@composio/ao-core", () => ({
  isOrchestratorSession: vi.fn((s: { id: string }) => s.id.startsWith("orch-")),
}));

vi.mock("@/lib/ensure-project-orchestrator", () => ({
  ensureProjectOrchestrator: mockEnsureProjectOrchestrator,
}));

vi.mock("@/lib/services", () => ({
  getServices: mockGetServices,
  getSCM: mockGetSCM,
}));

vi.mock("@/lib/serialize", () => ({
  sessionToDashboard: mockSessionToDashboard,
  enrichSessionPR: mockEnrichSessionPR,
  enrichSessionsMetadata: mockEnrichSessionsMetadata,
  listDashboardOrchestrators: mockListDashboardOrchestrators,
  resolveProject: mockResolveProject,
}));

const mockPrCacheGet = vi.fn().mockReturnValue(null);

vi.mock("@/lib/cache", () => ({
  prCache: { get: (...args: unknown[]) => mockPrCacheGet(...args) },
  prCacheKey: vi.fn((...args: string[]) => args.join("/")),
}));

vi.mock("@/lib/project-utils", () => ({
  filterProjectSessions: mockFilterProjectSessions,
}));

vi.mock("@/lib/global-pause", () => ({
  resolveGlobalPause: mockResolveGlobalPause,
}));

import { loadProjectPageData } from "@/lib/project-page-data";

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureProjectOrchestrator.mockResolvedValue(undefined);
  mockResolveGlobalPause.mockReturnValue(null);
  mockListDashboardOrchestrators.mockReturnValue([]);
  mockEnrichSessionsMetadata.mockResolvedValue(undefined);
});

describe("loadProjectPageData", () => {
  it("returns default empty data when getServices throws", async () => {
    mockGetServices.mockRejectedValue(new Error("no config"));

    const result = await loadProjectPageData("my-app");

    expect(result).toEqual({
      sessions: [],
      sidebarSessions: [],
      globalPause: null,
      orchestrators: [],
    });
  });

  it("loads sessions and filters by project", async () => {
    const coreSessions = [
      { id: "worker-1", status: "working", projectId: "my-app" },
      { id: "worker-2", status: "pr_open", projectId: "my-app" },
    ];

    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": {} } },
      registry: {},
      sessionManager: { list: vi.fn().mockResolvedValue(coreSessions) },
    });

    mockFilterProjectSessions.mockReturnValue(coreSessions);
    mockSessionToDashboard.mockImplementation((s: { id: string }) => ({
      id: s.id,
      status: "working",
    }));

    const result = await loadProjectPageData("my-app");

    expect(mockFilterProjectSessions).toHaveBeenCalledWith(
      coreSessions,
      "my-app",
      { "my-app": {} },
    );
    expect(result.sessions).toHaveLength(2);
    expect(result.sidebarSessions).toHaveLength(2);
  });

  it("filters out orchestrator sessions from worker list", async () => {
    const coreSessions = [
      { id: "orch-1", status: "working", projectId: "my-app" },
      { id: "worker-1", status: "working", projectId: "my-app" },
    ];

    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": {} } },
      registry: {},
      sessionManager: { list: vi.fn().mockResolvedValue(coreSessions) },
    });

    mockFilterProjectSessions.mockReturnValue(coreSessions);
    mockSessionToDashboard.mockImplementation((s: { id: string }) => ({
      id: s.id,
      status: "working",
    }));

    const result = await loadProjectPageData("my-app");

    // orchestrator sessions appear in sidebar but not in worker sessions
    expect(result.sidebarSessions).toHaveLength(2);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe("worker-1");
  });

  it("continues rendering when ensureProjectOrchestrator fails", async () => {
    mockEnsureProjectOrchestrator.mockRejectedValue(new Error("startup failed"));

    const coreSessions = [
      { id: "worker-1", status: "working", projectId: "my-app" },
    ];

    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": {} } },
      registry: {},
      sessionManager: { list: vi.fn().mockResolvedValue(coreSessions) },
    });

    mockFilterProjectSessions.mockReturnValue(coreSessions);
    mockSessionToDashboard.mockImplementation((s: { id: string }) => ({
      id: s.id,
      status: "working",
    }));

    const result = await loadProjectPageData("my-app");

    // Should still load sessions despite orchestrator startup failure
    expect(result.sessions).toHaveLength(1);
  });

  it("resolves global pause from all sessions", async () => {
    const coreSessions = [
      { id: "worker-1", status: "working", projectId: "my-app" },
    ];

    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": {} } },
      registry: {},
      sessionManager: { list: vi.fn().mockResolvedValue(coreSessions) },
    });

    mockFilterProjectSessions.mockReturnValue(coreSessions);
    mockSessionToDashboard.mockReturnValue({ id: "worker-1", status: "working" });
    mockResolveGlobalPause.mockReturnValue({ paused: true, reason: "manual" });

    const result = await loadProjectPageData("my-app");

    expect(mockResolveGlobalPause).toHaveBeenCalledWith(coreSessions);
    expect(result.globalPause).toEqual({ paused: true, reason: "manual" });
  });

  it("uses cached PR data when prCache returns a hit", async () => {
    const coreSessions = [
      {
        id: "worker-1",
        status: "working",
        projectId: "my-app",
        pr: { owner: "org", repo: "repo", number: 42 },
      },
    ];

    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": {} } },
      registry: {},
      sessionManager: { list: vi.fn().mockResolvedValue(coreSessions) },
    });

    mockFilterProjectSessions.mockReturnValue(coreSessions);
    mockSessionToDashboard.mockImplementation((s: { id: string }) => ({
      id: s.id,
      status: "working",
      pr: {
        state: "open",
        title: "old",
        additions: 0,
        deletions: 0,
        ciStatus: "none",
        reviewDecision: "none",
        ciChecks: [],
        mergeability: "unknown",
        unresolvedThreads: 0,
        unresolvedComments: [],
      },
    }));

    mockPrCacheGet.mockReturnValue({
      state: "open",
      title: "Cached title",
      additions: 10,
      deletions: 5,
      ciStatus: "passing",
      reviewDecision: "approved",
      ciChecks: [{ name: "lint", status: "passed", url: "https://ci" }],
      mergeability: "mergeable",
      unresolvedThreads: 1,
      unresolvedComments: ["nit"],
    });

    const result = await loadProjectPageData("my-app");

    expect(result.sessions).toHaveLength(1);
    const pr = result.sessions[0].pr;
    expect(pr?.title).toBe("Cached title");
    expect(pr?.additions).toBe(10);
    expect(pr?.ciStatus).toBe("passing");
    expect(pr?.reviewDecision).toBe("approved");
    expect(pr?.ciChecks).toHaveLength(1);
    expect(pr?.mergeability).toBe("mergeable");
    expect(pr?.unresolvedThreads).toBe(1);
  });

  it("skips SCM enrichment for terminal sessions with merged PRs in cache", async () => {
    const coreSessions = [
      {
        id: "worker-1",
        status: "merged",
        projectId: "my-app",
        pr: { owner: "org", repo: "repo", number: 42 },
      },
    ];

    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": {} } },
      registry: {},
      sessionManager: { list: vi.fn().mockResolvedValue(coreSessions) },
    });

    mockFilterProjectSessions.mockReturnValue(coreSessions);
    mockSessionToDashboard.mockImplementation((s: { id: string }) => ({
      id: s.id,
      status: "merged",
      pr: { state: "open", title: "t", ciChecks: [] },
    }));

    mockPrCacheGet.mockReturnValue({
      state: "merged",
      title: "t",
      additions: 0,
      deletions: 0,
      ciStatus: "passing",
      reviewDecision: "approved",
      ciChecks: [],
      mergeability: "unknown",
      unresolvedThreads: 0,
      unresolvedComments: [],
    });

    const result = await loadProjectPageData("my-app");

    // Should not attempt SCM enrichment for terminal+merged
    expect(mockEnrichSessionPR).not.toHaveBeenCalled();
    expect(result.sessions).toHaveLength(1);
  });

  it("enriches PR via SCM when cache misses and SCM is available", async () => {
    const coreSessions = [
      {
        id: "worker-1",
        status: "pr_open",
        projectId: "my-app",
        pr: { owner: "org", repo: "repo", number: 42 },
      },
    ];

    const mockScm = { getPRDetails: vi.fn() };
    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": { scm: { plugin: "github" } } } },
      registry: {},
      sessionManager: { list: vi.fn().mockResolvedValue(coreSessions) },
    });

    mockFilterProjectSessions.mockReturnValue(coreSessions);
    mockSessionToDashboard.mockImplementation((s: { id: string }) => ({
      id: s.id,
      status: "pr_open",
      pr: { state: "open", title: "t", ciChecks: [] },
    }));
    mockPrCacheGet.mockReturnValue(null);
    mockResolveProject.mockReturnValue({ scm: { plugin: "github" } });
    mockGetSCM.mockReturnValue(mockScm);
    mockEnrichSessionPR.mockResolvedValue(undefined);

    await loadProjectPageData("my-app");

    expect(mockEnrichSessionPR).toHaveBeenCalled();
  });

  it("skips SCM enrichment when no SCM plugin is available", async () => {
    const coreSessions = [
      {
        id: "worker-1",
        status: "pr_open",
        projectId: "my-app",
        pr: { owner: "org", repo: "repo", number: 42 },
      },
    ];

    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": {} } },
      registry: {},
      sessionManager: { list: vi.fn().mockResolvedValue(coreSessions) },
    });

    mockFilterProjectSessions.mockReturnValue(coreSessions);
    mockSessionToDashboard.mockImplementation((s: { id: string }) => ({
      id: s.id,
      status: "pr_open",
      pr: { state: "open", title: "t", ciChecks: [] },
    }));
    mockPrCacheGet.mockReturnValue(null);
    mockResolveProject.mockReturnValue({});
    mockGetSCM.mockReturnValue(null);

    await loadProjectPageData("my-app");

    expect(mockEnrichSessionPR).not.toHaveBeenCalled();
  });
});
