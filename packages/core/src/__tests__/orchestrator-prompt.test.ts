import { describe, it, expect } from "vitest";
import { generateOrchestratorPrompt } from "../orchestrator-prompt.js";
import type { OrchestratorConfig, ProjectConfig } from "../types.js";

const project: ProjectConfig = {
  name: "Test App",
  repo: "org/test-app",
  path: "/tmp/test-app",
  defaultBranch: "main",
  sessionPrefix: "test",
};

const config = { port: 3000 } as OrchestratorConfig;

const baseOpts = {
  config,
  projectId: "test-app",
  project,
};

describe("generateOrchestratorPrompt", () => {
  it("mandates ao send for all session communication", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).toContain("ao send");
    expect(result).toContain("ONLY way to send messages");
  });

  it("explicitly forbids raw tmux usage", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).toContain("Never Tmux Directly");
    expect(result).toContain("Never use raw tmux commands");
  });

  it("documents ao send --no-wait for busy sessions", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).toContain("--no-wait");
    expect(result).toContain("busy");
  });

  it("mandates ao session ls for status checks", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).toContain("ao session ls");
    expect(result).toContain("ONLY way to check session status");
  });

  it("mandates ao spawn for creating new sessions", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).toContain("ao spawn");
    expect(result).toContain("ONLY way to create new sessions");
  });

  it("mandates ao session kill for terminating sessions", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).toContain("ao session kill");
    expect(result).toContain("ONLY way to terminate sessions");
  });

  it("includes project name and repo", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).toContain("Test App");
    expect(result).toContain("org/test-app");
  });

  it("includes dashboard port", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).toContain("3000");
  });

  it("uses default port 3000 when not configured", () => {
    const result = generateOrchestratorPrompt({ ...baseOpts, config: {} as OrchestratorConfig });
    expect(result).toContain("3000");
  });

  it("includes session prefix in examples", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).toContain("test-1");
  });

  it("includes ao status command", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).toContain("ao status");
  });

  it("includes ao batch-spawn command", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).toContain("ao batch-spawn");
  });

  it("includes ao session cleanup command", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).toContain("ao session cleanup");
  });

  it("includes automated reactions section when configured", () => {
    const projectWithReactions: ProjectConfig = {
      ...project,
      reactions: {
        "ci-failed": { auto: true, action: "send-to-agent" },
        "review-requested": { auto: false, action: "notify" },
      },
    };
    const result = generateOrchestratorPrompt({ ...baseOpts, project: projectWithReactions });
    expect(result).toContain("Automated Reactions");
    expect(result).toContain("ci-failed");
    expect(result).not.toContain("review-requested");
  });

  it("includes project-specific rules when configured", () => {
    const projectWithRules: ProjectConfig = {
      ...project,
      orchestratorRules: "Always check for existing PRs before spawning.",
    };
    const result = generateOrchestratorPrompt({ ...baseOpts, project: projectWithRules });
    expect(result).toContain("Project-Specific Rules");
    expect(result).toContain("Always check for existing PRs before spawning.");
  });

  it("omits reactions section when no reactions configured", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).not.toContain("Automated Reactions");
  });

  it("omits project-specific rules section when not configured", () => {
    const result = generateOrchestratorPrompt(baseOpts);
    expect(result).not.toContain("Project-Specific Rules");
  });
});
