import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SCM,
  Tracker,
  Issue,
  Session,
  ProjectConfig,
} from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
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

const mockTracker: Tracker & { listIssues: ReturnType<typeof vi.fn>; updateIssue: ReturnType<typeof vi.fn>; getIssue: ReturnType<typeof vi.fn> } = {
  name: "github",
  listIssues: vi.fn(),
  updateIssue: vi.fn(),
  getIssue: vi.fn(async () => ({ id: "1", title: "test", url: "" })),
  issueLabel: vi.fn(() => "#1"),
};

const mockSCM: SCM = {
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

const mockRegistry: PluginRegistry = {
  register: vi.fn(),
  get: vi.fn((type: string, _name: string) => {
    if (type === "tracker") return mockTracker;
    if (type === "scm") return mockSCM;
    return null;
  }) as unknown as PluginRegistry["get"],
  list: vi.fn(() => []),
  loadBuiltins: vi.fn(async () => {}),
  loadFromConfig: vi.fn(async () => {}),
};

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "My App",
    repo: "acme/my-app",
    path: "/tmp/my-app",
    defaultBranch: "main",
    sessionPrefix: "my-app",
    scm: { plugin: "github" },
    tracker: { plugin: "github" },
    ...overrides,
  };
}

const mockConfig: OrchestratorConfig = {
  configPath: "/tmp/ao-test/agent-orchestrator.yaml",
  port: 3000,
  readyThresholdMs: 300_000,
  defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
  projects: {
    "my-app": makeProject(),
    "docs-app": makeProject({
      name: "Docs App",
      repo: "acme/docs-app",
      path: "/tmp/docs-app",
      sessionPrefix: "docs",
    }),
  },
  notifiers: {},
  notificationRouting: { urgent: [], action: [], warning: [], info: [] },
  reactions: {},
};

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    projectId: "my-app",
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

vi.mock("@composio/ao-core", async () => {
  const actual = await vi.importActual<typeof import("@composio/ao-core")>("@composio/ao-core");
  return {
    ...actual,
    loadConfig: vi.fn(() => mockConfig),
    createPluginRegistry: vi.fn(() => mockRegistry),
    createSessionManager: vi.fn(() => mockSessionManager),
    createLifecycleManager: vi.fn(() => ({ start: vi.fn() })),
  };
});

vi.mock("@composio/ao-plugin-runtime-tmux", () => ({ default: { name: "tmux", type: "runtime" } }));
vi.mock("@composio/ao-plugin-agent-claude-code", () => ({ default: { name: "claude-code", type: "agent" } }));
vi.mock("@composio/ao-plugin-agent-opencode", () => ({ default: { name: "opencode", type: "agent" } }));
vi.mock("@composio/ao-plugin-workspace-worktree", () => ({ default: { name: "worktree", type: "workspace" } }));
vi.mock("@composio/ao-plugin-scm-github", () => ({ default: { name: "github", type: "scm" } }));
vi.mock("@composio/ao-plugin-tracker-github", () => ({ default: { name: "github", type: "tracker" } }));
vi.mock("@composio/ao-plugin-tracker-linear", () => ({ default: { name: "linear", type: "tracker" } }));

// Import after mocks
import {
  getServices,
  getBacklogIssues,
  getVerifyIssues,
  pollBacklog,
  startBacklogPoller,
  getSCM,
} from "@/lib/services";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getSCM", () => {
  it("returns SCM from registry when project has scm config", () => {
    const result = getSCM(mockRegistry, makeProject());
    expect(result).toBe(mockSCM);
  });

  it("returns null when project is undefined", () => {
    expect(getSCM(mockRegistry, undefined)).toBeNull();
  });

  it("returns null when project has no scm config", () => {
    expect(getSCM(mockRegistry, makeProject({ scm: undefined }))).toBeNull();
  });
});

describe("getServices", () => {
  beforeEach(() => {
    // Clear cached singleton between tests
    const g = globalThis as Record<string, unknown>;
    delete g._aoServices;
    delete g._aoServicesInit;
  });

  it("returns services singleton", async () => {
    const services = await getServices();
    expect(services).toHaveProperty("config");
    expect(services).toHaveProperty("registry");
    expect(services).toHaveProperty("sessionManager");
  });

  it("returns the same instance on subsequent calls", async () => {
    const first = await getServices();
    const second = await getServices();
    expect(first).toBe(second);
  });
});

