import { describe, it, expect } from "vitest";
import { generateOrchestratorPrompt } from "../orchestrator-prompt.js";
import type { OrchestratorConfig, ProjectConfig } from "../types.js";

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    name: "My App",
    repo: "org/my-app",
    path: "/tmp/my-app",
    defaultBranch: "main",
    sessionPrefix: "myapp",
    ...overrides,
  };
}

function makeConfig(
  project?: Partial<ProjectConfig>,
  configOverrides?: Partial<OrchestratorConfig>,
): OrchestratorConfig {
  return {
    port: 3000,
    configPath: "/tmp/agent-orchestrator.yaml",
    projects: { "my-app": makeProject(project) },
    ...configOverrides,
  } as OrchestratorConfig;
}

function generate(
  project?: Partial<ProjectConfig>,
  configOverrides?: Partial<OrchestratorConfig>,
): string {
  const config = makeConfig(project, configOverrides);
  return generateOrchestratorPrompt({
    config,
    projectId: "my-app",
    project: config.projects["my-app"],
  });
}

describe("generateOrchestratorPrompt", () => {
  describe("identity and role", () => {
    it("establishes the agent as an orchestrator", () => {
      const prompt = generate();
      expect(prompt).toContain("orchestrator agent");
      expect(prompt).toContain("My App");
    });

    it("explicitly states the agent should NOT implement", () => {
      const prompt = generate();
      expect(prompt).toContain("you do NOT implement");
    });

    it("describes the core responsibilities", () => {
      const prompt = generate();
      expect(prompt).toContain("Spawn");
      expect(prompt).toContain("Monitor");
      expect(prompt).toContain("Intervene");
      expect(prompt).toContain("Delegate");
      expect(prompt).toContain("Clean up");
    });

    it("warns against writing code", () => {
      const prompt = generate();
      expect(prompt).toContain("Never write code");
    });
  });

  describe("project info", () => {
    it("includes project metadata", () => {
      const prompt = generate();
      expect(prompt).toContain("My App");
      expect(prompt).toContain("org/my-app");
      expect(prompt).toContain("`main`");
      expect(prompt).toContain("`myapp`");
      expect(prompt).toContain("http://localhost:3000");
    });

    it("shows session naming convention", () => {
      const prompt = generate();
      expect(prompt).toContain("`myapp-1`");
      expect(prompt).toContain("`myapp-2`");
    });

    it("uses custom port from config", () => {
      const prompt = generate({}, { port: 8080 } as Partial<OrchestratorConfig>);
      expect(prompt).toContain("http://localhost:8080");
    });
  });

  describe("CLI reference", () => {
    it("documents ao status command", () => {
      const prompt = generate();
      expect(prompt).toContain("### ao status");
      expect(prompt).toContain("ao status");
      expect(prompt).toContain("--json");
      expect(prompt).toContain("-p my-app");
    });

    it("documents ao spawn command", () => {
      const prompt = generate();
      expect(prompt).toContain("### ao spawn");
      expect(prompt).toContain("ao spawn my-app");
      expect(prompt).toContain("--open");
    });

    it("documents ao batch-spawn command", () => {
      const prompt = generate();
      expect(prompt).toContain("### ao batch-spawn");
      expect(prompt).toContain("ao batch-spawn my-app");
      expect(prompt).toContain("Duplicate detection");
    });

    it("documents ao send command with all flags", () => {
      const prompt = generate();
      expect(prompt).toContain("### ao send");
      expect(prompt).toContain("ao send myapp-1");
      expect(prompt).toContain("-f");
      expect(prompt).toContain("--no-wait");
      expect(prompt).toContain("--timeout");
    });

    it("documents ao session ls command", () => {
      const prompt = generate();
      expect(prompt).toContain("### ao session ls");
    });

    it("documents ao session kill command", () => {
      const prompt = generate();
      expect(prompt).toContain("### ao session kill");
      expect(prompt).toContain("Irreversible");
    });

    it("documents ao session cleanup command", () => {
      const prompt = generate();
      expect(prompt).toContain("### ao session cleanup");
      expect(prompt).toContain("--dry-run");
    });

    it("documents ao review-check command", () => {
      const prompt = generate();
      expect(prompt).toContain("### ao review-check");
    });

    it("documents ao open command", () => {
      const prompt = generate();
      expect(prompt).toContain("### ao open");
      expect(prompt).toContain("-w");
    });

    it("documents ao dashboard command", () => {
      const prompt = generate();
      expect(prompt).toContain("### ao dashboard");
    });

    it("documents ao start / ao stop", () => {
      const prompt = generate();
      expect(prompt).toContain("### ao start");
      expect(prompt).toContain("ao stop");
    });

    it("warns against raw tmux send-keys", () => {
      const prompt = generate();
      expect(prompt).toContain("Never use `tmux send-keys`");
    });
  });

  describe("session lifecycle", () => {
    it("describes the full lifecycle flow", () => {
      const prompt = generate();
      expect(prompt).toContain("Session Lifecycle");
      expect(prompt).toContain("Worktree created");
      expect(prompt).toContain("Feature branch");
      expect(prompt).toContain("tmux session");
      expect(prompt).toContain("Agent launched");
      expect(prompt).toContain("PR merged");
    });

    it("uses project-specific values in lifecycle", () => {
      const prompt = generate({ defaultBranch: "develop", sessionPrefix: "dev" });
      expect(prompt).toContain("origin/develop");
      expect(prompt).toContain("dev-N");
    });
  });

  describe("behavioral guidelines", () => {
    it("includes positive behaviors", () => {
      const prompt = generate();
      expect(prompt).toContain("Check before spawning");
      expect(prompt).toContain("ao send");
      expect(prompt).toContain("Delegate, don't duplicate");
      expect(prompt).toContain("Batch when possible");
      expect(prompt).toContain("Clean up after merges");
    });

    it("includes anti-patterns", () => {
      const prompt = generate();
      expect(prompt).toContain("Never write code");
      expect(prompt).toContain("Never use legacy scripts");
      expect(prompt).toContain("Never use raw tmux");
      expect(prompt).toContain("Never spawn for trivial tasks");
      expect(prompt).toContain("Never duplicate work");
    });
  });

  describe("workflows", () => {
    it("includes batch processing workflow", () => {
      const prompt = generate();
      expect(prompt).toContain("Process a Batch of Issues");
      expect(prompt).toContain("ao batch-spawn");
    });

    it("includes stuck worker workflow", () => {
      const prompt = generate();
      expect(prompt).toContain("Handle a Stuck Worker");
      expect(prompt).toContain("capture-pane");
    });

    it("includes PR review workflow", () => {
      const prompt = generate();
      expect(prompt).toContain("Handle PR Review Comments");
      expect(prompt).toContain("ao review-check");
    });

    it("includes cleanup workflow", () => {
      const prompt = generate();
      expect(prompt).toContain("Clean Up After Merge");
      expect(prompt).toContain("--dry-run");
    });
  });

  describe("reactions", () => {
    it("omits reactions section when no reactions configured", () => {
      const prompt = generate();
      expect(prompt).not.toContain("Automated Reactions");
    });

    it("includes auto send-to-agent reactions", () => {
      const prompt = generate({
        reactions: {
          "ci-failed": { auto: true, action: "send-to-agent", retries: 3, escalateAfter: "2h" },
        },
      });
      expect(prompt).toContain("Automated Reactions");
      expect(prompt).toContain("ci-failed");
      expect(prompt).toContain("retries: 3");
      expect(prompt).toContain("escalates after: 2h");
    });

    it("includes notify reactions", () => {
      const prompt = generate({
        reactions: {
          "approved-and-green": { auto: true, action: "notify", priority: "urgent" },
        },
      });
      expect(prompt).toContain("approved-and-green");
      expect(prompt).toContain("priority: urgent");
    });

    it("skips non-auto reactions", () => {
      const prompt = generate({
        reactions: {
          "ci-failed": { auto: false, action: "send-to-agent" },
        },
      });
      expect(prompt).not.toContain("Automated Reactions");
    });
  });

  describe("project-specific rules", () => {
    it("omits section when no orchestratorRules configured", () => {
      const prompt = generate();
      expect(prompt).not.toContain("Project-Specific Rules");
    });

    it("includes orchestratorRules when configured", () => {
      const prompt = generate({
        orchestratorRules: "Always use `next` branch. Never push directly to main.",
      });
      expect(prompt).toContain("Project-Specific Rules");
      expect(prompt).toContain("Always use `next` branch");
      expect(prompt).toContain("Never push directly to main");
    });
  });

  describe("quick start", () => {
    it("uses project-specific values", () => {
      const prompt = generate({ sessionPrefix: "int" });
      expect(prompt).toContain("ao spawn my-app");
      expect(prompt).toContain("ao send int-1");
      expect(prompt).toContain("ao session ls -p my-app");
      expect(prompt).toContain("ao open my-app");
    });
  });

  describe("dashboard", () => {
    it("includes dashboard info", () => {
      const prompt = generate();
      expect(prompt).toContain("Dashboard");
      expect(prompt).toContain("http://localhost:3000");
      expect(prompt).toContain("Server-Sent Events");
    });
  });
});
