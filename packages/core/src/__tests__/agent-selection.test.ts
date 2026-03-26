import { describe, it, expect } from "vitest";
import { resolveSessionRole, resolveAgentSelection } from "../agent-selection.js";
import type { DefaultPlugins, ProjectConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "test",
    repo: "acme/app",
    path: "/tmp/app",
    defaultBranch: "main",
    sessionPrefix: "app",
    ...overrides,
  };
}

const baseDefaults: DefaultPlugins = {
  runtime: "tmux",
  agent: "claude-code",
  workspace: "worktree",
  notifiers: ["desktop"],
};

// ---------------------------------------------------------------------------
// resolveSessionRole
// ---------------------------------------------------------------------------

describe("resolveSessionRole", () => {
  it('returns "orchestrator" for session IDs ending with -orchestrator', () => {
    expect(resolveSessionRole("app-orchestrator")).toBe("orchestrator");
  });

  it('returns "orchestrator" when metadata role is orchestrator', () => {
    expect(resolveSessionRole("app-1", { role: "orchestrator" })).toBe("orchestrator");
  });

  it('returns "worker" for regular session IDs', () => {
    expect(resolveSessionRole("app-1")).toBe("worker");
  });

  it('returns "worker" for session IDs without orchestrator suffix', () => {
    expect(resolveSessionRole("app-orchestrator-helper")).toBe("worker");
  });

  it('returns "worker" when metadata is empty', () => {
    expect(resolveSessionRole("app-5", {})).toBe("worker");
  });
});

// ---------------------------------------------------------------------------
// resolveAgentSelection — agent name resolution
// ---------------------------------------------------------------------------

