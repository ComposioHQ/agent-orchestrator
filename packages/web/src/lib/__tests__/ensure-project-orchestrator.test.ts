import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetServices = vi.fn();
const mockListDashboardOrchestrators = vi.fn();

vi.mock("@aoagents/ao-core", () => ({
  generateOrchestratorPrompt: vi.fn(() => "system prompt"),
  isOrchestratorSession: vi.fn(() => true),
}));

vi.mock("@/lib/services", () => ({
  getServices: (...args: unknown[]) => mockGetServices(...args),
}));

vi.mock("@/lib/serialize", () => ({
  listDashboardOrchestrators: (...args: unknown[]) => mockListDashboardOrchestrators(...args),
}));

import { ensureProjectOrchestrator } from "../ensure-project-orchestrator";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureProjectOrchestrator", () => {
  const mockSessionManager = {
    list: vi.fn(),
    spawnOrchestrator: vi.fn(),
  };

  it("returns null when project is not in config", async () => {
    mockGetServices.mockResolvedValue({
      config: { projects: {} },
      sessionManager: mockSessionManager,
    });

    const result = await ensureProjectOrchestrator("unknown");
    expect(result).toBeNull();
  });

  it("returns existing orchestrator if found", async () => {
    const existing = { id: "orch-1", projectId: "my-app", projectName: "My App" };
    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": { name: "My App" } } },
      sessionManager: mockSessionManager,
    });
    mockSessionManager.list.mockResolvedValue([{ id: "orch-1" }]);
    mockListDashboardOrchestrators.mockReturnValue([existing]);

    const result = await ensureProjectOrchestrator("my-app");
    expect(result).toEqual(existing);
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
  });

  it("spawns a new orchestrator when none exists", async () => {
    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": { name: "My App" } } },
      sessionManager: mockSessionManager,
    });
    mockSessionManager.list.mockResolvedValue([]);
    mockListDashboardOrchestrators.mockReturnValue([]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "orch-new" });

    const result = await ensureProjectOrchestrator("my-app");
    expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledWith({
      projectId: "my-app",
      systemPrompt: "system prompt",
    });
    expect(result).toEqual({
      id: "orch-new",
      projectId: "my-app",
      projectName: "My App",
    });
  });

  it("uses projectId as name when project.name is undefined", async () => {
    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": {} } },
      sessionManager: mockSessionManager,
    });
    mockSessionManager.list.mockResolvedValue([]);
    mockListDashboardOrchestrators.mockReturnValue([]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "orch-new" });

    const result = await ensureProjectOrchestrator("my-app");
    expect(result).toEqual({
      id: "orch-new",
      projectId: "my-app",
      projectName: "my-app",
    });
  });

  it("deduplicates concurrent orchestrator spawn attempts per project", async () => {
    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": { name: "My App" } } },
      sessionManager: mockSessionManager,
    });
    mockSessionManager.list.mockResolvedValue([]);
    mockListDashboardOrchestrators.mockReturnValue([]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "orch-new" });

    const pendingA = ensureProjectOrchestrator("my-app");
    const pendingB = ensureProjectOrchestrator("my-app");

    await expect(Promise.all([pendingA, pendingB])).resolves.toEqual([
      { id: "orch-new", projectId: "my-app", projectName: "My App" },
      { id: "orch-new", projectId: "my-app", projectName: "My App" },
    ]);
    expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledTimes(1);
  });
});
