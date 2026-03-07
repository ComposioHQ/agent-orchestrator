import { describe, expect, it } from "vitest";
import { generateOrchestratorPrompt } from "../orchestrator-prompt.js";
import type { OrchestratorConfig, ProjectConfig } from "../types.js";

const projectId = "integrator";

const project: ProjectConfig = {
  name: "Integrator",
  repo: "org/integrator",
  path: "/tmp/integrator",
  defaultBranch: "main",
  sessionPrefix: "int",
};

const config: OrchestratorConfig = {
  configPath: "/tmp/agent-orchestrator.yaml",
  port: 3000,
  terminalPort: 3001,
  directTerminalPort: 3003,
  readyThresholdMs: 300_000,
  defaults: {
    runtime: "tmux",
    agent: "claude-code",
    workspace: "worktree",
    notifiers: ["desktop"],
  },
  projects: {
    [projectId]: project,
  },
  notifiers: {},
  notificationRouting: {
    urgent: ["desktop"],
    action: ["desktop"],
    warning: [],
    info: [],
  },
  reactions: {},
};

describe("generateOrchestratorPrompt", () => {
  it("includes ao CLI control-plane guidance and key commands", () => {
    const prompt = generateOrchestratorPrompt({ config, projectId, project });

    expect(prompt).toContain("## AO CLI Control Plane");
    expect(prompt).toContain("Prefer `ao` commands over manual shell/tmux workflows");
    expect(prompt).toContain("Do NOT manage sessions manually with raw `tmux` commands");

    expect(prompt).toContain("ao status");
    expect(prompt).toContain(`ao spawn ${projectId} INT-1234`);
    expect(prompt).toContain(`ao batch-spawn ${projectId} INT-1 INT-2 INT-3`);
    expect(prompt).toContain(`ao send ${project.sessionPrefix}-1 "Your message here"`);
    expect(prompt).toContain(`ao review-check ${projectId}`);
    expect(prompt).toContain("`ao review-check [project]`");
  });
});
