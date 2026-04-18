import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetServices = vi.fn();

vi.mock("@aoagents/ao-core", () => ({
  generateOrchestratorPrompt: vi.fn(() => "system prompt"),
  isOrchestratorSession: vi.fn(() => true),
}));

vi.mock("@/lib/services", () => ({
  getServices: (...args: unknown[]) => mockGetServices(...args),
}));

import { ensureProjectOrchestrator } from "../ensure-project-orchestrator";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-18T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ensureProjectOrchestrator", () => {
  const mockSessionManager = {
    list: vi.fn(),
    spawnOrchestrator: vi.fn(),
  };

  beforeEach(() => {
    mockSessionManager.list.mockReset();
    mockSessionManager.spawnOrchestrator.mockReset();
  });

  it("returns null when project is not in config", async () => {
    mockGetServices.mockResolvedValue({
      config: { projects: {} },
      sessionManager: mockSessionManager,
    });

    const result = await ensureProjectOrchestrator("unknown");
    expect(result).toBeNull();
  });

  it("returns null when the project is degraded", async () => {
    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": { resolveError: "Malformed local config" } } },
      sessionManager: mockSessionManager,
    });

    const result = await ensureProjectOrchestrator("my-app");
    expect(result).toBeNull();
    expect(mockSessionManager.list).not.toHaveBeenCalled();
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
  });

  it("returns existing orchestrator if found", async () => {
    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": { name: "My App" } } },
      sessionManager: mockSessionManager,
    });
    mockSessionManager.list.mockResolvedValue([
      {
        id: "my-app-orchestrator-1",
        projectId: "my-app",
        status: "working",
        activity: "active",
        lastActivityAt: new Date("2026-04-18T11:59:00.000Z"),
        metadata: { role: "orchestrator" },
      },
    ]);

    const result = await ensureProjectOrchestrator("my-app");
    expect(result).toEqual({
      id: "my-app-orchestrator-1",
      projectId: "my-app",
      projectName: "My App",
    });
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
  });

  it("spawns a new orchestrator when none exists", async () => {
    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": { name: "My App" } } },
      sessionManager: mockSessionManager,
    });
    mockSessionManager.list.mockResolvedValue([]);
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
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "orch-new" });

    const pendingA = ensureProjectOrchestrator("my-app");
    const pendingB = ensureProjectOrchestrator("my-app");

    await expect(Promise.all([pendingA, pendingB])).resolves.toEqual([
      { id: "orch-new", projectId: "my-app", projectName: "My App" },
      { id: "orch-new", projectId: "my-app", projectName: "My App" },
    ]);
    expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledTimes(1);
  });

  it("returns a ready orchestrator without spawning a replacement", async () => {
    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": { name: "My App" } } },
      sessionManager: mockSessionManager,
    });
    mockSessionManager.list.mockResolvedValue([
      {
        id: "my-app-orchestrator-2",
        projectId: "my-app",
        status: "working",
        activity: "ready",
        lastActivityAt: new Date("2026-04-18T11:57:00.000Z"),
        metadata: { role: "orchestrator" },
      },
    ]);

    const result = await ensureProjectOrchestrator("my-app");

    expect(result).toEqual({
      id: "my-app-orchestrator-2",
      projectId: "my-app",
      projectName: "My App",
    });
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
  });

  it("replaces a stuck orchestrator", async () => {
    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": { name: "My App" } } },
      sessionManager: mockSessionManager,
    });
    mockSessionManager.list.mockResolvedValue([
      {
        id: "my-app-orchestrator-3",
        projectId: "my-app",
        status: "stuck",
        activity: "idle",
        lastActivityAt: new Date("2026-04-18T11:59:00.000Z"),
        metadata: { role: "orchestrator" },
      },
    ]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "orch-new" });

    const result = await ensureProjectOrchestrator("my-app");

    expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: "orch-new", projectId: "my-app", projectName: "My App" });
  });

  it("keeps a recently idle orchestrator as current", async () => {
    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": { name: "My App" } } },
      sessionManager: mockSessionManager,
    });
    mockSessionManager.list.mockResolvedValue([
      {
        id: "my-app-orchestrator-4",
        projectId: "my-app",
        status: "working",
        activity: "idle",
        lastActivityAt: new Date("2026-04-18T11:55:30.000Z"),
        metadata: { role: "orchestrator" },
      },
    ]);

    const result = await ensureProjectOrchestrator("my-app");

    expect(result).toEqual({
      id: "my-app-orchestrator-4",
      projectId: "my-app",
      projectName: "My App",
    });
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
  });

  it("replaces an idle orchestrator once it is stale", async () => {
    mockGetServices.mockResolvedValue({
      config: { projects: { "my-app": { name: "My App" } } },
      sessionManager: mockSessionManager,
    });
    mockSessionManager.list.mockResolvedValue([
      {
        id: "my-app-orchestrator-5",
        projectId: "my-app",
        status: "working",
        activity: "idle",
        lastActivityAt: new Date("2026-04-18T11:49:59.000Z"),
        metadata: { role: "orchestrator" },
      },
    ]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "orch-new" });

    const result = await ensureProjectOrchestrator("my-app");

    expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: "orch-new", projectId: "my-app", projectName: "My App" });
  });
});
