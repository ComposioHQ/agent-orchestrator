import { describe, expect, it } from "vitest";
import {
  generateOrchestratorBootstrapPrompt,
  generateOrchestratorPrompt,
} from "../orchestrator-prompt.js";
import type { OrchestratorConfig } from "../types.js";

const config: OrchestratorConfig = {
  configPath: "/tmp/agent-orchestrator.yaml",
  port: 3000,
  defaults: {
    runtime: "tmux",
    agent: "claude-code",
    workspace: "worktree",
    notifiers: ["desktop"],
  },
  projects: {
    "my-app": {
      name: "My App",
      repo: "org/my-app",
      path: "/tmp/my-app",
      defaultBranch: "main",
      sessionPrefix: "app",
      tracker: { plugin: "github" },
      scm: { plugin: "github" },
    },
  },
  notifiers: {},
  notificationRouting: {
    urgent: ["desktop"],
    action: ["desktop"],
    warning: [],
    info: [],
  },
  reactions: {},
  readyThresholdMs: 300_000,
};

describe("generateOrchestratorPrompt", () => {
  it("requires read-only investigation from the orchestrator session", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("Investigations from the orchestrator session are **read-only**");
    expect(prompt).toContain("do not edit repository files or implement fixes");
  });

  it("pushes implementation and PR claiming into worker sessions", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("must be delegated to a **worker session**");
    expect(prompt).toContain("Never claim a PR into `app-orchestrator`");
    expect(prompt).toContain("Delegate implementation, test execution, or PR claiming");
  });

  it("includes tracker and PR workflows for turning descriptions into issues", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("gh issue create --repo org/my-app");
    expect(prompt).toContain("ao spawn my-app <issue-number>");
    expect(prompt).toContain("gh pr list --repo org/my-app");
  });

  it("generates a bootstrap prompt that starts with a live survey", () => {
    const prompt = generateOrchestratorBootstrapPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("Run these commands now:");
    expect(prompt).toContain("`ao status`");
    expect(prompt).toContain("`ao session ls -p my-app`");
    expect(prompt).toContain("`gh issue list --repo org/my-app --state open --limit 10`");
    expect(prompt).toContain("`gh pr list --repo org/my-app --state open --limit 10`");
    expect(prompt).toContain("wait for the human");
  });
});
