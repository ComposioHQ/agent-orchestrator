import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetCachedPortfolioSessions = vi.fn();
const mockGetServices = vi.fn();
const mockSessionToDashboard = vi.fn();
const mockEnrichSessionsMetadata = vi.fn();

vi.mock("@aoagents/ao-core", () => ({
  isOrchestratorSession: vi.fn((s: { id: string }) => s.id.startsWith("orch-")),
}));

vi.mock("@/lib/portfolio-services", () => ({
  getCachedPortfolioSessions: (...args: unknown[]) => mockGetCachedPortfolioSessions(...args),
}));

vi.mock("@/lib/services", () => ({
  getServices: (...args: unknown[]) => mockGetServices(...args),
}));

vi.mock("@/lib/serialize", () => ({
  sessionToDashboard: (...args: unknown[]) => mockSessionToDashboard(...args),
  enrichSessionsMetadata: (...args: unknown[]) => mockEnrichSessionsMetadata(...args),
}));

import { loadHomeActivityData } from "../home-activity-data";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServices.mockResolvedValue({ config: {}, registry: {} });
  mockEnrichSessionsMetadata.mockResolvedValue(undefined);
});

describe("loadHomeActivityData", () => {
  it("returns empty activity items when no sessions exist", async () => {
    mockGetCachedPortfolioSessions.mockResolvedValue([]);

    const { activityItems } = await loadHomeActivityData();
    expect(activityItems).toEqual([]);
  });

  it("filters out orchestrator sessions", async () => {
    const sessions = [
      { session: { id: "orch-1", projectId: "app" }, project: { id: "app", name: "App" } },
      { session: { id: "worker-1", projectId: "app" }, project: { id: "app", name: "App" } },
    ];
    mockGetCachedPortfolioSessions.mockResolvedValue(sessions);
    mockSessionToDashboard.mockImplementation((s: { id: string }) => ({
      id: s.id,
      lastActivityAt: new Date().toISOString(),
    }));

    const { activityItems } = await loadHomeActivityData();
    expect(activityItems).toHaveLength(1);
    expect(activityItems[0].session.id).toBe("worker-1");
  });

  it("sorts by lastActivityAt descending", async () => {
    const sessions = [
      { session: { id: "s1", projectId: "app" }, project: { id: "app", name: "App" } },
      { session: { id: "s2", projectId: "app" }, project: { id: "app", name: "App" } },
    ];
    mockGetCachedPortfolioSessions.mockResolvedValue(sessions);
    mockSessionToDashboard
      .mockReturnValueOnce({ id: "s1", lastActivityAt: "2024-01-01T00:00:00Z" })
      .mockReturnValueOnce({ id: "s2", lastActivityAt: "2024-06-01T00:00:00Z" });

    const { activityItems } = await loadHomeActivityData();
    expect(activityItems[0].session.id).toBe("s2");
    expect(activityItems[1].session.id).toBe("s1");
  });

  it("includes project info in activity items", async () => {
    const sessions = [
      { session: { id: "s1", projectId: "app" }, project: { id: "app", name: "My App" } },
    ];
    mockGetCachedPortfolioSessions.mockResolvedValue(sessions);
    mockSessionToDashboard.mockReturnValue({
      id: "s1",
      lastActivityAt: new Date().toISOString(),
    });

    const { activityItems } = await loadHomeActivityData();
    expect(activityItems[0].projectId).toBe("app");
    expect(activityItems[0].projectName).toBe("My App");
  });

  it("handles getCachedPortfolioSessions failure gracefully", async () => {
    mockGetCachedPortfolioSessions.mockRejectedValue(new Error("fail"));

    const { activityItems } = await loadHomeActivityData();
    expect(activityItems).toEqual([]);
  });

  it("handles enrichment failure gracefully", async () => {
    const sessions = [
      { session: { id: "s1", projectId: "app" }, project: { id: "app", name: "App" } },
    ];
    mockGetCachedPortfolioSessions.mockResolvedValue(sessions);
    mockSessionToDashboard.mockReturnValue({
      id: "s1",
      lastActivityAt: new Date().toISOString(),
    });
    mockGetServices.mockRejectedValue(new Error("services fail"));

    const { activityItems } = await loadHomeActivityData();
    expect(activityItems).toHaveLength(1);
  });
});
