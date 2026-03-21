import { describe, expect, it } from "vitest";
import {
  generateOrchestratorPrompt,
  generateOrchestratorStartupPrompt,
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
});

describe("generateOrchestratorStartupPrompt", () => {
  it("kicks off an immediate tracker triage pass when a tracker is configured", () => {
    const prompt = generateOrchestratorStartupPrompt({
      config,
      projectId: "my-app",
      project: {
        ...config.projects["my-app"]!,
        tracker: {
          plugin: "github",
          issueFilters: { labels: ["ready"], state: "open" },
        },
      },
    });

    expect(prompt).toContain("Do an initial orchestration pass");
    expect(prompt).toContain("ao session ls -p my-app");
    expect(prompt).toContain("configured github tracker");
    expect(prompt).toContain("labels=ready");
    expect(prompt).toContain("ao batch-spawn my-app");
  });

  it("falls back to monitoring guidance when no tracker is configured", () => {
    const prompt = generateOrchestratorStartupPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("There is no tracker configured for this project");
    expect(prompt).not.toContain("ao batch-spawn my-app");
  });
});
