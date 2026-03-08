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

vi.mock("@composio/ao-core", () => ({
  loadConfig: mockLoadConfig,
  createPluginRegistry: () => mockRegistry,
  createSessionManager: mockCreateSessionManager,
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
});
