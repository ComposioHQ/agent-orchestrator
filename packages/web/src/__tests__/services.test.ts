import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { utimesSync, writeFileSync } from "node:fs";

const {
  mockLoadConfig,
  mockRegister,
  mockCreateSessionManager,
  mockCreateLifecycleManager,
  mockRegistry,
  tmuxPlugin,
  claudePlugin,
  opencodePlugin,
  worktreePlugin,
  scmPlugin,
  trackerGithubPlugin,
  trackerLinearPlugin,
} = vi.hoisted(() => {
  const mockLoadConfig = vi.fn();
  const mockRegister = vi.fn();
  const mockCreateSessionManager = vi.fn();
  const mockCreateLifecycleManager = vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    getStates: vi.fn(),
    check: vi.fn(),
  }));
  const mockRegistry = {
    register: mockRegister,
    get: vi.fn(),
    list: vi.fn(),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };

  return {
    mockLoadConfig,
    mockRegister,
    mockCreateSessionManager,
    mockCreateLifecycleManager,
    mockRegistry,
    tmuxPlugin: { manifest: { name: "tmux" } },
    claudePlugin: { manifest: { name: "claude-code" } },
    opencodePlugin: { manifest: { name: "opencode" } },
    worktreePlugin: { manifest: { name: "worktree" } },
    scmPlugin: { manifest: { name: "github" } },
    trackerGithubPlugin: { manifest: { name: "github" } },
    trackerLinearPlugin: { manifest: { name: "linear" } },
  };
});

vi.mock("@composio/ao-core", () => ({
  loadConfig: mockLoadConfig,
  createPluginRegistry: () => mockRegistry,
  createSessionManager: mockCreateSessionManager,
  createLifecycleManager: mockCreateLifecycleManager,
  decompose: vi.fn(),
  getLeaves: vi.fn(),
  getSiblings: vi.fn(),
  formatPlanTree: vi.fn(),
  DEFAULT_DECOMPOSER_CONFIG: {},
  TERMINAL_STATUSES: new Set(["merged", "killed"]) as ReadonlySet<string>,
}));

vi.mock("@composio/ao-plugin-runtime-tmux", () => ({ default: tmuxPlugin }));
vi.mock("@composio/ao-plugin-agent-claude-code", () => ({ default: claudePlugin }));
vi.mock("@composio/ao-plugin-agent-opencode", () => ({ default: opencodePlugin }));
vi.mock("@composio/ao-plugin-workspace-worktree", () => ({ default: worktreePlugin }));
vi.mock("@composio/ao-plugin-scm-github", () => ({ default: scmPlugin }));
vi.mock("@composio/ao-plugin-tracker-github", () => ({ default: trackerGithubPlugin }));
vi.mock("@composio/ao-plugin-tracker-linear", () => ({ default: trackerLinearPlugin }));

