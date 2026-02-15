import { describe, it, expect } from "vitest";
import { getAgent, getAgentByName, getNotifier } from "../../src/lib/plugins.js";
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

  it("throws on unknown name", () => {
    expect(() => getAgentByName("unknown")).toThrow("Unknown agent plugin: unknown");
  });
});

describe("getNotifier", () => {
  it("returns desktop notifier plugin", () => {
    const plugin = getNotifier("desktop");
    expect(plugin).toBeDefined();
    expect(typeof plugin.create).toBe("function");
  });

  it("returns slack notifier plugin", () => {
    const plugin = getNotifier("slack");
    expect(plugin).toBeDefined();
    expect(typeof plugin.create).toBe("function");
  });

  it("returns webhook notifier plugin", () => {
    const plugin = getNotifier("webhook");
    expect(plugin).toBeDefined();
    expect(typeof plugin.create).toBe("function");
  });

  it("returns composio notifier plugin", () => {
    const plugin = getNotifier("composio");
    expect(plugin).toBeDefined();
    expect(typeof plugin.create).toBe("function");
  });

  it("throws on unknown notifier name", () => {
    expect(() => getNotifier("unknown")).toThrow('Unknown notifier plugin: "unknown"');
  });

  it("creates a working notifier from plugin", () => {
    const plugin = getNotifier("desktop");
    const notifier = plugin.create({ sound: false });
    expect(notifier.name).toBe("desktop");
    expect(typeof notifier.notify).toBe("function");
  });
});
