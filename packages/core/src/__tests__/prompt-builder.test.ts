import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildPrompt, BASE_AGENT_PROMPT } from "../prompt-builder.js";
import type { ProjectConfig } from "../types.js";

let tmpDir: string;
let project: ProjectConfig;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-prompt-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  project = {
    name: "Test App",
    repo: "org/test-app",
    path: tmpDir,
    defaultBranch: "main",
    sessionPrefix: "test",
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildPrompt", () => {
  it("includes base prompt on bare spawns", () => {
    const result = buildPrompt({ project, projectId: "test-app" });
    expect(result).toContain(BASE_AGENT_PROMPT);
    expect(result).toContain("## Project Context");
    expect(result).toContain("Project: Test App");
  });

  it("includes base prompt when issue is provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).not.toBeNull();
    expect(result).toContain(BASE_AGENT_PROMPT);
  });

  it("includes project context", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Test App");
    expect(result).toContain("org/test-app");
    expect(result).toContain("main");
  });

  it("includes issue ID in task section", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Work on issue: INT-1343");
    expect(result).toContain("feat/INT-1343");
  });

  it("includes issue context when provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      issueContext: "## Linear Issue INT-1343\nTitle: Layered Prompt System\nPriority: High",
    });
    expect(result).toContain("## Issue Details");
    expect(result).toContain("Layered Prompt System");
    expect(result).toContain("Priority: High");
  });

  it("includes inline agentRules", () => {
    project.agentRules = "Always run pnpm test before pushing.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("## Project Rules");
    expect(result).toContain("Always run pnpm test before pushing.");
  });

  it("reads agentRulesFile content", () => {
    const rulesPath = join(tmpDir, "agent-rules.md");
    writeFileSync(rulesPath, "Use conventional commits.\nNo force pushes.");
    project.agentRulesFile = "agent-rules.md";

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Use conventional commits.");
    expect(result).toContain("No force pushes.");
  });

  it("includes both agentRules and agentRulesFile", () => {
    project.agentRules = "Inline rule.";
    const rulesPath = join(tmpDir, "rules.txt");
    writeFileSync(rulesPath, "File rule.");
    project.agentRulesFile = "rules.txt";

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Inline rule.");
    expect(result).toContain("File rule.");
  });

  it("handles missing agentRulesFile gracefully", () => {
    project.agentRulesFile = "nonexistent-rules.md";

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    // Should not throw, should still build prompt without rules
    expect(result).not.toBeNull();
    expect(result).not.toContain("## Project Rules");
  });

  it("appends userPrompt last", () => {
    project.agentRules = "Project rule.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      userPrompt: "Focus on the API layer only.",
    });

    expect(result).not.toBeNull();
    const promptStr = result!;

    // User prompt should come after project rules
    const rulesIdx = promptStr.indexOf("Project rule.");
    const userIdx = promptStr.indexOf("Focus on the API layer only.");
    expect(rulesIdx).toBeLessThan(userIdx);
    expect(promptStr).toContain("## Additional Instructions");
  });

  it("builds prompt from rules alone (no issue)", () => {
    project.agentRules = "Always lint before committing.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    expect(result).not.toBeNull();
    expect(result).toContain(BASE_AGENT_PROMPT);
    expect(result).toContain("Always lint before committing.");
  });

  it("builds prompt from userPrompt alone (no issue, no rules)", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      userPrompt: "Just explore the codebase.",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("Just explore the codebase.");
  });

  it("includes tracker info in context", () => {
    project.tracker = { plugin: "linear" };
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).toContain("Tracker: linear");
  });

  it("uses project name in context", () => {
    const result = buildPrompt({
      project,
      projectId: "my-project",
      issueId: "INT-100",
    });
    expect(result).toContain("Project: Test App");
  });

  it("includes reaction hints for auto send-to-agent reactions", () => {
    project.reactions = {
      "ci-failed": { auto: true, action: "send-to-agent" },
      "approved-and-green": { auto: false, action: "notify" },
    };
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).toContain("ci-failed");
    expect(result).not.toContain("approved-and-green");
  });
});

describe("BASE_AGENT_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof BASE_AGENT_PROMPT).toBe("string");
    expect(BASE_AGENT_PROMPT.length).toBeGreaterThan(100);
  });

  it("covers key topics", () => {
    expect(BASE_AGENT_PROMPT).toContain("Session Lifecycle");
    expect(BASE_AGENT_PROMPT).toContain("Git Workflow");
    expect(BASE_AGENT_PROMPT).toContain("PR Best Practices");
    expect(BASE_AGENT_PROMPT).toContain("ao session claim-pr");
  });
});

// =============================================================================
// Additional coverage: lineage, siblings, reactions, edge cases
// =============================================================================

