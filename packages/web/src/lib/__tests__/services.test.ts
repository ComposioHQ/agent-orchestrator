import type * as NodeFsModule from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadConfig = vi.fn();
const mockGetGlobalConfigPath = vi.fn();
const mockCreatePluginRegistry = vi.fn();
const mockCreateSessionManager = vi.fn();
const mockCreateLifecycleManager = vi.fn();
const mockExistsSync = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<NodeFsModule>();
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  };
});

vi.mock("@composio/ao-core", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  getGlobalConfigPath: () => mockGetGlobalConfigPath(),
  createPluginRegistry: () => mockCreatePluginRegistry(),
  createSessionManager: (...args: unknown[]) => mockCreateSessionManager(...args),
  createLifecycleManager: (...args: unknown[]) => mockCreateLifecycleManager(...args),
  decompose: vi.fn(),
  getLeaves: vi.fn(),
  getSiblings: vi.fn(),
  formatPlanTree: vi.fn(),
  DEFAULT_DECOMPOSER_CONFIG: {},
  isOrchestratorSession: vi.fn(),
  TERMINAL_STATUSES: new Set(["merged", "done"]),
}));

// Stub all plugin imports
vi.mock("@composio/ao-plugin-runtime-tmux", () => ({ default: { manifest: { slot: "runtime" } } }));
vi.mock("@composio/ao-plugin-agent-claude-code", () => ({ default: { manifest: { slot: "agent" } } }));
vi.mock("@composio/ao-plugin-agent-codex", () => ({ default: { manifest: { slot: "agent" } } }));
vi.mock("@composio/ao-plugin-agent-opencode", () => ({ default: { manifest: { slot: "agent" } } }));
vi.mock("@composio/ao-plugin-workspace-worktree", () => ({ default: { manifest: { slot: "workspace" } } }));
vi.mock("@composio/ao-plugin-scm-github", () => ({ default: { manifest: { slot: "scm" } } }));
vi.mock("@composio/ao-plugin-tracker-github", () => ({ default: { manifest: { slot: "tracker" } } }));
vi.mock("@composio/ao-plugin-tracker-linear", () => ({ default: { manifest: { slot: "tracker" } } }));

describe("services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module-level globalThis caches between tests
    const g = globalThis as Record<string, unknown>;
    delete g._aoServices;
    delete g._aoServicesInit;
  });

  describe("invalidateServicesCache", () => {
    it("calls lifecycleManager.stop and clears the cache", async () => {
      const mockStop = vi.fn();
      const g = globalThis as Record<string, unknown>;
      g._aoServices = { lifecycleManager: { stop: mockStop } };
      g._aoServicesInit = Promise.resolve();

      const { invalidateServicesCache } = await import("../services");
      invalidateServicesCache();

      expect(mockStop).toHaveBeenCalled();
      expect(g._aoServices).toBeUndefined();
      expect(g._aoServicesInit).toBeUndefined();
    });

    it("does not throw when lifecycleManager.stop fails", async () => {
      const g = globalThis as Record<string, unknown>;
      g._aoServices = {
        lifecycleManager: {
          stop: () => {
            throw new Error("stop failed");
          },
        },
      };

      const { invalidateServicesCache } = await import("../services");
      expect(() => invalidateServicesCache()).not.toThrow();
      expect(g._aoServices).toBeUndefined();
      expect(g._aoServicesInit).toBeUndefined();
    });
  });

  describe("getSCM", () => {
    it("returns null when project has no scm config", async () => {
      const { getSCM } = await import("../services");
      const mockRegistry = { get: vi.fn() };
      expect(getSCM(mockRegistry as never, undefined)).toBeNull();
      expect(getSCM(mockRegistry as never, {} as never)).toBeNull();
    });

    it("returns the scm plugin from the registry", async () => {
      const { getSCM } = await import("../services");
      const scmPlugin = { createPR: vi.fn() };
      const mockRegistry = { get: vi.fn().mockReturnValue(scmPlugin) };
      const project = { scm: { plugin: "github" } };

      const result = getSCM(mockRegistry as never, project as never);

      expect(mockRegistry.get).toHaveBeenCalledWith("scm", "github");
      expect(result).toBe(scmPlugin);
    });
  });

  describe("getServices", () => {
    it("returns cached services when already initialized", async () => {
      const g = globalThis as Record<string, unknown>;
      const fakeServices = {
        config: {},
        registry: {},
        sessionManager: {},
        lifecycleManager: { stop: vi.fn() },
      };
      g._aoServices = fakeServices;

      const { getServices } = await import("../services");
      const result = await getServices();

      expect(result).toBe(fakeServices);
    });

    it("returns the pending init promise when initialization is in progress", async () => {
      const g = globalThis as Record<string, unknown>;
      delete g._aoServices;

      const fakeServices = {
        config: {},
        registry: {},
        sessionManager: {},
        lifecycleManager: { stop: vi.fn() },
      };
      g._aoServicesInit = Promise.resolve(fakeServices);

      const { getServices } = await import("../services");
      const result = await getServices();

      expect(result).toBe(fakeServices);
    });
  });
});
