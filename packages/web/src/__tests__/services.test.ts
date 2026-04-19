import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `import()` in a type position is the correct way to name the full module shape for `importOriginal`.
/* eslint-disable @typescript-eslint/consistent-type-imports -- see above */
type AoCoreModule = typeof import("@aoagents/ao-core");
/* eslint-enable @typescript-eslint/consistent-type-imports */

const {
  mockLoadConfig,
  mockLoadBuiltins,
  mockCreateSessionManager,
  mockRegistry,
  builtinPlugins,
} = vi.hoisted(() => {
  const mockLoadConfig = vi.fn();
  const mockLoadBuiltins = vi.fn().mockResolvedValue(undefined);
  const mockCreateSessionManager = vi.fn();
  const builtinPlugins = {
    "@aoagents/ao-plugin-runtime-tmux": { manifest: { name: "tmux" } },
    "@aoagents/ao-plugin-runtime-process": { manifest: { name: "process" } },
    "@aoagents/ao-plugin-agent-claude-code": { manifest: { name: "claude-code" } },
    "@aoagents/ao-plugin-agent-codex": { manifest: { name: "codex" } },
    "@aoagents/ao-plugin-agent-cursor": { manifest: { name: "cursor" } },
    "@aoagents/ao-plugin-agent-aider": { manifest: { name: "aider" } },
    "@aoagents/ao-plugin-agent-opencode": { manifest: { name: "opencode" } },
    "@aoagents/ao-plugin-workspace-worktree": { manifest: { name: "worktree" } },
    "@aoagents/ao-plugin-workspace-clone": { manifest: { name: "clone" } },
    "@aoagents/ao-plugin-tracker-github": { manifest: { name: "github" } },
    "@aoagents/ao-plugin-tracker-linear": { manifest: { name: "linear" } },
    "@aoagents/ao-plugin-tracker-gitlab": { manifest: { name: "gitlab" } },
    "@aoagents/ao-plugin-scm-github": { manifest: { name: "github" } },
    "@aoagents/ao-plugin-scm-gitlab": { manifest: { name: "gitlab" } },
    "@aoagents/ao-plugin-notifier-composio": { manifest: { name: "composio" } },
    "@aoagents/ao-plugin-notifier-desktop": { manifest: { name: "desktop" } },
    "@aoagents/ao-plugin-notifier-discord": { manifest: { name: "discord" } },
    "@aoagents/ao-plugin-notifier-openclaw": { manifest: { name: "openclaw" } },
    "@aoagents/ao-plugin-notifier-slack": { manifest: { name: "slack" } },
    "@aoagents/ao-plugin-notifier-webhook": { manifest: { name: "webhook" } },
    "@aoagents/ao-plugin-terminal-iterm2": { manifest: { name: "iterm2" } },
    "@aoagents/ao-plugin-terminal-web": { manifest: { name: "web" } },
  } as const;
  const mockRegistry = {
    register: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    loadBuiltins: mockLoadBuiltins,
    loadFromConfig: vi.fn(),
  };

  return {
    mockLoadConfig,
    mockLoadBuiltins,
    mockCreateSessionManager,
    mockRegistry,
    builtinPlugins,
  };
});

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = await importOriginal<AoCoreModule>();
  return {
    ...actual,
    loadConfig: mockLoadConfig,
    createPluginRegistry: () => mockRegistry,
    createSessionManager: mockCreateSessionManager,
    createLifecycleManager: () => ({
      start: vi.fn(),
      stop: vi.fn(),
      getStates: vi.fn(),
      check: vi.fn(),
    }),
    decompose: vi.fn(),
    getLeaves: vi.fn(),
    getSiblings: vi.fn(),
    formatPlanTree: vi.fn(),
    DEFAULT_DECOMPOSER_CONFIG: {},
    isOrchestratorSession: vi.fn().mockReturnValue(false),
    TERMINAL_STATUSES: new Set(["merged", "killed"]) as ReadonlySet<string>,
  };
});