describe("buildPrompt — lineage (decomposition context)", () => {
  it("includes task hierarchy when lineage is provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
      lineage: ["Build full-stack app", "Backend services"],
    });

    expect(result).toContain("## Task Hierarchy");
    expect(result).toContain("0. Build full-stack app");
    expect(result).toContain("  1. Backend services");
    expect(result).toContain("2. INT-100  <-- (this task)");
    expect(result).toContain("Stay focused on YOUR specific task");
  });

  it("uses 'this task' label when issueId is not set", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      lineage: ["Root task"],
    });

    expect(result).toContain("## Task Hierarchy");
    expect(result).toContain("1. this task  <-- (this task)");
  });

  it("omits task hierarchy when lineage is empty", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      lineage: [],
    });

    expect(result).not.toContain("## Task Hierarchy");
  });

  it("omits task hierarchy when lineage is not provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
    });

    expect(result).not.toContain("## Task Hierarchy");
  });
});

describe("buildPrompt — siblings (parallel work context)", () => {
  it("includes parallel work section when siblings are provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      siblings: ["Build API endpoints", "Set up database"],
    });

    expect(result).toContain("## Parallel Work");
    expect(result).toContain("Sibling tasks being worked on in parallel:");
    expect(result).toContain("  - Build API endpoints");
    expect(result).toContain("  - Set up database");
    expect(result).toContain("Do not duplicate work that sibling tasks handle");
  });

  it("omits parallel work section when siblings is empty", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      siblings: [],
    });

    expect(result).not.toContain("## Parallel Work");
  });

  it("omits parallel work section when siblings is not provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
    });

    expect(result).not.toContain("## Parallel Work");
  });
});

describe("buildPrompt — lineage and siblings together", () => {
  it("includes both sections when both are provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-50",
      lineage: ["Root project", "Backend module"],
      siblings: ["Auth service", "Payment service"],
    });

    expect(result).toContain("## Task Hierarchy");
    expect(result).toContain("## Parallel Work");

    // Hierarchy should come before parallel work
    const hierarchyIdx = result.indexOf("## Task Hierarchy");
    const parallelIdx = result.indexOf("## Parallel Work");
    expect(hierarchyIdx).toBeLessThan(parallelIdx);
  });
});

describe("buildPrompt — reactions config", () => {
  it("includes reaction hints for multiple auto send-to-agent reactions", () => {
    project.reactions = {
      "ci-failed": { auto: true, action: "send-to-agent" },
      "changes-requested": { auto: true, action: "send-to-agent" },
      "agent-stuck": { auto: true, action: "notify" },
    };
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).toContain("## Automated Reactions");
    expect(result).toContain("ci-failed: auto-handled");
    expect(result).toContain("changes-requested: auto-handled");
    // notify reactions are not included in agent prompt
    expect(result).not.toContain("agent-stuck");
  });

  it("omits reactions section when no auto send-to-agent reactions exist", () => {
    project.reactions = {
      "approved-and-green": { auto: false, action: "notify" },
      "agent-stuck": { auto: true, action: "notify" },
    };
    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    expect(result).not.toContain("## Automated Reactions");
  });

  it("omits reactions section when reactions is not set", () => {
    delete project.reactions;
    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    expect(result).not.toContain("## Automated Reactions");
  });
});

describe("buildPrompt — readUserRules edge cases", () => {
  it("handles agentRulesFile pointing to empty file", () => {
    const rulesPath = join(tmpDir, "empty-rules.md");
    writeFileSync(rulesPath, "");
    project.agentRulesFile = "empty-rules.md";

    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    // Empty file content (after trim) should not produce a rules section
    expect(result).not.toContain("## Project Rules");
  });

  it("handles agentRulesFile with only whitespace", () => {
    const rulesPath = join(tmpDir, "whitespace-rules.md");
    writeFileSync(rulesPath, "   \n  \n  ");
    project.agentRulesFile = "whitespace-rules.md";

    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    // Trimmed empty content should not produce rules
    expect(result).not.toContain("## Project Rules");
  });

  it("handles agentRules being set and agentRulesFile missing", () => {
    project.agentRules = "Use TypeScript strict mode.";
    project.agentRulesFile = "does-not-exist.md";

    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    // Should still include inline rules even though file is missing
    expect(result).toContain("## Project Rules");
    expect(result).toContain("Use TypeScript strict mode.");
  });
});

describe("buildPrompt — section ordering", () => {
  it("places sections in correct order: base, config, rules, hierarchy, siblings, userPrompt", () => {
    project.agentRules = "Rule here.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1",
      lineage: ["Root"],
      siblings: ["Sibling"],
      userPrompt: "Focus on tests.",
    });

    const baseIdx = result.indexOf("Session Lifecycle");
    const contextIdx = result.indexOf("## Project Context");
    const rulesIdx = result.indexOf("## Project Rules");
    const hierarchyIdx = result.indexOf("## Task Hierarchy");
    const parallelIdx = result.indexOf("## Parallel Work");
    const instructionsIdx = result.indexOf("## Additional Instructions");

    expect(baseIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(rulesIdx);
    expect(rulesIdx).toBeLessThan(hierarchyIdx);
    expect(hierarchyIdx).toBeLessThan(parallelIdx);
    expect(parallelIdx).toBeLessThan(instructionsIdx);
  });

  it("uses projectId as fallback when project.name is not set", () => {
    const projectNoName = { ...project };
    delete (projectNoName as Record<string, unknown>).name;

    const result = buildPrompt({
      project: projectNoName,
      projectId: "fallback-id",
    });

    expect(result).toContain("Project: fallback-id");
  });
});
