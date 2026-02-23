import { describe, it, expect } from "vitest";
import { resolveAgentName } from "../agent-routing.js";
import { SESSION_PHASE, type OrchestratorConfig, type ProjectConfig } from "../types.js";

function makeConfig(project: ProjectConfig): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: { app: project },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    readyThresholdMs: 300_000,
  };
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "App",
    repo: "org/app",
    path: "/tmp/app",
    defaultBranch: "main",
    sessionPrefix: "app",
    ...overrides,
  };
}

describe("resolveAgentName", () => {
  it("keeps project/default agent when no context is provided", () => {
    const project = makeProject({
      agent: "claude-code",
      workflow: { mode: "full", codingAgent: "codex", autoCodeReview: true },
    });
    const config = makeConfig(project);

    expect(resolveAgentName(config, project)).toBe("claude-code");
  });

  it("uses workflow.codingAgent for main coding session in full mode", () => {
    const project = makeProject({
      workflow: { mode: "full", codingAgent: "codex", autoCodeReview: true },
    });
    const config = makeConfig(project);

    expect(
      resolveAgentName(config, project, {
        phase: SESSION_PHASE.PLANNING,
      }),
    ).toBe("codex");
  });

  it("uses role-specific review agent override when present", () => {
    const project = makeProject({
      workflow: {
        mode: "full",
        codingAgent: "codex",
        planReview: {
          roles: ["architect", "developer", "product"],
          maxRounds: 3,
          codexReview: true,
          agent: "claude-code",
          roleAgents: { product: "claude-code", architect: "aider" },
        },
        autoCodeReview: true,
      },
    });
    const config = makeConfig(project);

    expect(
      resolveAgentName(config, project, {
        phase: SESSION_PHASE.PLAN_REVIEW,
        subSessionInfo: {
          parentSessionId: "app-1",
          role: "architect",
          phase: SESSION_PHASE.PLAN_REVIEW,
          round: 1,
        },
      }),
    ).toBe("aider");
  });

  it("uses review phase agent when role override is absent", () => {
    const project = makeProject({
      workflow: {
        mode: "full",
        codingAgent: "codex",
        codeReview: {
          roles: ["architect", "developer", "product"],
          maxRounds: 3,
          codexReview: true,
          agent: "claude-code",
        },
        autoCodeReview: true,
      },
    });
    const config = makeConfig(project);

    expect(
      resolveAgentName(config, project, {
        phase: SESSION_PHASE.CODE_REVIEW,
        subSessionInfo: {
          parentSessionId: "app-1",
          role: "developer",
          phase: SESSION_PHASE.CODE_REVIEW,
          round: 1,
        },
      }),
    ).toBe("claude-code");
  });

  it("uses review phase agent for parent review session without sub-session role", () => {
    const project = makeProject({
      workflow: {
        mode: "full",
        codingAgent: "codex",
        planReview: {
          roles: ["architect", "developer", "product"],
          maxRounds: 3,
          codexReview: true,
          agent: "claude-code",
        },
        autoCodeReview: true,
      },
    });
    const config = makeConfig(project);

    expect(
      resolveAgentName(config, project, {
        phase: SESSION_PHASE.PLAN_REVIEW,
      }),
    ).toBe("claude-code");
  });

  it("falls back to coding agent for review sub-session without review config", () => {
    const project = makeProject({
      workflow: { mode: "full", codingAgent: "codex", autoCodeReview: true },
    });
    const config = makeConfig(project);

    expect(
      resolveAgentName(config, project, {
        phase: SESSION_PHASE.PLAN_REVIEW,
        subSessionInfo: {
          parentSessionId: "app-1",
          role: "product",
          phase: SESSION_PHASE.PLAN_REVIEW,
          round: 2,
        },
      }),
    ).toBe("codex");
  });

  it("uses implementation swarm role agent for implementation sub-session", () => {
    const project = makeProject({
      workflow: {
        mode: "full",
        codingAgent: "codex",
        implementationSwarm: {
          roles: ["architect", "developer", "product"],
          maxAgents: 2,
          agent: "codex",
          roleAgents: { developer: "claude-code" },
        },
        autoCodeReview: true,
      },
    });
    const config = makeConfig(project);

    expect(
      resolveAgentName(config, project, {
        phase: SESSION_PHASE.IMPLEMENTING,
        subSessionInfo: {
          parentSessionId: "app-1",
          role: "developer",
          phase: SESSION_PHASE.IMPLEMENTING,
          round: 1,
        },
      }),
    ).toBe("claude-code");
  });
});