vi.mock("@aoagents/ao-plugin-runtime-tmux", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-runtime-tmux"],
}));
vi.mock("@aoagents/ao-plugin-runtime-process", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-runtime-process"],
}));
vi.mock("@aoagents/ao-plugin-agent-claude-code", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-agent-claude-code"],
}));
vi.mock("@aoagents/ao-plugin-agent-codex", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-agent-codex"],
}));
vi.mock("@aoagents/ao-plugin-agent-cursor", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-agent-cursor"],
}));
vi.mock("@aoagents/ao-plugin-agent-aider", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-agent-aider"],
}));
vi.mock("@aoagents/ao-plugin-agent-opencode", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-agent-opencode"],
}));
vi.mock("@aoagents/ao-plugin-workspace-worktree", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-workspace-worktree"],
}));
vi.mock("@aoagents/ao-plugin-workspace-clone", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-workspace-clone"],
}));
vi.mock("@aoagents/ao-plugin-scm-github", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-scm-github"],
}));
vi.mock("@aoagents/ao-plugin-scm-gitlab", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-scm-gitlab"],
}));
vi.mock("@aoagents/ao-plugin-tracker-github", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-tracker-github"],
}));
vi.mock("@aoagents/ao-plugin-tracker-linear", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-tracker-linear"],
}));
vi.mock("@aoagents/ao-plugin-tracker-gitlab", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-tracker-gitlab"],
}));
vi.mock("@aoagents/ao-plugin-notifier-composio", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-notifier-composio"],
}));
vi.mock("@aoagents/ao-plugin-notifier-desktop", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-notifier-desktop"],
}));
vi.mock("@aoagents/ao-plugin-notifier-discord", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-notifier-discord"],
}));
vi.mock("@aoagents/ao-plugin-notifier-openclaw", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-notifier-openclaw"],
}));
vi.mock("@aoagents/ao-plugin-notifier-slack", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-notifier-slack"],
}));
vi.mock("@aoagents/ao-plugin-notifier-webhook", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-notifier-webhook"],
}));
vi.mock("@aoagents/ao-plugin-terminal-iterm2", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-terminal-iterm2"],
}));
vi.mock("@aoagents/ao-plugin-terminal-web", () => ({
  default: builtinPlugins["@aoagents/ao-plugin-terminal-web"],
}));

describe("services", () => {
  beforeEach(() => {
    vi.resetModules();
    mockLoadBuiltins.mockClear();
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

  it("loads the full builtin plugin set through the static import map", async () => {
    const { getServices } = await import("../lib/services");

    await getServices();

    expect(mockLoadBuiltins).toHaveBeenCalledTimes(1);
    const [configArg, importFn] = mockLoadBuiltins.mock.calls[0];
    expect(configArg).toEqual(mockLoadConfig.mock.results[0]?.value);
    expect(importFn).toBeTypeOf("function");

    const resolvedModules = await Promise.all(
      Object.entries(builtinPlugins).map(async ([pkg, plugin]) => {
        const mod = await importFn(pkg);
        return [pkg, mod, plugin] as const;
      }),
    );

    expect(resolvedModules).toEqual(
      Object.entries(builtinPlugins).map(([pkg, plugin]) => [pkg, plugin, plugin]),
    );
  });

  it("caches initialized services across repeated calls", async () => {
    const { getServices } = await import("../lib/services");

    const first = await getServices();
    const second = await getServices();

    expect(first).toBe(second);
    expect(mockCreateSessionManager).toHaveBeenCalledTimes(1);
    expect(mockLoadBuiltins).toHaveBeenCalledTimes(1);
  });

  it("importFn throws for packages not in WEB_BUILTIN_PLUGIN_MODULES", async () => {
    const { getServices } = await import("../lib/services");
    await getServices();

    const [, importFn] = mockLoadBuiltins.mock.calls[0];
    await expect(importFn("@aoagents/ao-plugin-unknown-xyz")).rejects.toThrow(
      'Built-in plugin "@aoagents/ao-plugin-unknown-xyz" is not bundled by the web services bootstrap',
    );
  });

  it("WEB_BUILTIN_PLUGIN_PACKAGE_NAMES matches core BUILTIN_PLUGIN_PACKAGES", async () => {
    const { BUILTIN_PLUGIN_PACKAGES } = await import("@aoagents/ao-core");
    const { WEB_BUILTIN_PLUGIN_PACKAGE_NAMES } = await import("../lib/services");

    expect(new Set(WEB_BUILTIN_PLUGIN_PACKAGE_NAMES)).toEqual(new Set(BUILTIN_PLUGIN_PACKAGES));
  });
});

describe("pollBacklog", () => {
  const mockUpdateIssue = vi.fn();
  const mockListIssues = vi.fn();
  const mockSpawn = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    mockLoadBuiltins.mockClear();
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
