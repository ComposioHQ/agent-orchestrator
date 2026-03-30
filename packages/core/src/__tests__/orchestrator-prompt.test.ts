import { describe, expect, it } from "vitest";
import { generateOrchestratorPrompt } from "../orchestrator-prompt.js";
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

  it("mandates ao send and bans raw tmux access", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("Always use `ao send`");
    expect(prompt).toContain("never use raw `tmux send-keys`");
    expect(prompt).toContain("ao send --no-wait");
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

// =============================================================================
// Additional coverage: conditional sections and branch coverage
// =============================================================================

describe("generateOrchestratorPrompt — project info section", () => {
  it("includes project name, repo, default branch, session prefix, path", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("**Name**: My App");
    expect(prompt).toContain("**Repository**: org/my-app");
    expect(prompt).toContain("**Default Branch**: main");
    expect(prompt).toContain("**Session Prefix**: app");
    expect(prompt).toContain("**Local Path**: /tmp/my-app");
  });

  it("uses config port for dashboard port", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("**Dashboard Port**: 3000");
  });

  it("defaults to 3000 when port is undefined", () => {
    const configNoPort: OrchestratorConfig = {
      ...config,
      port: undefined,
    };

    const prompt = generateOrchestratorPrompt({
      config: configNoPort,
      projectId: "my-app",
      project: configNoPort.projects["my-app"]!,
    });

    expect(prompt).toContain("**Dashboard Port**: 3000");
  });
});

describe("generateOrchestratorPrompt — reactions section", () => {
  it("omits reactions section when project has no reactions", () => {
    const projectNoReactions = { ...config.projects["my-app"]! };
    delete projectNoReactions.reactions;

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectNoReactions,
    });

    expect(prompt).not.toContain("## Automated Reactions");
  });

  it("omits reactions section when reactions object is empty", () => {
    const projectEmptyReactions = {
      ...config.projects["my-app"]!,
      reactions: {},
    };

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectEmptyReactions,
    });

    expect(prompt).not.toContain("## Automated Reactions");
  });

  it("includes auto send-to-agent reactions with retries and escalation", () => {
    const projectWithReactions = {
      ...config.projects["my-app"]!,
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent" as const,
          retries: 3,
          escalateAfter: "30m",
        },
      },
    };

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectWithReactions,
    });

    expect(prompt).toContain("## Automated Reactions");
    expect(prompt).toContain("**ci-failed**");
    expect(prompt).toContain("Auto-sends instruction to agent");
    expect(prompt).toContain("retries: 3");
    expect(prompt).toContain('escalates after: 30m');
  });

  it("includes auto notify reactions with priority", () => {
    const projectWithReactions = {
      ...config.projects["my-app"]!,
      reactions: {
        "agent-stuck": {
          auto: true,
          action: "notify" as const,
          priority: "urgent" as const,
        },
      },
    };

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectWithReactions,
    });

    expect(prompt).toContain("## Automated Reactions");
    expect(prompt).toContain("**agent-stuck**");
    expect(prompt).toContain("Notifies human");
    expect(prompt).toContain("priority: urgent");
  });

  it("shows 'none' for missing retries and 'never' for missing escalateAfter on send-to-agent", () => {
    const projectWithReactions = {
      ...config.projects["my-app"]!,
      reactions: {
        "review-comments": {
          auto: true,
          action: "send-to-agent" as const,
          // no retries, no escalateAfter
        },
      },
    };

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectWithReactions,
    });

    expect(prompt).toContain("retries: none");
    expect(prompt).toContain("escalates after: never");
  });

  it("ignores non-auto reactions", () => {
    const projectWithReactions = {
      ...config.projects["my-app"]!,
      reactions: {
        "approved-and-green": {
          auto: false,
          action: "notify" as const,
        },
      },
    };

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectWithReactions,
    });

    // Non-auto reactions are not listed, so no Automated Reactions section
    expect(prompt).not.toContain("## Automated Reactions");
  });

  it("ignores auto reactions with non-matching action (auto-merge)", () => {
    const projectWithReactions = {
      ...config.projects["my-app"]!,
      reactions: {
        "approved-and-green": {
          auto: true,
          action: "auto-merge" as const,
        },
      },
    };

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectWithReactions,
    });

    // auto-merge is not send-to-agent or notify, so no lines generated
    expect(prompt).not.toContain("## Automated Reactions");
  });

  it("includes mixed reactions correctly", () => {
    const projectWithReactions = {
      ...config.projects["my-app"]!,
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent" as const,
          retries: 2,
        },
        "agent-stuck": {
          auto: true,
          action: "notify" as const,
          priority: "warning" as const,
        },
        "approved-and-green": {
          auto: false,
          action: "notify" as const,
        },
      },
    };

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectWithReactions,
    });

    expect(prompt).toContain("## Automated Reactions");
    expect(prompt).toContain("**ci-failed**");
    expect(prompt).toContain("**agent-stuck**");
    expect(prompt).not.toContain("**approved-and-green**");
  });
});

