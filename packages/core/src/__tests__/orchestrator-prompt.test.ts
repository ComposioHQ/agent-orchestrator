import { describe, it, expect } from "vitest";
import { generateOrchestratorPrompt } from "../orchestrator-prompt.js";
import type { OrchestratorConfig, ProjectConfig } from "../types.js";

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "My App",
    repo: "org/my-app",
    path: "/home/user/my-app",
    defaultBranch: "main",
    sessionPrefix: "app",
    ...overrides,
  };
}

function makeConfig(
  projectId: string,
  project: ProjectConfig,
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  return {
    configPath: "/home/user/agent-orchestrator.yaml",
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: { [projectId]: project },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: ["desktop"],
      info: ["desktop"],
    },
    reactions: {},
    ...overrides,
  };
}

describe("generateOrchestratorPrompt", () => {
  it("includes project name in header", () => {
    const project = makeProject();
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("# My App Orchestrator");
    expect(prompt).toContain("orchestrator agent");
  });

  it("includes project info section", () => {
    const project = makeProject();
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("**Name**: My App");
    expect(prompt).toContain("**Repository**: org/my-app");
    expect(prompt).toContain("**Default Branch**: main");
    expect(prompt).toContain("**Session Prefix**: app");
    expect(prompt).toContain("**Local Path**: /home/user/my-app");
  });

  it("uses default port 3000 when not configured", () => {
    const project = makeProject();
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("**Dashboard Port**: 3000");
    expect(prompt).toContain("http://localhost:3000");
  });

  it("uses custom port when configured", () => {
    const project = makeProject();
    const config = makeConfig("my-app", project, { port: 4200 });
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("**Dashboard Port**: 4200");
    expect(prompt).toContain("http://localhost:4200");
  });

  it("includes quick-start commands with correct projectId and prefix", () => {
    const project = makeProject({ sessionPrefix: "be" });
    const config = makeConfig("backend", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "backend", project });

    expect(prompt).toContain("ao spawn backend INT-1234");
    expect(prompt).toContain("ao batch-spawn backend");
    expect(prompt).toContain("ao session ls -p backend");
    expect(prompt).toContain('ao send be-1 "Your message here"');
    expect(prompt).toContain("ao session kill be-1");
    expect(prompt).toContain("ao open backend");
  });

  it("includes available commands table", () => {
    const project = makeProject();
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("## Available Commands");
    expect(prompt).toContain("`ao status`");
    expect(prompt).toContain("`ao spawn <project> [issue]`");
    expect(prompt).toContain("`ao batch-spawn <project> <issues...>`");
    expect(prompt).toContain("`ao session ls [-p project]`");
    expect(prompt).toContain("`ao send <session> <message>`");
    expect(prompt).toContain("`ao dashboard`");
  });

  it("includes session management section", () => {
    const project = makeProject();
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("## Session Management");
    expect(prompt).toContain("Spawning Sessions");
    expect(prompt).toContain("Monitoring Progress");
    expect(prompt).toContain("Sending Messages");
    expect(prompt).toContain("Cleanup");
  });

  it("includes dashboard section", () => {
    const project = makeProject();
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("## Dashboard");
    expect(prompt).toContain("Server-Sent Events");
  });

  it("includes common workflows section", () => {
    const project = makeProject();
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("## Common Workflows");
    expect(prompt).toContain("Bulk Issue Processing");
    expect(prompt).toContain("Handling Stuck Agents");
    expect(prompt).toContain("PR Review Flow");
    expect(prompt).toContain("Manual Intervention");
  });

  it("includes tips section", () => {
    const project = makeProject();
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("## Tips");
    expect(prompt).toContain("batch-spawn");
    expect(prompt).toContain("Don't micro-manage");
  });

  // --- Reactions ---

  it("omits reactions section when no reactions configured", () => {
    const project = makeProject({ reactions: undefined });
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).not.toContain("## Automated Reactions");
  });

  it("omits reactions section when reactions is empty object", () => {
    const project = makeProject({ reactions: {} });
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).not.toContain("## Automated Reactions");
  });

  it("includes reactions section for send-to-agent reactions", () => {
    const project = makeProject({
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Fix CI",
          retries: 3,
          escalateAfter: "10m",
        },
      },
    });
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("## Automated Reactions");
    expect(prompt).toContain("**ci-failed**: Auto-sends instruction to agent");
    expect(prompt).toContain("retries: 3");
    expect(prompt).toContain("escalates after: 10m");
  });

  it("includes reactions section for notify reactions", () => {
    const project = makeProject({
      reactions: {
        "agent-stuck": {
          auto: true,
          action: "notify",
          priority: "urgent",
        },
      },
    });
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("## Automated Reactions");
    expect(prompt).toContain("**agent-stuck**: Notifies human");
    expect(prompt).toContain("priority: urgent");
  });

  it("skips reactions with auto: false", () => {
    const project = makeProject({
      reactions: {
        "ci-failed": {
          auto: false,
          action: "send-to-agent",
          message: "Fix",
        },
      },
    });
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).not.toContain("## Automated Reactions");
  });

  it("uses defaults for missing retries and escalateAfter", () => {
    const project = makeProject({
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Fix",
        },
      },
    });
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("retries: none");
    expect(prompt).toContain("escalates after: never");
  });

  // --- Orchestrator rules ---

  it("omits project-specific rules when not configured", () => {
    const project = makeProject({ orchestratorRules: undefined });
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).not.toContain("## Project-Specific Rules");
  });

  it("includes project-specific rules when configured", () => {
    const project = makeProject({
      orchestratorRules: "Always run tests before creating PRs.\nUse conventional commits.",
    });
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    expect(prompt).toContain("## Project-Specific Rules");
    expect(prompt).toContain("Always run tests before creating PRs.");
    expect(prompt).toContain("Use conventional commits.");
  });

  // --- Section ordering ---

  it("joins sections with double newlines", () => {
    const project = makeProject();
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    // Sections should be separated by double newlines
    expect(prompt).toContain("\n\n## Project Info");
    expect(prompt).toContain("\n\n## Quick Start");
    expect(prompt).toContain("\n\n## Available Commands");
  });

  it("sections appear in correct order", () => {
    const project = makeProject({
      orchestratorRules: "Custom rules",
      reactions: { "ci-failed": { auto: true, action: "notify" } },
    });
    const config = makeConfig("my-app", project);
    const prompt = generateOrchestratorPrompt({ config, projectId: "my-app", project });

    const headerIdx = prompt.indexOf("# My App Orchestrator");
    const projectInfoIdx = prompt.indexOf("## Project Info");
    const quickStartIdx = prompt.indexOf("## Quick Start");
    const commandsIdx = prompt.indexOf("## Available Commands");
    const sessionMgmtIdx = prompt.indexOf("## Session Management");
    const dashboardIdx = prompt.indexOf("## Dashboard");
    const reactionsIdx = prompt.indexOf("## Automated Reactions");
    const workflowsIdx = prompt.indexOf("## Common Workflows");
    const tipsIdx = prompt.indexOf("## Tips");
    const rulesIdx = prompt.indexOf("## Project-Specific Rules");

    expect(headerIdx).toBeLessThan(projectInfoIdx);
    expect(projectInfoIdx).toBeLessThan(quickStartIdx);
    expect(quickStartIdx).toBeLessThan(commandsIdx);
    expect(commandsIdx).toBeLessThan(sessionMgmtIdx);
    expect(sessionMgmtIdx).toBeLessThan(dashboardIdx);
    expect(dashboardIdx).toBeLessThan(reactionsIdx);
    expect(reactionsIdx).toBeLessThan(workflowsIdx);
    expect(workflowsIdx).toBeLessThan(tipsIdx);
    expect(tipsIdx).toBeLessThan(rulesIdx);
  });
});
