import { describe, it, expect } from "vitest";
import { buildTeamPrompt } from "../team-prompt-builder.js";

describe("buildTeamPrompt", () => {
  const baseConfig = {
    agentName: "driver",
    role: "driver",
    phase: "implement" as const,
    worktreePath: "/tmp/test-worktree",
    agentsDir: "/tmp/test-worktree/.agents",
    fileScope: ["src/auth.ts", "src/types/auth.ts"],
    sharedFiles: ["src/index.ts"],
  };

  it("generates inline toolkit skill when no toolkitSkill provided", () => {
    const prompt = buildTeamPrompt(baseConfig);
    expect(prompt).toContain("ao-teams Agent Toolkit");
    expect(prompt).toContain("ao-bus-cli");
    expect(prompt).toContain("--agent driver");
    expect(prompt).toContain("--phase implement");
    expect(prompt).toContain("src/auth.ts");
  });

  it("uses provided toolkit skill content", () => {
    const prompt = buildTeamPrompt({
      ...baseConfig,
      toolkitSkill: "# Custom Toolkit\nUse ao-bus commands.",
    });
    expect(prompt).toContain("# Custom Toolkit");
    expect(prompt).not.toContain("ao-teams Agent Toolkit");
  });

  it("includes phase instructions", () => {
    const prompt = buildTeamPrompt({
      ...baseConfig,
      phaseInstructions: "Implement the auth middleware.",
    });
    expect(prompt).toContain("## Phase: implement");
    expect(prompt).toContain("Implement the auth middleware.");
  });

  it("includes task description", () => {
    const prompt = buildTeamPrompt({
      ...baseConfig,
      taskDescription: "Add JWT authentication",
    });
    expect(prompt).toContain("## Task");
    expect(prompt).toContain("Add JWT authentication");
  });

  it("includes plan context with work units", () => {
    const prompt = buildTeamPrompt({
      ...baseConfig,
      plan: {
        summary: "Implement auth",
        workUnits: [
          {
            id: "wu-1",
            description: "Auth middleware",
            assignedTo: "driver",
            files: ["src/auth.ts"],
            criteria: "Validates JWT tokens",
          },
          {
            id: "wu-2",
            description: "Tests",
            assignedTo: "tester",
            files: ["src/auth.test.ts"],
            criteria: "100% coverage",
          },
        ],
        sharedFiles: ["src/index.ts"],
        integrateOrder: ["driver", "tester"],
      },
    });
    expect(prompt).toContain("## Plan");
    expect(prompt).toContain("Your Work Units");
    expect(prompt).toContain("wu-1");
    expect(prompt).toContain("Auth middleware");
    expect(prompt).toContain("Other Work Units");
    expect(prompt).toContain("wu-2");
  });

  it("includes messages", () => {
    const prompt = buildTeamPrompt({
      ...baseConfig,
      messages: [
        {
          seq: 1,
          ts: new Date().toISOString(),
          from: "reviewer",
          to: "driver",
          phase: "review",
          type: "revision_request",
          content: "Fix the error handling in auth.ts",
          priority: "high",
        },
      ],
    });
    expect(prompt).toContain("## Messages");
    expect(prompt).toContain("reviewer");
    expect(prompt).toContain("Fix the error handling");
    expect(prompt).toContain("[high]");
  });

  it("includes learnings", () => {
    const prompt = buildTeamPrompt({
      ...baseConfig,
      learningsContent: "- Use barrel exports in src/modules/\n- Zod over io-ts",
    });
    expect(prompt).toContain("## Project Learnings");
    expect(prompt).toContain("barrel exports");
  });

  it("includes prior work", () => {
    const prompt = buildTeamPrompt({
      ...baseConfig,
      priorWork: "### Git Diff\n```diff\n+function auth() {}\n```",
    });
    expect(prompt).toContain("## Prior Work");
    expect(prompt).toContain("Git Diff");
  });

  it("shows role and file scope in inline toolkit", () => {
    const prompt = buildTeamPrompt(baseConfig);
    expect(prompt).toContain("Your Role: driver");
    expect(prompt).toContain("Current Phase: implement");
    expect(prompt).toContain("src/auth.ts, src/types/auth.ts");
    expect(prompt).toContain("src/index.ts");
  });
});