describe("generateOrchestratorPrompt — orchestratorRules section", () => {
  it("includes project-specific rules when orchestratorRules is set", () => {
    const projectWithRules = {
      ...config.projects["my-app"]!,
      orchestratorRules: "Always prioritize security issues.\nNever auto-merge to production.",
    };

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectWithRules,
    });

    expect(prompt).toContain("## Project-Specific Rules");
    expect(prompt).toContain("Always prioritize security issues.");
    expect(prompt).toContain("Never auto-merge to production.");
  });

  it("omits project-specific rules when orchestratorRules is not set", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).not.toContain("## Project-Specific Rules");
  });
});

describe("generateOrchestratorPrompt — quick start and commands", () => {
  it("includes project-specific session prefix in examples", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("ao session ls -p my-app");
    expect(prompt).toContain('ao send app-1 "Your message here"');
    expect(prompt).toContain("ao session claim-pr 123 app-1");
    expect(prompt).toContain("ao session kill app-1");
    expect(prompt).toContain("ao open my-app");
  });

  it("includes available commands table", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("## Available Commands");
    expect(prompt).toContain("`ao status`");
    expect(prompt).toContain("`ao spawn");
    expect(prompt).toContain("`ao batch-spawn");
    expect(prompt).toContain("`ao session ls");
    expect(prompt).toContain("`ao session claim-pr");
    expect(prompt).toContain("`ao send");
    expect(prompt).toContain("`ao dashboard`");
  });

  it("includes dashboard section with correct port", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("## Dashboard");
    expect(prompt).toContain("http://localhost:3000");
  });
});

describe("generateOrchestratorPrompt — workflows section", () => {
  it("includes common workflows", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("## Common Workflows");
    expect(prompt).toContain("### Bulk Issue Processing");
    expect(prompt).toContain("### Handling Stuck Agents");
    expect(prompt).toContain("### PR Review Flow");
    expect(prompt).toContain("### Manual Intervention");
  });
});

describe("generateOrchestratorPrompt — tips section", () => {
  it("includes tips", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("## Tips");
    expect(prompt).toContain("Use batch-spawn for multiple issues");
    expect(prompt).toContain("Check status before spawning");
    expect(prompt).toContain("Let reactions handle routine issues");
    expect(prompt).toContain("Cleanup regularly");
  });
});

describe("generateOrchestratorPrompt — session management section", () => {
  it("includes session management details", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("## Session Management");
    expect(prompt).toContain("### Spawning Sessions");
    expect(prompt).toContain("### Monitoring Progress");
    expect(prompt).toContain("### Sending Messages");
    expect(prompt).toContain("### PR Takeover");
    expect(prompt).toContain("### Investigation Workflow");
    expect(prompt).toContain("### Cleanup");
  });

  it("uses project-specific session prefix in session management examples", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain(`ao send app-1 "Please address the review comments on your PR"`);
    expect(prompt).toContain("ao session cleanup -p my-app");
    expect(prompt).toContain(`from \`main\``);
  });
});

describe("generateOrchestratorPrompt — full prompt structure", () => {
  it("contains all major sections in order", () => {
    const projectFull = {
      ...config.projects["my-app"]!,
      orchestratorRules: "Custom rules here",
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent" as const,
          retries: 2,
        },
      },
    };

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectFull,
    });

    const headerIdx = prompt.indexOf("# My App Orchestrator");
    const rulesIdx = prompt.indexOf("## Non-Negotiable Rules");
    const projectInfoIdx = prompt.indexOf("## Project Info");
    const quickStartIdx = prompt.indexOf("## Quick Start");
    const commandsIdx = prompt.indexOf("## Available Commands");
    const sessionMgmtIdx = prompt.indexOf("## Session Management");
    const dashboardIdx = prompt.indexOf("## Dashboard");
    const reactionsIdx = prompt.indexOf("## Automated Reactions");
    const workflowsIdx = prompt.indexOf("## Common Workflows");
    const tipsIdx = prompt.indexOf("## Tips");
    const customRulesIdx = prompt.indexOf("## Project-Specific Rules");

    // All sections should exist
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(rulesIdx).toBeGreaterThan(headerIdx);
    expect(projectInfoIdx).toBeGreaterThan(rulesIdx);
    expect(quickStartIdx).toBeGreaterThan(projectInfoIdx);
    expect(commandsIdx).toBeGreaterThan(quickStartIdx);
    expect(sessionMgmtIdx).toBeGreaterThan(commandsIdx);
    expect(dashboardIdx).toBeGreaterThan(sessionMgmtIdx);
    expect(reactionsIdx).toBeGreaterThan(dashboardIdx);
    expect(workflowsIdx).toBeGreaterThan(reactionsIdx);
    expect(tipsIdx).toBeGreaterThan(workflowsIdx);
    expect(customRulesIdx).toBeGreaterThan(tipsIdx);
  });
});