describe("services", () => {
  beforeEach(() => {
    vi.resetModules();
    mockRegister.mockClear();
    mockCreateSessionManager.mockReset();
    mockCreateLifecycleManager.mockReset();
    mockLoadConfig.mockReset();
    mockCreateLifecycleManager.mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      getStates: vi.fn(),
      check: vi.fn(),
    }));
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {},
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    });
    mockCreateSessionManager.mockReturnValue({});
    writeFileSync("/tmp/agent-orchestrator.yaml", "projects: {}\n");
    delete (globalThis as typeof globalThis & { _aoConfigCache?: unknown })._aoConfigCache;
    delete (globalThis as typeof globalThis & { _aoServices?: unknown })._aoServices;
    delete (globalThis as typeof globalThis & { _aoServicesInit?: unknown })._aoServicesInit;
    delete (globalThis as typeof globalThis & { _aoServicesConfig?: unknown })._aoServicesConfig;
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { _aoConfigCache?: unknown })._aoConfigCache;
    delete (globalThis as typeof globalThis & { _aoServices?: unknown })._aoServices;
    delete (globalThis as typeof globalThis & { _aoServicesInit?: unknown })._aoServicesInit;
    delete (globalThis as typeof globalThis & { _aoServicesConfig?: unknown })._aoServicesConfig;
  });

  it("registers the OpenCode agent plugin with web services", async () => {
    const { getServices } = await import("../lib/services");

    await getServices();

    expect(mockRegister).toHaveBeenCalledWith(opencodePlugin);
  });

  it("caches initialized services across repeated calls", async () => {
    const { getServices } = await import("../lib/services");

    const first = await getServices();
    const second = await getServices();

    expect(first).toBe(second);
    expect(mockCreateSessionManager).toHaveBeenCalledTimes(1);
  });

  it("reloads cached config when the config file changes", async () => {
    mockLoadConfig
      .mockReturnValueOnce({
        configPath: "/tmp/agent-orchestrator.yaml",
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {},
        notifiers: {},
        notificationRouting: { urgent: [], action: [], warning: [], info: [] },
        reactions: {},
      })
      .mockReturnValueOnce({
        configPath: "/tmp/agent-orchestrator.yaml",
        port: 4000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {},
        notifiers: {},
        notificationRouting: { urgent: [], action: [], warning: [], info: [] },
        reactions: {},
      });

    const { getCachedConfig } = await import("../lib/services");

    const first = getCachedConfig();
    const changedAt = new Date(Date.now() + 5_000);
    utimesSync("/tmp/agent-orchestrator.yaml", changedAt, changedAt);
    const second = getCachedConfig();

    expect(first.port).toBe(3000);
    expect(second.port).toBe(4000);
    expect(mockLoadConfig).toHaveBeenCalledTimes(2);
  });

  it("rebuilds cached services when the config file changes", async () => {
    mockLoadConfig
      .mockReturnValueOnce({
        configPath: "/tmp/agent-orchestrator.yaml",
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {},
        notifiers: {},
        notificationRouting: { urgent: [], action: [], warning: [], info: [] },
        reactions: {},
      })
      .mockReturnValueOnce({
        configPath: "/tmp/agent-orchestrator.yaml",
        port: 4000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {},
        notifiers: {},
        notificationRouting: { urgent: [], action: [], warning: [], info: [] },
        reactions: {},
      });

    mockCreateSessionManager
      .mockReturnValueOnce({ name: "session-manager-1" })
      .mockReturnValueOnce({ name: "session-manager-2" });

    const { getServices } = await import("../lib/services");

    const first = await getServices();
    const firstLifecycle = mockCreateLifecycleManager.mock.results[0]?.value as
      | { stop: ReturnType<typeof vi.fn> }
      | undefined;

    const changedAt = new Date(Date.now() + 5_000);
    utimesSync("/tmp/agent-orchestrator.yaml", changedAt, changedAt);

    const second = await getServices();

    expect(first).not.toBe(second);
    expect(first.config.port).toBe(3000);
    expect(second.config.port).toBe(4000);
    expect(mockCreateSessionManager).toHaveBeenCalledTimes(2);
    expect(firstLifecycle?.stop).toHaveBeenCalledTimes(1);
  });
});

describe("pollBacklog", () => {
  const mockUpdateIssue = vi.fn();
  const mockListIssues = vi.fn();
  const mockSpawn = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    mockRegister.mockClear();
    mockCreateSessionManager.mockReset();
    mockLoadConfig.mockReset();
    mockUpdateIssue.mockClear();
    mockListIssues.mockClear();
    mockSpawn.mockClear();

    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        "test-project": {
          path: "/tmp/test-project",
          tracker: { plugin: "github" },
          backlog: { label: "agent:backlog", maxConcurrent: 5 },
        },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    });

    mockCreateSessionManager.mockReturnValue({
      spawn: mockSpawn,
      list: vi.fn().mockResolvedValue([]),
    });

    writeFileSync("/tmp/agent-orchestrator.yaml", "projects: {}\n");
    delete (globalThis as typeof globalThis & { _aoConfigCache?: unknown })._aoConfigCache;
    delete (globalThis as typeof globalThis & { _aoServices?: unknown })._aoServices;
    delete (globalThis as typeof globalThis & { _aoServicesInit?: unknown })._aoServicesInit;
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { _aoConfigCache?: unknown })._aoConfigCache;
    delete (globalThis as typeof globalThis & { _aoServices?: unknown })._aoServices;
    delete (globalThis as typeof globalThis & { _aoServicesInit?: unknown })._aoServicesInit;
  });

  it("removes agent:backlog label when claiming an issue", async () => {
    mockListIssues.mockResolvedValue([
      {
        id: "123",
        title: "Test Issue",
        description: "Test description",
        url: "https://github.com/test/test/issues/123",
        state: "open",
        labels: ["agent:backlog"],
      },
    ]);

    mockRegistry.get.mockImplementation((slot: string) => {
      if (slot === "tracker") {
        return {
          name: "github",
          listIssues: mockListIssues,
          updateIssue: mockUpdateIssue,
        };
      }
      if (slot === "agent") {
        return { name: "claude-code" };
      }
      if (slot === "runtime") {
        return { name: "tmux" };
      }
      if (slot === "workspace") {
        return { name: "worktree" };
      }
      return null;
    });

    const { pollBacklog } = await import("../lib/services");
    await pollBacklog();

    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "123",
      {
        labels: ["agent:in-progress"],
        removeLabels: ["agent:backlog"],
        comment: "Claimed by agent orchestrator — session spawned.",
      },
      expect.objectContaining({ tracker: { plugin: "github" } }),
    );
  });
});
