import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getServicesMock: vi.fn(),
  getSCMMock: vi.fn(),
  sessionToDashboardMock: vi.fn(),
  resolveProjectMock: vi.fn(),
  enrichSessionPRMock: vi.fn(),
  enrichSessionsMetadataFastMock: vi.fn(),
  listDashboardOrchestratorsMock: vi.fn(),
  filterProjectSessionsMock: vi.fn(),
  filterWorkerSessionsMock: vi.fn(),
  resolveGlobalPauseMock: vi.fn(),
  getAllProjectsMock: vi.fn(),
  getPrimaryProjectIdMock: vi.fn(),
  getProjectNameMock: vi.fn(),
}));

vi.mock("@/lib/services", () => ({
  getServices: hoisted.getServicesMock,
  getSCM: hoisted.getSCMMock,
}));

vi.mock("@/lib/serialize", () => ({
  sessionToDashboard: hoisted.sessionToDashboardMock,
  resolveProject: hoisted.resolveProjectMock,
  enrichSessionPR: hoisted.enrichSessionPRMock,
  enrichSessionsMetadataFast: hoisted.enrichSessionsMetadataFastMock,
  listDashboardOrchestrators: hoisted.listDashboardOrchestratorsMock,
}));

vi.mock("@/lib/project-utils", () => ({
  filterProjectSessions: hoisted.filterProjectSessionsMock,
  filterWorkerSessions: hoisted.filterWorkerSessionsMock,
}));

vi.mock("@/lib/global-pause", () => ({
  resolveGlobalPause: hoisted.resolveGlobalPauseMock,
}));

vi.mock("@/lib/project-name", () => ({
  getAllProjects: hoisted.getAllProjectsMock,
  getPrimaryProjectId: hoisted.getPrimaryProjectIdMock,
  getProjectName: hoisted.getProjectNameMock,
}));

import { getDashboardPageData } from "@/lib/dashboard-page-data";

describe("getDashboardPageData fast path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getAllProjectsMock.mockReturnValue([
      { id: "docs", name: "Docs" },
      { id: "mono", name: "Mono" },
    ]);
    hoisted.getPrimaryProjectIdMock.mockReturnValue("docs");
    hoisted.getProjectNameMock.mockReturnValue("Docs");
    hoisted.resolveGlobalPauseMock.mockReturnValue({ reason: "paused" });
    hoisted.listDashboardOrchestratorsMock.mockReturnValue([{ id: "orch-1", projectId: "docs", projectName: "Docs" }]);
    hoisted.enrichSessionsMetadataFastMock.mockResolvedValue(undefined);
  });

  it("runs fast enrichment, uses cache-only PR hydration, and infers merged/closed state for terminal cache misses even without SCM", async () => {
    const noPrCore = { id: "session-no-pr", status: "working", pr: null };
    const closedCore = { id: "session-closed", status: "killed", pr: { number: 2 } };
    const mergedCore = { id: "session-merged", status: "merged", pr: { number: 3 } };
    const allSessions = [noPrCore, closedCore, mergedCore];

    const dashboardNoPr = { id: "session-no-pr", pr: null };
    const dashboardClosed = { id: "session-closed", pr: { state: "open", enriched: false } };
    const dashboardMerged = { id: "session-merged", pr: { state: "open", enriched: false } };

    hoisted.getServicesMock.mockResolvedValue({
      config: { projects: { docs: { id: "docs" } } },
      registry: { scm: "registry" },
      sessionManager: { list: vi.fn().mockResolvedValue(allSessions) },
    });
    hoisted.filterProjectSessionsMock.mockReturnValue(allSessions);
    hoisted.filterWorkerSessionsMock.mockReturnValue(allSessions);
    hoisted.sessionToDashboardMock
      .mockReturnValueOnce(dashboardNoPr)
      .mockReturnValueOnce(dashboardClosed)
      .mockReturnValueOnce(dashboardMerged);
    hoisted.resolveProjectMock.mockImplementation((core) => ({ id: core.id }));
    hoisted.getSCMMock
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ provider: "github" });

    const pageData = await getDashboardPageData("docs");

    expect(hoisted.enrichSessionsMetadataFastMock).toHaveBeenCalledWith(
      allSessions,
      [dashboardNoPr, dashboardClosed, dashboardMerged],
      { projects: { docs: { id: "docs" } } },
      { scm: "registry" },
    );
    expect(hoisted.enrichSessionPRMock).toHaveBeenCalledTimes(1);
    expect(hoisted.enrichSessionPRMock).toHaveBeenCalledWith(
      dashboardMerged,
      { provider: "github" },
      mergedCore.pr,
      { cacheOnly: true },
    );
    expect(dashboardClosed.pr.state).toBe("closed");
    expect(dashboardMerged.pr.state).toBe("merged");
    expect(pageData.sessions).toEqual([dashboardNoPr, dashboardClosed, dashboardMerged]);
  });

  it("does not block SSR indefinitely when fast metadata enrichment hangs", async () => {
    vi.useFakeTimers();

    try {
      const core = { id: "session-hung", status: "working", pr: null };
      const dashboard = { id: "session-hung", pr: null };

      hoisted.getServicesMock.mockResolvedValue({
        config: { projects: { mono: { id: "mono" } } },
        registry: { scm: "registry" },
        sessionManager: { list: vi.fn().mockResolvedValue([core]) },
      });
      hoisted.filterProjectSessionsMock.mockReturnValue([core]);
      hoisted.filterWorkerSessionsMock.mockReturnValue([core]);
      hoisted.sessionToDashboardMock.mockReturnValue(dashboard);
      hoisted.enrichSessionsMetadataFastMock.mockImplementation(
        () => new Promise(() => {}),
      );

      const pageDataPromise = getDashboardPageData("mono");
      await vi.advanceTimersByTimeAsync(3_000);
      const pageData = await pageDataPromise;

      expect(pageData.sessions).toEqual([dashboard]);
      expect(hoisted.enrichSessionPRMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
