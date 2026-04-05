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
  });

  it("runs fast enrichment, uses cache-only PR hydration, and infers merged state for terminal cache misses even without SCM", async () => {
    const noPrCore = { id: "session-no-pr", status: "working", pr: null };
    const noScmCore = { id: "session-no-scm", status: "merged", pr: { number: 2 } };
    const mergedCore = { id: "session-merged", status: "merged", pr: { number: 3 } };
    const allSessions = [noPrCore, noScmCore, mergedCore];

    const dashboardNoPr = { id: "session-no-pr", pr: null };
    const dashboardNoScm = { id: "session-no-scm", pr: { state: "open", enriched: false } };
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
      .mockReturnValueOnce(dashboardNoScm)
      .mockReturnValueOnce(dashboardMerged);
    hoisted.resolveProjectMock.mockImplementation((core) => ({ id: core.id }));
    hoisted.getSCMMock
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ provider: "github" });

    const pageData = await getDashboardPageData("docs");

    expect(hoisted.enrichSessionsMetadataFastMock).toHaveBeenCalledWith(
      allSessions,
      [dashboardNoPr, dashboardNoScm, dashboardMerged],
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
    expect(dashboardNoScm.pr.state).toBe("merged");
    expect(dashboardMerged.pr.state).toBe("merged");
    expect(pageData.sessions).toEqual([dashboardNoPr, dashboardNoScm, dashboardMerged]);
  });
});
