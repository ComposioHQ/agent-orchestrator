import { describe, it, expect } from "vitest";

import { getConfigInstruction } from "../../src/lib/config-instruction.js";

describe("getConfigInstruction", () => {
  const output = getConfigInstruction();

  it("returns a non-empty string", () => {
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });

  it("starts with the header", () => {
    expect(output).toMatch(/^# Agent Orchestrator Config Reference/);
  });

  it("does not have leading/trailing whitespace (trimmed)", () => {
    expect(output).toBe(output.trim());
  });

  // --- Top-level settings ---
  it("documents port setting", () => {
    expect(output).toContain("port:");
    expect(output).toContain("3000");
  });

  it("documents terminalPort setting", () => {
    expect(output).toContain("terminalPort:");
  });

  it("documents directTerminalPort setting", () => {
    expect(output).toContain("directTerminalPort:");
  });

  it("documents readyThresholdMs setting", () => {
    expect(output).toContain("readyThresholdMs:");
  });

  // --- Defaults section ---
  it("documents defaults section", () => {
    expect(output).toContain("defaults:");
  });

  it("documents runtime options (tmux | process)", () => {
    expect(output).toContain("runtime:");
    expect(output).toContain("tmux");
    expect(output).toContain("process");
  });

  it("documents agent options", () => {
    expect(output).toContain("agent:");
    expect(output).toContain("claude-code");
    expect(output).toContain("aider");
    expect(output).toContain("codex");
    expect(output).toContain("opencode");
  });

  it("documents workspace options (worktree | clone)", () => {
    expect(output).toContain("workspace:");
    expect(output).toContain("worktree");
    expect(output).toContain("clone");
  });

  it("documents notifiers list", () => {
    expect(output).toContain("notifiers:");
    expect(output).toContain("desktop");
    expect(output).toContain("discord");
    expect(output).toContain("slack");
    expect(output).toContain("webhook");
  });

  // --- Projects section ---
  it("documents projects configuration", () => {
    expect(output).toContain("projects:");
    expect(output).toContain("name:");
    expect(output).toContain("repo:");
    expect(output).toContain("path:");
    expect(output).toContain("defaultBranch:");
    expect(output).toContain("sessionPrefix:");
  });

  it("documents agentConfig options", () => {
    expect(output).toContain("agentConfig:");
    expect(output).toContain("permissions:");
    expect(output).toContain("model:");
  });

  it("documents agentRules and agentRulesFile", () => {
    expect(output).toContain("agentRules:");
    expect(output).toContain("agentRulesFile:");
  });

  it("documents orchestratorRules", () => {
    expect(output).toContain("orchestratorRules:");
  });

  it("documents orchestratorSessionStrategy", () => {
    expect(output).toContain("orchestratorSessionStrategy:");
    expect(output).toContain("reuse");
    expect(output).toContain("delete");
    expect(output).toContain("ignore");
  });

  it("documents symlinks and postCreate", () => {
    expect(output).toContain("symlinks:");
    expect(output).toContain("postCreate:");
  });

  it("documents tracker configuration", () => {
    expect(output).toContain("tracker:");
    expect(output).toContain("github");
    expect(output).toContain("linear");
    expect(output).toContain("gitlab");
  });

  it("documents SCM configuration", () => {
    expect(output).toContain("scm:");
  });

  it("documents decomposer configuration", () => {
    expect(output).toContain("decomposer:");
    expect(output).toContain("enabled:");
    expect(output).toContain("maxDepth:");
    expect(output).toContain("requireApproval:");
  });

  // --- Notification routing ---
  it("documents notificationRouting", () => {
    expect(output).toContain("notificationRouting:");
    expect(output).toContain("critical:");
    expect(output).toContain("high:");
    expect(output).toContain("low:");
  });

  // --- Available plugins ---
  it("lists available plugin types at the end", () => {
    expect(output).toContain("Available plugins");
    expect(output).toContain("Agent:");
    expect(output).toContain("Runtime:");
    expect(output).toContain("Workspace:");
    expect(output).toContain("SCM:");
    expect(output).toContain("Tracker:");
    expect(output).toContain("Notifier:");
    expect(output).toContain("Terminal:");
  });

  it("mentions openclaw notifier", () => {
    expect(output).toContain("openclaw");
  });

  it("mentions composio notifier", () => {
    expect(output).toContain("composio");
  });
});
