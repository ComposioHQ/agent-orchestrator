import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLoadConfig,
  mockRegister,
  mockCreateSessionManager,
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

vi.mock("@aoagents/ao-core", () => ({
  loadConfig: mockLoadConfig,
  createPluginRegistry: () => mockRegistry,
  createSessionManager: mockCreateSessionManager,
  createLifecycleManager: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    getStates: vi.fn(),
    check: vi.fn(),
  }),
  TERMINAL_STATUSES: new Set(["merged", "killed"]) as ReadonlySet<string>,
}));

vi.mock("@aoagents/ao-plugin-runtime-tmux", () => ({ default: tmuxPlugin }));
vi.mock("@aoagents/ao-plugin-agent-claude-code", () => ({ default: claudePlugin }));
vi.mock("@aoagents/ao-plugin-agent-opencode", () => ({ default: opencodePlugin }));
vi.mock("@aoagents/ao-plugin-workspace-worktree", () => ({ default: worktreePlugin }));
vi.mock("@aoagents/ao-plugin-scm-github", () => ({ default: scmPlugin }));
vi.mock("@aoagents/ao-plugin-tracker-github", () => ({ default: trackerGithubPlugin }));
vi.mock("@aoagents/ao-plugin-tracker-linear", () => ({ default: trackerLinearPlugin }));

describe("services", () => {
  beforeEach(() => {
    vi.resetModules();
    mockRegister.mockClear();
    mockCreateSessionManager.mockReset();
    mockLoadConfig.mockReset();
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
    delete (globalThis as typeof globalThis & { _aoServices?: unknown })._aoServices;
    delete (globalThis as typeof globalThis & { _aoServicesInit?: unknown })._aoServicesInit;
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { _aoServices?: unknown })._aoServices;
    delete (globalThis as typeof globalThis & { _aoServicesInit?: unknown })._aoServicesInit;
  });

  it("registers the OpenCode agent plugin with web services", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
        worker: { agent: "opencode" },
      },
      projects: {},
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    });

    const { getServices } = await import("../lib/services");

    await getServices();

    expect(
      mockRegister.mock.calls.some(
        ([plugin]) => (plugin as { manifest?: { name?: string } }).manifest?.name === opencodePlugin.manifest.name,
      ),
    ).toBe(true);
  });

  it("loads built-in plugins from workspace packages when web does not depend on them", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "tmux",
        agent: "codex",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {},
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    });

    const { getServices } = await import("../lib/services");

    await getServices();

    expect(
      mockRegister.mock.calls.some(
        ([plugin]) => (plugin as { manifest?: { name?: string } }).manifest?.name === "codex",
      ),
    ).toBe(true);
  });

  it("skips non-builtin plugin names so external plugins do not break startup", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      plugins: [
        {
          name: "custom-tracker",
          source: "npm",
          package: "@acme/ao-plugin-tracker-custom",
        },
      ],
      projects: {
        "test-project": {
          path: "/tmp/test-project",
          tracker: { plugin: "custom-tracker" },
        },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    });

    const { getServices } = await import("../lib/services");

    await expect(getServices()).resolves.toBeDefined();
    expect(mockCreateSessionManager).toHaveBeenCalledTimes(1);
  });

  it("caches initialized services across repeated calls", async () => {
    const { getServices } = await import("../lib/services");

    const first = await getServices();
    const second = await getServices();

    expect(first).toBe(second);
    expect(mockCreateSessionManager).toHaveBeenCalledTimes(1);
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

    delete (globalThis as typeof globalThis & { _aoServices?: unknown })._aoServices;
    delete (globalThis as typeof globalThis & { _aoServicesInit?: unknown })._aoServicesInit;
  });

  afterEach(() => {
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
