import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  loadConfig: vi.fn(),
  validateConfig: vi.fn(),
}));

vi.mock("../global-config.js", () => ({
  buildEffectiveProjectConfig: vi.fn(),
  getGlobalConfigPath: vi.fn(),
  loadGlobalConfig: vi.fn(),
}));

import { loadConfig, validateConfig } from "../config.js";
import {
  buildEffectiveProjectConfig,
  getGlobalConfigPath,
  loadGlobalConfig,
} from "../global-config.js";
import type { PortfolioProject, OrchestratorConfig, ProjectConfig } from "../types.js";
import { resolveProjectConfig, clearConfigCache } from "../portfolio-projects.js";

function makeProject(overrides: Partial<PortfolioProject> = {}): PortfolioProject {
  return {
    id: "test-project",
    name: "Test Project",
    configPath: "/tmp/config/agent-orchestrator.yaml",
    configProjectKey: "test-project",
    repoPath: "/tmp/project",
    sessionPrefix: "test",
    source: "config",
    enabled: true,
    pinned: false,
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeConfig(projectKey: string): OrchestratorConfig {
  return {
    configPath: "/tmp/config/agent-orchestrator.yaml",
    projects: {
      [projectKey]: {
        name: "Test",
        repo: "test/repo",
        path: "/tmp/project",
        defaultBranch: "main",
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        sessionPrefix: "test",
      } as ProjectConfig,
    },
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
  } as OrchestratorConfig;
}

describe("portfolio-projects", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearConfigCache();
  });

  describe("resolveProjectConfig", () => {
    it("resolves config for a global config project", () => {
      const globalPath = "/home/user/.agent-orchestrator/config.yaml";
      vi.mocked(getGlobalConfigPath).mockReturnValue(globalPath);

      const project = makeProject({ configPath: globalPath });

      vi.mocked(loadGlobalConfig).mockReturnValue({
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: ["desktop"],
        },
        projects: {
          "test-project": { path: "/tmp/project", name: "Test" },
        },
        notifiers: {},
        notificationRouting: { urgent: [], action: [], warning: [], info: [] },
        reactions: {},
      });

      vi.mocked(buildEffectiveProjectConfig).mockReturnValue({
        name: "Test",
        path: "/tmp/project",
        storageKey: "test00000000",
        repo: "test/repo",
        agent: "claude-code",
      });

      const mockConfig = makeConfig("test-project");
      vi.mocked(validateConfig).mockReturnValue(mockConfig);

      const result = resolveProjectConfig(project);
      expect(result).not.toBeNull();
      expect(result!.project).toBe(mockConfig.projects["test-project"]);
      expect(validateConfig).toHaveBeenCalled();
    });

    it("returns null when global config is not found", () => {
      const globalPath = "/home/user/.agent-orchestrator/config.yaml";
      vi.mocked(getGlobalConfigPath).mockReturnValue(globalPath);
      vi.mocked(loadGlobalConfig).mockReturnValue(null);

      const project = makeProject({ configPath: globalPath });
      const result = resolveProjectConfig(project);
      expect(result).toBeNull();
    });

    it("returns null when buildEffectiveProjectConfig returns null", () => {
      const globalPath = "/home/user/.agent-orchestrator/config.yaml";
      vi.mocked(getGlobalConfigPath).mockReturnValue(globalPath);
      vi.mocked(loadGlobalConfig).mockReturnValue({
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {},
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      });
      vi.mocked(buildEffectiveProjectConfig).mockReturnValue(null);

      const project = makeProject({ configPath: globalPath });
      const result = resolveProjectConfig(project);
      expect(result).toBeNull();
    });

    it("resolves config for a non-global config project", () => {
      vi.mocked(getGlobalConfigPath).mockReturnValue("/home/user/.agent-orchestrator/config.yaml");

      const project = makeProject({
        configPath: "/tmp/project/agent-orchestrator.yaml",
      });
      const mockConfig = makeConfig("test-project");
      vi.mocked(loadConfig).mockReturnValue(mockConfig);

      const result = resolveProjectConfig(project);
      expect(result).not.toBeNull();
      expect(result!.config).toBe(mockConfig);
      expect(result!.project).toBe(mockConfig.projects["test-project"]);
    });

    it("returns null when project key not found in config", () => {
      vi.mocked(getGlobalConfigPath).mockReturnValue("/home/user/.agent-orchestrator/config.yaml");

      const project = makeProject({
        configPath: "/tmp/project/agent-orchestrator.yaml",
        configProjectKey: "nonexistent",
      });
      const mockConfig = makeConfig("other-project");
      vi.mocked(loadConfig).mockReturnValue(mockConfig);

      const result = resolveProjectConfig(project);
      expect(result).toBeNull();
    });

    it("uses cached config on second call", () => {
      vi.mocked(getGlobalConfigPath).mockReturnValue("/home/user/.agent-orchestrator/config.yaml");

      const project = makeProject({
        configPath: "/tmp/project/agent-orchestrator.yaml",
      });
      const mockConfig = makeConfig("test-project");
      vi.mocked(loadConfig).mockReturnValue(mockConfig);

      const result1 = resolveProjectConfig(project);
      const result2 = resolveProjectConfig(project);

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(loadConfig).toHaveBeenCalledTimes(1); // Cached on second call
    });

    it("returns null on exceptions", () => {
      vi.mocked(getGlobalConfigPath).mockReturnValue("/home/user/.agent-orchestrator/config.yaml");

      const project = makeProject({
        configPath: "/tmp/project/agent-orchestrator.yaml",
      });
      vi.mocked(loadConfig).mockImplementation(() => {
        throw new Error("YAML parse error");
      });

      const result = resolveProjectConfig(project);
      expect(result).toBeNull();
    });

    it("returns null when validateConfig returns config without the project key", () => {
      const globalPath = "/home/user/.agent-orchestrator/config.yaml";
      vi.mocked(getGlobalConfigPath).mockReturnValue(globalPath);

      const project = makeProject({ configPath: globalPath });

      vi.mocked(loadGlobalConfig).mockReturnValue({
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: { "test-project": { path: "/tmp/project", name: "Test" } },
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      });

      vi.mocked(buildEffectiveProjectConfig).mockReturnValue({
        name: "Test",
        path: "/tmp/project",
        storageKey: "test00000000",
        repo: "test/repo",
      });

      // validateConfig returns config without the project key
      const configWithoutProject = makeConfig("other-key");
      vi.mocked(validateConfig).mockReturnValue(configWithoutProject);

      const result = resolveProjectConfig(project);
      expect(result).toBeNull();
    });
  });

  describe("clearConfigCache", () => {
    it("clears cache so next call reloads", () => {
      vi.mocked(getGlobalConfigPath).mockReturnValue("/home/user/.agent-orchestrator/config.yaml");

      const project = makeProject({
        configPath: "/tmp/project/agent-orchestrator.yaml",
      });
      const mockConfig = makeConfig("test-project");
      vi.mocked(loadConfig).mockReturnValue(mockConfig);

      resolveProjectConfig(project);
      expect(loadConfig).toHaveBeenCalledTimes(1);

      clearConfigCache();

      resolveProjectConfig(project);
      expect(loadConfig).toHaveBeenCalledTimes(2);
    });
  });
});
