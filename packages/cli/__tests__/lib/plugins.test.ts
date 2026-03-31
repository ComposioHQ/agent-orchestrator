import { describe, it, expect, beforeEach, vi } from "vitest";

const { githubCreateMock, forgejoCreateMock } = vi.hoisted(() => ({
  githubCreateMock: vi.fn(() => ({ name: "github" })),
  forgejoCreateMock: vi.fn(() => ({ name: "forgejo" })),
}));

vi.mock("@composio/ao-plugin-scm-github", () => ({
  default: { create: githubCreateMock },
}));

vi.mock("@composio/ao-plugin-scm-forgejo", () => ({
  default: { create: forgejoCreateMock },
}));

import { getAgent, getAgentByName, getSCM } from "../../src/lib/plugins.js";
import type { OrchestratorConfig } from "@composio/ao-core";

function makeConfig(
  defaultAgent: string,
  projects?: Record<string, { agent?: string; scm?: Record<string, unknown> }>,
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("throws on unknown name", () => {
    expect(() => getAgentByName("unknown")).toThrow("Unknown agent plugin: unknown");
  });
});

describe("getSCM", () => {
  it("returns github SCM by default", () => {
    const config = makeConfig("claude-code", { myapp: {} });
    const scm = getSCM(config, "myapp");

    expect(scm.name).toBe("github");
    expect(githubCreateMock).toHaveBeenCalledWith(undefined);
  });

  it("passes project SCM config to forgejo plugin create", () => {
    const config = makeConfig("claude-code", {
      myapp: { scm: { plugin: "forgejo", host: "forgejo.acme.internal" } },
    });

    const scm = getSCM(config, "myapp");

    expect(scm.name).toBe("forgejo");
    expect(forgejoCreateMock).toHaveBeenCalledWith({
      plugin: "forgejo",
      host: "forgejo.acme.internal",
    });
  });

  it("throws on unknown SCM plugin", () => {
    const config = makeConfig("claude-code", {
      myapp: { scm: { plugin: "unknown" } },
    });

    expect(() => getSCM(config, "myapp")).toThrow("Unknown SCM plugin: unknown");
  });
});
