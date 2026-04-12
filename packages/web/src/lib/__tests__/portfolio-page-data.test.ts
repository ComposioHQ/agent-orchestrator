import type * as TypesModule from "@/lib/types";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetPortfolioServices = vi.fn();
const mockGetCachedPortfolioSessions = vi.fn();
const mockSessionToDashboard = vi.fn();
const mockIsOrchestratorSession = vi.fn();
const mockLoadPreferences = vi.fn(() => ({}));
const mockLoadGlobalConfig = vi.fn(() => null);
const mockIsProjectShadowStale = vi.fn(() => false);

vi.mock("@/lib/portfolio-services", () => ({
  getPortfolioServices: () => mockGetPortfolioServices(),
  getCachedPortfolioSessions: () => mockGetCachedPortfolioSessions(),
}));

vi.mock("@/lib/serialize", () => ({
  sessionToDashboard: (...args: unknown[]) => mockSessionToDashboard(...args),
}));

vi.mock("@aoagents/ao-core", () => ({
  isOrchestratorSession: (...args: unknown[]) => mockIsOrchestratorSession(...args),
  loadPreferences: () => mockLoadPreferences(),
  loadGlobalConfig: () => mockLoadGlobalConfig(),
  isProjectShadowStale: (...args: unknown[]) => mockIsProjectShadowStale(...args),
}));

vi.mock("@/lib/types", async () => {
  const actual = await vi.importActual<TypesModule>("@/lib/types");
  return actual;
});

const defaultPortfolio = [
  { id: "bravo", name: "Bravo", repo: "org/bravo", enabled: true, degraded: false },
  { id: "alpha", name: "Alpha", repo: "org/alpha", enabled: true, degraded: false },
  { id: "charlie", name: "Charlie", repo: "org/charlie", enabled: true, degraded: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPortfolioServices.mockReturnValue({ portfolio: defaultPortfolio });
  mockGetCachedPortfolioSessions.mockResolvedValue([]);
  mockIsOrchestratorSession.mockReturnValue(false);
  mockLoadPreferences.mockReturnValue({});
  mockLoadGlobalConfig.mockReturnValue(null);
  mockIsProjectShadowStale.mockReturnValue(false);
});

describe("loadPortfolioPageData", () => {
  it("preserves the portfolio order provided by the registry services", async () => {
    const { loadPortfolioPageData } = await import("../portfolio-page-data");

    const { projectSummaries } = await loadPortfolioPageData();

    expect(projectSummaries.map((project) => project.id)).toEqual(["bravo", "alpha", "charlie"]);
  });

  it("skips orchestrator sessions and counts worker sessions", async () => {
    mockIsOrchestratorSession.mockImplementation(
      (s: { id: string }) => s.id.startsWith("orch-"),
    );

    mockGetCachedPortfolioSessions.mockResolvedValue([
      {
        project: { id: "bravo" },
        session: { id: "orch-1", status: "working", projectId: "bravo" },
      },
      {
        project: { id: "bravo" },
        session: { id: "worker-1", status: "working", projectId: "bravo" },
      },
    ]);

    mockSessionToDashboard.mockImplementation((s: { id: string; status: string }) => ({
      id: s.id,
      status: s.status,
    }));

    const { loadPortfolioPageData } = await import("../portfolio-page-data");
    const { projectSummaries, sessions } = await loadPortfolioPageData();

    // Only the worker session should be counted
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("worker-1");

    const bravoSummary = projectSummaries.find((p) => p.id === "bravo");
    expect(bravoSummary?.sessionCount).toBe(1);
    expect(bravoSummary?.activeCount).toBe(1);
  });

  it("skips sessions for unknown projects", async () => {
    mockGetCachedPortfolioSessions.mockResolvedValue([
      {
        project: { id: "unknown-project" },
        session: { id: "worker-1", status: "working", projectId: "unknown-project" },
      },
    ]);

    const { loadPortfolioPageData } = await import("../portfolio-page-data");
    const { sessions } = await loadPortfolioPageData();

    expect(sessions).toHaveLength(0);
  });

  it("counts attention levels per project with done sessions as inactive", async () => {
    mockGetCachedPortfolioSessions.mockResolvedValue([
      {
        project: { id: "alpha" },
        session: { id: "w1", status: "merged", projectId: "alpha" },
      },
      {
        project: { id: "alpha" },
        session: { id: "w2", status: "working", projectId: "alpha" },
      },
    ]);

    mockSessionToDashboard.mockImplementation((s: { id: string; status: string }) => ({
      id: s.id,
      status: s.status,
    }));

    const { loadPortfolioPageData } = await import("../portfolio-page-data");
    const { projectSummaries } = await loadPortfolioPageData();

    const alphaSummary = projectSummaries.find((p) => p.id === "alpha");
    expect(alphaSummary?.sessionCount).toBe(2);
    // "merged" → done attention level → not active; "working" → working → active
    expect(alphaSummary?.activeCount).toBe(1);
    expect(alphaSummary?.attentionCounts.done).toBe(1);
    expect(alphaSummary?.attentionCounts.working).toBe(1);
  });

  it("handles getCachedPortfolioSessions failure gracefully", async () => {
    mockGetCachedPortfolioSessions.mockRejectedValue(new Error("network error"));

    const { loadPortfolioPageData } = await import("../portfolio-page-data");
    const { projectSummaries, sessions } = await loadPortfolioPageData();

    expect(sessions).toHaveLength(0);
    expect(projectSummaries).toHaveLength(3);
    expect(projectSummaries.every((p) => p.sessionCount === 0)).toBe(true);
  });

  it("marks stale projects and default project flags on summaries", async () => {
    mockLoadPreferences.mockReturnValue({ defaultProjectId: "alpha" });
    mockLoadGlobalConfig.mockReturnValue({ projects: {} });
    mockIsProjectShadowStale.mockImplementation((projectId: string) => projectId === "charlie");

    const { loadPortfolioPageData } = await import("../portfolio-page-data");
    const { projectSummaries } = await loadPortfolioPageData();

    expect(projectSummaries.find((project) => project.id === "alpha")?.isDefault).toBe(true);
    expect(projectSummaries.find((project) => project.id === "charlie")?.isStale).toBe(true);
  });
});