describe("resolveAgentSelection", () => {
  describe("agent name resolution", () => {
    it("uses persistedAgent when provided", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({ agent: "codex" }),
        defaults: baseDefaults,
        persistedAgent: "aider",
      });
      expect(result.agentName).toBe("aider");
    });

    it("uses spawnAgentOverride for workers when no persistedAgent", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject(),
        defaults: baseDefaults,
        spawnAgentOverride: "codex",
      });
      expect(result.agentName).toBe("codex");
    });

    it("ignores spawnAgentOverride for orchestrators", () => {
      const result = resolveAgentSelection({
        role: "orchestrator",
        project: makeProject(),
        defaults: baseDefaults,
        spawnAgentOverride: "codex",
      });
      expect(result.agentName).toBe("claude-code");
    });

    it("uses role-specific project config over project.agent for workers", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({ agent: "aider", worker: { agent: "codex" } }),
        defaults: baseDefaults,
      });
      expect(result.agentName).toBe("codex");
    });

    it("uses role-specific project config over project.agent for orchestrators", () => {
      const result = resolveAgentSelection({
        role: "orchestrator",
        project: makeProject({ agent: "aider", orchestrator: { agent: "codex" } }),
        defaults: baseDefaults,
      });
      expect(result.agentName).toBe("codex");
    });

    it("falls back to project.agent when no role-specific config", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({ agent: "aider" }),
        defaults: baseDefaults,
      });
      expect(result.agentName).toBe("aider");
    });

    it("falls back to role-specific defaults when project has no agent", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject(),
        defaults: { ...baseDefaults, worker: { agent: "opencode" } },
      });
      expect(result.agentName).toBe("opencode");
    });

    it("falls back to defaults.agent as last resort", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject(),
        defaults: baseDefaults,
      });
      expect(result.agentName).toBe("claude-code");
    });

    it("persistedAgent takes priority over spawnAgentOverride", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject(),
        defaults: baseDefaults,
        persistedAgent: "aider",
        spawnAgentOverride: "codex",
      });
      expect(result.agentName).toBe("aider");
    });
  });

  // ---------------------------------------------------------------------------
  // agent config merging
  // ---------------------------------------------------------------------------

  describe("agent config merging", () => {
    it("merges shared project config into agentConfig", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({ agentConfig: { maxTokens: 4096 } }),
        defaults: baseDefaults,
      });
      expect(result.agentConfig.maxTokens).toBe(4096);
    });

    it("role-specific agentConfig overrides shared config", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({
          agentConfig: { maxTokens: 4096 },
          worker: { agentConfig: { maxTokens: 8192 } },
        }),
        defaults: baseDefaults,
      });
      expect(result.agentConfig.maxTokens).toBe(8192);
    });

    it("does not override shared config values with undefined role values", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({
          agentConfig: { maxTokens: 4096 },
          worker: { agentConfig: {} },
        }),
        defaults: baseDefaults,
      });
      expect(result.agentConfig.maxTokens).toBe(4096);
    });
  });

  // ---------------------------------------------------------------------------
  // model resolution
  // ---------------------------------------------------------------------------

  describe("model resolution", () => {
    it("uses role agentConfig model for workers", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({
          worker: { agentConfig: { model: "gpt-4" } },
        }),
        defaults: baseDefaults,
      });
      expect(result.model).toBe("gpt-4");
    });

    it("falls back to shared agentConfig model", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({ agentConfig: { model: "gpt-4" } }),
        defaults: baseDefaults,
      });
      expect(result.model).toBe("gpt-4");
    });

    it("orchestrator prefers orchestratorModel from role config", () => {
      const result = resolveAgentSelection({
        role: "orchestrator",
        project: makeProject({
          orchestrator: { agentConfig: { orchestratorModel: "o1", model: "gpt-4" } },
        }),
        defaults: baseDefaults,
      });
      expect(result.model).toBe("o1");
    });

    it("orchestrator falls back to role model when no orchestratorModel", () => {
      const result = resolveAgentSelection({
        role: "orchestrator",
        project: makeProject({
          orchestrator: { agentConfig: { model: "gpt-4" } },
        }),
        defaults: baseDefaults,
      });
      expect(result.model).toBe("gpt-4");
    });

    it("orchestrator falls back to shared orchestratorModel", () => {
      const result = resolveAgentSelection({
        role: "orchestrator",
        project: makeProject({
          agentConfig: { orchestratorModel: "o1" },
        }),
        defaults: baseDefaults,
      });
      expect(result.model).toBe("o1");
    });

    it("returns undefined model when none configured", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject(),
        defaults: baseDefaults,
      });
      expect(result.model).toBeUndefined();
    });

    it("sets model on agentConfig when resolved", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({ agentConfig: { model: "gpt-4" } }),
        defaults: baseDefaults,
      });
      expect(result.agentConfig.model).toBe("gpt-4");
    });
  });

  // ---------------------------------------------------------------------------
  // permissions
  // ---------------------------------------------------------------------------

  describe("permissions", () => {
    it("normalizes valid permission mode", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({ agentConfig: { permissions: "permissionless" } }),
        defaults: baseDefaults,
      });
      expect(result.permissions).toBe("permissionless");
    });

    it("normalizes legacy 'skip' alias to 'permissionless'", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({
          worker: { agentConfig: { permissions: "skip" as unknown as "permissionless" } },
        }),
        defaults: baseDefaults,
      });
      expect(result.permissions).toBe("permissionless");
    });

    it("returns undefined for no permissions", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject(),
        defaults: baseDefaults,
      });
      expect(result.permissions).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // subagent
  // ---------------------------------------------------------------------------

  describe("subagent", () => {
    it("extracts subagent from agentConfig", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({
          agentConfig: { subagent: "sisyphus" },
        }),
        defaults: baseDefaults,
      });
      expect(result.subagent).toBe("sisyphus");
    });

    it("extracts subagent from role-specific agentConfig", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({
          worker: { agentConfig: { subagent: "oracle" } },
        }),
        defaults: baseDefaults,
      });
      expect(result.subagent).toBe("oracle");
    });

    it("returns undefined when no subagent", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject(),
        defaults: baseDefaults,
      });
      expect(result.subagent).toBeUndefined();
    });

    it("returns undefined when subagent is non-string", () => {
      const result = resolveAgentSelection({
        role: "worker",
        project: makeProject({
          agentConfig: { subagent: 123 },
        }),
        defaults: baseDefaults,
      });
      expect(result.subagent).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // return shape
  // ---------------------------------------------------------------------------

  describe("return shape", () => {
    it("includes role in result", () => {
      const result = resolveAgentSelection({
        role: "orchestrator",
        project: makeProject(),
        defaults: baseDefaults,
      });
      expect(result.role).toBe("orchestrator");
    });
  });
});