describe("getBacklogIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure services are initialized
    const g = globalThis as Record<string, unknown>;
    g._aoServices = {
      config: mockConfig,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      lifecycleManager: { start: vi.fn() },
    };
  });

  it("returns issues from all projects with projectId", async () => {
    const issue1: Issue = { id: "1", title: "Bug fix", description: "", url: "https://github.com/acme/my-app/issues/1", labels: ["agent:backlog"], state: "open" };
    const issue2: Issue = { id: "2", title: "Add docs", description: "", url: "https://github.com/acme/docs-app/issues/2", labels: ["agent:backlog"], state: "open" };
    mockTracker.listIssues.mockResolvedValueOnce([issue1]).mockResolvedValueOnce([issue2]);

    const result = await getBacklogIssues();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(expect.objectContaining({ id: "1", projectId: "my-app" }));
    expect(result[1]).toEqual(expect.objectContaining({ id: "2", projectId: "docs-app" }));
  });

  it("skips projects without tracker config", async () => {
    const configNoTracker: OrchestratorConfig = {
      ...mockConfig,
      projects: {
        "my-app": makeProject({ tracker: undefined }),
      },
    };
    const g = globalThis as Record<string, unknown>;
    g._aoServices = {
      config: configNoTracker,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      lifecycleManager: { start: vi.fn() },
    };

    const result = await getBacklogIssues();
    expect(result).toHaveLength(0);
    expect(mockTracker.listIssues).not.toHaveBeenCalled();
  });

  it("skips projects where tracker.listIssues throws", async () => {
    mockTracker.listIssues
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce([{ id: "2", title: "Add docs", description: "", url: "", labels: [], state: "open" }]);

    const result = await getBacklogIssues();
    expect(result).toHaveLength(1);
    expect(result[0].projectId).toBe("docs-app");
  });

  it("returns empty array when services are unavailable", async () => {
    const g = globalThis as Record<string, unknown>;
    delete g._aoServices;
    delete g._aoServicesInit;
    // Make getServices reject
    const { loadConfig } = await import("@composio/ao-core");
    (loadConfig as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("Config not found");
    });

    const result = await getBacklogIssues();
    expect(result).toEqual([]);
  });
});

describe("getVerifyIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const g = globalThis as Record<string, unknown>;
    g._aoServices = {
      config: mockConfig,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      lifecycleManager: { start: vi.fn() },
    };
  });

  it("returns issues labeled merged-unverified across projects", async () => {
    const issue: Issue = { id: "10", title: "Verify fix", description: "", url: "", labels: ["merged-unverified"], state: "open" };
    mockTracker.listIssues.mockResolvedValueOnce([issue]).mockResolvedValueOnce([]);

    const result = await getVerifyIssues();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ id: "10", projectId: "my-app" }));
  });

  it("skips projects without tracker", async () => {
    const g = globalThis as Record<string, unknown>;
    g._aoServices = {
      config: {
        ...mockConfig,
        projects: { "no-tracker": makeProject({ tracker: undefined }) },
      },
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      lifecycleManager: { start: vi.fn() },
    };

    const result = await getVerifyIssues();
    expect(result).toHaveLength(0);
  });

  it("handles tracker errors gracefully", async () => {
    mockTracker.listIssues.mockRejectedValue(new Error("fail"));
    const result = await getVerifyIssues();
    expect(result).toEqual([]);
  });
});

