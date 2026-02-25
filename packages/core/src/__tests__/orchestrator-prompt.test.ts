import { describe, expect, it } from "vitest";
import { generateOrchestratorPrompt } from "../orchestrator-prompt.js";
import type { OrchestratorConfig, ProjectConfig } from "../types.js";

function makeConfig(): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 4310,
    readyThresholdMs: 300000,
    defaults: {
      runtime: "tmux",
      agent: "codex",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {},
    notifiers: {},
    notificationRouting: {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
  };
}

function makeProject(): ProjectConfig {
  return {
    name: "Agent Orchestrator",
    repo: "vivekgoquest/agent-orchestrator",
    defaultBranch: "main",
    sessionPrefix: "ao",
    path: "/tmp/agent-orchestrator",
  };
}

describe("generateOrchestratorPrompt", () => {
  it("includes a mandatory plan-first contract before spawn instructions", () => {
    const prompt = generateOrchestratorPrompt({
      config: makeConfig(),
      projectId: "ao",
      project: makeProject(),
    });

    expect(prompt).toContain("## Plan-First Contract (Mandatory)");
    expect(prompt).toContain(
      "Do NOT run `ao spawn` or `ao batch-spawn` before plan validation succeeds.",
    );
    expect(prompt).toContain(
      "Return exactly one top-level object in one of two forms: `work_plan` (valid) or `plan_refusal` (invalid).",
    );
    expect(prompt).toContain("### Required JSON Shape");
    expect(prompt).toContain('"kind": "work_plan"');
    expect(prompt).toContain('"kind": "plan_refusal"');
  });

  it("includes explicit refusal behavior when plan validation fails", () => {
    const prompt = generateOrchestratorPrompt({
      config: makeConfig(),
      projectId: "ao",
      project: makeProject(),
    });

    expect(prompt).toContain(
      "When plan validation fails, return the `plan_refusal` object and do not spawn any workers.",
    );
    expect(prompt).toContain('"reason": "plan_invalid"');
    expect(prompt).toContain('"nextAction": "Fix schema errors and regenerate a valid work_plan JSON."');
  });

  it("matches snapshot with planning contract and workflow sections", () => {
    const prompt = generateOrchestratorPrompt({
      config: makeConfig(),
      projectId: "ao",
      project: makeProject(),
    });

    expect(prompt).toMatchSnapshot();
  });
});
