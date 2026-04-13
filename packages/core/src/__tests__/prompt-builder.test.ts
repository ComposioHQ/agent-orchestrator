import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  buildPrompt,
  buildWorkerSystemInstructions,
  buildWorkerTaskPrompt,
  BASE_AGENT_PROMPT,
} from "../prompt-builder.js";
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

describe("buildWorkerSystemInstructions", () => {
  it("includes base prompt", () => {
    const result = buildWorkerSystemInstructions({ project, projectId: "test-app" });
    expect(result).toContain(BASE_AGENT_PROMPT);
  });

  it("includes project context", () => {
    const result = buildWorkerSystemInstructions({ project, projectId: "test-app" });
    expect(result).toContain("## Project Context");
    expect(result).toContain("Project: Test App");
    expect(result).toContain("org/test-app");
    expect(result).toContain("main");
  });

  it("includes tracker info", () => {
    project.tracker = { plugin: "linear" };
    const result = buildWorkerSystemInstructions({ project, projectId: "test-app" });
    expect(result).toContain("Tracker: linear");
  });

  it("includes project rules from agentRules", () => {
    project.agentRules = "Always run tests before pushing.";
    const result = buildWorkerSystemInstructions({ project, projectId: "test-app" });
    expect(result).toContain("## Project Rules");
    expect(result).toContain("Always run tests before pushing.");
  });

  it("includes project rules from agentRulesFile", () => {
    const rulesPath = join(tmpDir, "agent-rules.md");
    writeFileSync(rulesPath, "Use conventional commits.");
    project.agentRulesFile = "agent-rules.md";
    const result = buildWorkerSystemInstructions({ project, projectId: "test-app" });
    expect(result).toContain("Use conventional commits.");
  });

  it("does NOT include issue/task content even when issueId is supplied", () => {
    const result = buildWorkerSystemInstructions({
      project,
      projectId: "test-app",
      issueId: "INT-999",
      issueContext: "Some issue details",
    });
    expect(result).not.toContain("INT-999");
    expect(result).not.toContain("Some issue details");
    expect(result).not.toContain("## Task");
    expect(result).not.toContain("## Issue Details");
  });

  it("does NOT include userPrompt even when supplied", () => {
    const result = buildWorkerSystemInstructions({
      project,
      projectId: "test-app",
      userPrompt: "Focus on the auth layer.",
    });
    expect(result).not.toContain("Focus on the auth layer.");
    expect(result).not.toContain("## Additional Instructions");
  });

  it("includes automated reaction hints", () => {
    project.reactions = {
      "ci-failed": { auto: true, action: "send-to-agent" },
      "approved-and-green": { auto: false, action: "notify" },
    };
    const result = buildWorkerSystemInstructions({ project, projectId: "test-app" });
    expect(result).toContain("ci-failed");
    expect(result).not.toContain("approved-and-green");
  });
});

describe("buildWorkerTaskPrompt", () => {
  it("returns empty string when no issue, context, or userPrompt", () => {
    const result = buildWorkerTaskPrompt({ project, projectId: "test-app" });
    expect(result).toBe("");
  });

  it("includes issue task section when issueId supplied", () => {
    const result = buildWorkerTaskPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-42",
    });
    expect(result).toContain("## Task");
    expect(result).toContain("Work on issue: INT-42");
    expect(result).toContain("feat/INT-42");
  });

  it("includes issue context when supplied", () => {
    const result = buildWorkerTaskPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-42",
      issueContext: "Title: Fix login\nPriority: High",
    });
    expect(result).toContain("## Issue Details");
    expect(result).toContain("Fix login");
    expect(result).toContain("Priority: High");
  });

  it("includes userPrompt as additional instructions", () => {
    const result = buildWorkerTaskPrompt({
      project,
      projectId: "test-app",
      userPrompt: "Focus on the auth layer.",
    });
    expect(result).toContain("## Additional Instructions");
    expect(result).toContain("Focus on the auth layer.");
  });

  it("does NOT include base prompt or project context", () => {
    const result = buildWorkerTaskPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-42",
      userPrompt: "Some task.",
    });
    expect(result).not.toContain(BASE_AGENT_PROMPT);
    expect(result).not.toContain("## Project Context");
    expect(result).not.toContain("Project: Test App");
  });

  it("does NOT include project rules", () => {
    project.agentRules = "Inline rule.";
    const result = buildWorkerTaskPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-42",
    });
    expect(result).not.toContain("Inline rule.");
    expect(result).not.toContain("## Project Rules");
  });

  it("ordering: task before issue details before additional instructions", () => {
    const result = buildWorkerTaskPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-42",
      issueContext: "Issue body here",
      userPrompt: "Do this extra thing.",
    });
    const taskIdx = result.indexOf("## Task");
    const detailsIdx = result.indexOf("## Issue Details");
    const additionalIdx = result.indexOf("## Additional Instructions");
    expect(taskIdx).toBeLessThan(detailsIdx);
    expect(detailsIdx).toBeLessThan(additionalIdx);
  });
});
