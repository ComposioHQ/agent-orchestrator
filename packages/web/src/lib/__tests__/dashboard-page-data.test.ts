import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAllProjectsMock, getPrimaryProjectIdMock, getProjectNameMock } = vi.hoisted(() => ({
  getAllProjectsMock: vi.fn(),
  getPrimaryProjectIdMock: vi.fn(),
  getProjectNameMock: vi.fn(),
}));

vi.mock("@/lib/project-name", () => ({
  getAllProjects: getAllProjectsMock,
  getPrimaryProjectId: getPrimaryProjectIdMock,
  getProjectName: getProjectNameMock,
}));

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(),
  getSCM: vi.fn(),
}));

// React cache is a no-op in test — just call through
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    cache: (fn: (...args: unknown[]) => unknown) => fn,
  };
});

import {
  resolveDashboardProjectFilter,
  getDashboardProjectName,
} from "@/lib/dashboard-page-data";

describe("resolveDashboardProjectFilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllProjectsMock.mockReturnValue([
      { id: "mono", name: "Mono" },
      { id: "docs", name: "Docs" },
    ]);
    getPrimaryProjectIdMock.mockReturnValue("mono");
    getProjectNameMock.mockReturnValue("Mono");
  });

  it("keeps valid project ids", () => {
    expect(resolveDashboardProjectFilter("docs")).toBe("docs");
  });

  it("keeps the all-projects sentinel", () => {
    expect(resolveDashboardProjectFilter("all")).toBe("all");
  });

  it("falls back to primary project for unknown ids", () => {
    expect(resolveDashboardProjectFilter("mono-orchestrator")).toBe("mono");
  });

  it("falls back to primary project when no project is given", () => {
    expect(resolveDashboardProjectFilter(undefined)).toBe("mono");
  });
});

describe("getDashboardProjectName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllProjectsMock.mockReturnValue([
      { id: "mono", name: "Mono" },
      { id: "docs", name: "Docs" },
    ]);
    getPrimaryProjectIdMock.mockReturnValue("mono");
    getProjectNameMock.mockReturnValue("Mono");
  });

  it('returns "All Projects" for the "all" filter', () => {
    expect(getDashboardProjectName("all")).toBe("All Projects");
  });

  it("returns the selected project name for a valid project id", () => {
    expect(getDashboardProjectName("docs")).toBe("Docs");
  });

  it("falls back to getProjectName() for an unknown project id", () => {
    expect(getDashboardProjectName("unknown-project")).toBe("Mono");
  });

  it("falls back to getProjectName() when undefined", () => {
    expect(getDashboardProjectName(undefined)).toBe("Mono");
  });

  it("returns the first project name when called with the primary project id", () => {
    expect(getDashboardProjectName("mono")).toBe("Mono");
  });
});

// ---------------------------------------------------------------------------
// getDashboardPageData — covers lines 47-132
// ---------------------------------------------------------------------------

const mockSessionManager = {
  list: vi.fn(),
  get: vi.fn(),
  spawn: vi.fn(),
  kill: vi.fn(),
  send: vi.fn(),
  cleanup: vi.fn(),
  spawnOrchestrator: vi.fn(),
  remap: vi.fn(),
  restore: vi.fn(),
};

const mockSCM = {
  name: "github",
  detectPR: vi.fn(async () => null),
  getPRState: vi.fn(async () => "open" as const),
  mergePR: vi.fn(async () => {}),
  closePR: vi.fn(async () => {}),
  getCIChecks: vi.fn(async () => []),
  getCISummary: vi.fn(async () => "passing" as const),
  getReviews: vi.fn(async () => []),
  getReviewDecision: vi.fn(async () => "approved" as const),
  getPendingComments: vi.fn(async () => []),
  getAutomatedComments: vi.fn(async () => []),
  getMergeability: vi.fn(async () => ({
    mergeable: true,
    ciPassing: true,
    approved: true,
    noConflicts: true,
    blockers: [],
  })),
};

const mockRegistry = {
  register: vi.fn(),
  get: vi.fn(() => mockSCM),
  list: vi.fn(() => []),
  loadBuiltins: vi.fn(async () => {}),
  loadFromConfig: vi.fn(async () => {}),
};

