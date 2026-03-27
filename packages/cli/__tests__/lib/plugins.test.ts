import { describe, it, expect } from "vitest";
import { getAgent, getAgentByName } from "../../src/lib/plugins.js";
import type { OrchestratorConfig } from "@composio/ao-core";

function makeConfig(
  defaultAgent: string,
  projects?: Record<string, { agent?: string }>,
): OrchestratorConfig {
  return {
    dataDir: "/tmp",
    worktreeDir: "/tmp/wt",
    port: 3000,
    defaults: { runtime: "tmux", agent: defaultAgent, workspace: "worktree", notifiers: [] },
    projects: Object.fromEntries(
      Object.entries(projects ?? { app: {} }).map(([id, p]) => [
        id,
        { name: id, repo: "", path: "", defaultBranch: "main", ...p },
      ]),
    ),
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as OrchestratorConfig;
}

describe("getAgent", () => {
  it("returns claude-code agent by default", () => {
    const config = makeConfig("claude-code");
    const agent = getAgent(config);
    expect(agent.name).toBe("claude-code");
  });

  it("returns codex agent when project overrides agent", () => {
    const config = makeConfig("claude-code", { myapp: { agent: "codex" } });
    const agent = getAgent(config, "myapp");
    expect(agent.name).toBe("codex");
  });

  it("throws on unknown agent name", () => {
    const config = makeConfig("nonexistent");
    expect(() => getAgent(config)).toThrow("Unknown agent plugin: nonexistent");
  });

  it("falls back to config default when project has no agent override", () => {
    const config = makeConfig("aider", { myapp: {} });
    const agent = getAgent(config, "myapp");
    expect(agent.name).toBe("aider");
  });

  it("falls back to config default when projectId does not exist", () => {
    const config = makeConfig("claude-code");
    const agent = getAgent(config, "nonexistent-project");
    expect(agent.name).toBe("claude-code");
  });
});

describe("getAgentByName", () => {
  it("returns agent for claude-code", () => {
    expect(getAgentByName("claude-code").name).toBe("claude-code");
  });

  it("returns agent for codex", () => {
    expect(getAgentByName("codex").name).toBe("codex");
  });

  it("returns agent for aider", () => {
    expect(getAgentByName("aider").name).toBe("aider");
  });

  it("returns agent for opencode", () => {
    expect(getAgentByName("opencode").name).toBe("opencode");
  });

  it("returns agent for cursor", () => {
    expect(getAgentByName("cursor").name).toBe("cursor");
  });

  it("throws on unknown name", () => {
    expect(() => getAgentByName("unknown")).toThrow("Unknown agent plugin: unknown");
  });
});