describe("pollBacklog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const g = globalThis as Record<string, unknown>;
    g._aoServices = {
      config: mockConfig,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      lifecycleManager: { start: vi.fn() },
    };
    mockSessionManager.list.mockResolvedValue([]);
    mockTracker.listIssues.mockResolvedValue([]);
    mockTracker.updateIssue.mockResolvedValue(undefined);
  });

  it("does not spawn when backlog is empty", async () => {
    mockTracker.listIssues.mockResolvedValue([]);
    await pollBacklog();
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("spawns a session for each backlog issue", async () => {
    const issue: Issue = { id: "FRESH-1", title: "New feature", description: "", url: "", labels: ["agent:backlog"], state: "open" };
    mockTracker.listIssues.mockResolvedValue([issue]);

    await pollBacklog();
    expect(mockSessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "FRESH-1" }),
    );
  });

  it("skips issues already being worked on", async () => {
    const activeSession = makeSession({
      id: "my-app-1",
      issueId: "ACTIVE-1",
      status: "working",
      activity: "active",
    });
    mockSessionManager.list.mockResolvedValue([activeSession]);

    const issue: Issue = { id: "ACTIVE-1", title: "Active", description: "", url: "", labels: ["agent:backlog"], state: "open" };
    mockTracker.listIssues.mockResolvedValue([issue]);

    await pollBacklog();
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("respects max concurrent agents", async () => {
    // Create 5 active worker sessions (at capacity)
    const activeSessions = Array.from({ length: 5 }, (_, i) =>
      makeSession({ id: `worker-${i}`, status: "working", activity: "active" }),
    );
    mockSessionManager.list.mockResolvedValue(activeSessions);

    const issue: Issue = { id: "EXTRA-1", title: "Extra", description: "", url: "", labels: ["agent:backlog"], state: "open" };
    mockTracker.listIssues.mockResolvedValue([issue]);

    await pollBacklog();
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("handles spawn errors gracefully", async () => {
    const issue: Issue = { id: "ERR-1", title: "Error issue", description: "", url: "", labels: ["agent:backlog"], state: "open" };
    mockTracker.listIssues.mockResolvedValue([issue]);
    mockSessionManager.spawn.mockRejectedValue(new Error("spawn failed"));

    // Should not throw
    await expect(pollBacklog()).resolves.toBeUndefined();
  });

  it("labels merged issues for verification", async () => {
    const mergedSession = makeSession({
      id: "merged-1",
      status: "merged",
      issueId: "MERGE-1",
      metadata: {},
    });
    mockSessionManager.list.mockResolvedValue([mergedSession]);
    mockTracker.listIssues.mockResolvedValue([]);

    await pollBacklog();
    expect(mockTracker.updateIssue).toHaveBeenCalledWith(
      "MERGE-1",
      expect.objectContaining({
        labels: ["merged-unverified"],
        removeLabels: expect.arrayContaining(["agent:backlog"]),
      }),
      expect.anything(),
    );
  });

  it("does not re-label already processed merged issues", async () => {
    // First call processes the issue
    const mergedSession = makeSession({
      id: "merged-2",
      status: "merged",
      issueId: "MERGE-ONCE",
      metadata: {},
    });
    mockSessionManager.list.mockResolvedValue([mergedSession]);
    mockTracker.listIssues.mockResolvedValue([]);

    await pollBacklog();
    const firstCallCount = mockTracker.updateIssue.mock.calls.length;

    // Second call should skip it (already processed)
    await pollBacklog();
    // updateIssue should not have been called again for this issue
    const secondCallCount = mockTracker.updateIssue.mock.calls.length;
    expect(secondCallCount).toBe(firstCallCount);
  });

  it("handles getServices failure gracefully", async () => {
    const g = globalThis as Record<string, unknown>;
    delete g._aoServices;
    delete g._aoServicesInit;

    const { loadConfig } = await import("@composio/ao-core");
    (loadConfig as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("No config");
    });

    await expect(pollBacklog()).resolves.toBeUndefined();
  });
});

describe("startBacklogPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const g = globalThis as Record<string, unknown>;
    g._aoServices = {
      config: mockConfig,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      lifecycleManager: { start: vi.fn() },
    };
    delete g._aoBacklogStarted;
    delete g._aoBacklogTimer;
    mockSessionManager.list.mockResolvedValue([]);
    mockTracker.listIssues.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    const g = globalThis as Record<string, unknown>;
    if (g._aoBacklogTimer) {
      clearInterval(g._aoBacklogTimer as ReturnType<typeof setInterval>);
    }
    delete g._aoBacklogStarted;
    delete g._aoBacklogTimer;
  });

  it("starts polling idempotently", () => {
    startBacklogPoller();
    startBacklogPoller(); // second call should be a no-op
    const g = globalThis as Record<string, unknown>;
    expect(g._aoBacklogStarted).toBe(true);
  });
});