const mockConfig = {
  configPath: "/tmp/ao-test/agent-orchestrator.yaml",
  port: 3000,
  readyThresholdMs: 300_000,
  defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
  projects: {
    mono: {
      name: "Mono",
      repo: "acme/mono",
      path: "/tmp/mono",
      defaultBranch: "main",
      sessionPrefix: "mono",
      scm: { plugin: "github" },
    },
    docs: {
      name: "Docs",
      repo: "acme/docs",
      path: "/tmp/docs",
      defaultBranch: "main",
      sessionPrefix: "docs",
      scm: { plugin: "github" },
    },
  },
  notifiers: {},
  notificationRouting: { urgent: [], action: [], warning: [], info: [] },
  reactions: {},
};

function makeSession(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "mono",
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

vi.mock("@/lib/global-pause", () => ({
  resolveGlobalPause: vi.fn(() => null),
}));

const { getServices: getServicesMock, getSCM: getSCMMock } = vi.mocked(
  await import("@/lib/services"),
);

import { getDashboardPageData } from "@/lib/dashboard-page-data";

describe("getDashboardPageData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllProjectsMock.mockReturnValue([
      { id: "mono", name: "Mono" },
      { id: "docs", name: "Docs" },
    ]);
    getPrimaryProjectIdMock.mockReturnValue("mono");
    getProjectNameMock.mockReturnValue("Mono");

    (getServicesMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: mockConfig,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      lifecycleManager: { start: vi.fn() },
    });
    (getSCMMock as ReturnType<typeof vi.fn>).mockReturnValue(mockSCM);
    mockSessionManager.list.mockResolvedValue([]);
  });

  it("returns default page data when no sessions exist", async () => {
    const data = await getDashboardPageData("mono");
    expect(data.sessions).toEqual([]);
    expect(data.projectName).toBe("Mono");
    expect(data.orchestrators).toEqual([]);
    expect(data.globalPause).toBeNull();
    expect(data.projects).toHaveLength(2);
  });

  it("returns sessions filtered by project", async () => {
    mockSessionManager.list.mockResolvedValue([
      makeSession("mono-1", { projectId: "mono" }),
      makeSession("docs-1", { projectId: "docs" }),
    ]);

    const data = await getDashboardPageData("mono");
    // Should only contain mono sessions (workers, not orchestrators)
    expect(data.sessions.every((s) => s.projectId === "mono")).toBe(true);
  });

  it("returns all sessions when project is 'all'", async () => {
    mockSessionManager.list.mockResolvedValue([
      makeSession("mono-1", { projectId: "mono" }),
      makeSession("docs-1", { projectId: "docs" }),
    ]);

    const data = await getDashboardPageData("all");
    expect(data.sessions).toHaveLength(2);
    expect(data.selectedProjectId).toBeUndefined();
  });

  it("handles sessions with PR enrichment from cache", async () => {
    const sessionWithPR = makeSession("mono-pr", {
      projectId: "mono",
      status: "review_pending",
      pr: {
        number: 100,
        url: "https://github.com/acme/mono/pull/100",
        title: "feat: test",
        owner: "acme",
        repo: "mono",
        branch: "feat/test",
        baseBranch: "main",
        isDraft: false,
      },
    });
    mockSessionManager.list.mockResolvedValue([sessionWithPR]);

    const data = await getDashboardPageData("mono");
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].pr).toBeTruthy();
    expect(data.sessions[0].pr!.number).toBe(100);
  });

  it("handles getServices failure gracefully", async () => {
    (getServicesMock as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Service init failed"),
    );

    const data = await getDashboardPageData("mono");
    expect(data.sessions).toEqual([]);
    expect(data.globalPause).toBeNull();
    expect(data.orchestrators).toEqual([]);
  });

  it("filters out orchestrator sessions from worker list", async () => {
    mockSessionManager.list.mockResolvedValue([
      makeSession("mono-orchestrator", { projectId: "mono", metadata: { role: "orchestrator" } }),
      makeSession("mono-1", { projectId: "mono" }),
    ]);

    const data = await getDashboardPageData("mono");
    // Orchestrator should not appear in sessions (workers only)
    expect(data.sessions.find((s) => s.id === "mono-orchestrator")).toBeUndefined();
  });

  it("sets selectedProjectId for single project filter", async () => {
    const data = await getDashboardPageData("mono");
    expect(data.selectedProjectId).toBe("mono");
  });
});
