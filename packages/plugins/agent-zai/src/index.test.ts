import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentLaunchConfig } from "@composio/ao-core";
import { create, manifest, default as defaultExport } from "./index.js";

const TEST_ENV_KEYS = [
  "ZAI_API_KEY",
  "ZAI_ALT_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ZAI_ANTHROPIC_BASE_URL",
] as const;

let envSnapshot: Record<string, string | undefined> = {};

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of TEST_ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function clearTestEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of TEST_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
    },
    ...overrides,
  };
}

beforeEach(() => {
  envSnapshot = snapshotEnv();
  clearTestEnv();
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "zai",
      slot: "agent",
      description: "Agent plugin: z.ai (GLM) via Claude Code compatible API",
      version: "0.1.0",
    });
  });

  it("create() returns agent with expected identity", () => {
    process.env["ZAI_API_KEY"] = "zai-key";
    const agent = create();
    expect(agent.name).toBe("zai");
    expect(agent.processName).toBe("claude");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("getLaunchCommand", () => {
  it("delegates to Claude Code command generation", () => {
    process.env["ZAI_API_KEY"] = "zai-key";
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix tests" }));
    expect(cmd).toContain("claude");
    expect(cmd).toContain("-p 'Fix tests'");
  });

  it("uses explicit model from standard agentConfig.model", () => {
    process.env["ZAI_API_KEY"] = "zai-key";
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "glm-4.5" }));
    expect(cmd).toContain("--model 'glm-4.5'");
  });

  it("falls back to agentConfig.zaiModel when model is not provided", () => {
    process.env["ZAI_API_KEY"] = "zai-key";
    const agent = create();
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          name: "my-project",
          repo: "owner/repo",
          path: "/workspace/repo",
          defaultBranch: "main",
          sessionPrefix: "my",
          agentConfig: { zaiModel: "glm-4.5-flash" },
        },
      }),
    );
    expect(cmd).toContain("--model 'glm-4.5-flash'");
  });

  it("prefers explicit model over zaiModel fallback", () => {
    process.env["ZAI_API_KEY"] = "zai-key";
    const agent = create();
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        model: "glm-5",
        projectConfig: {
          name: "my-project",
          repo: "owner/repo",
          path: "/workspace/repo",
          defaultBranch: "main",
          sessionPrefix: "my",
          agentConfig: { zaiModel: "glm-4.5-flash" },
        },
      }),
    );
    expect(cmd).toContain("--model 'glm-5'");
    expect(cmd).not.toContain("glm-4.5-flash");
  });
});

describe("getEnvironment", () => {
  it("sets default z.ai base URL and reads token from ZAI_API_KEY", () => {
    process.env["ZAI_API_KEY"] = "zai-key";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" }));

    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_ISSUE_ID"]).toBe("GH-42");
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://api.z.ai/api/anthropic");
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("zai-key");
  });

  it("supports custom token env variable via agentConfig.zaiApiKeyEnv", () => {
    process.env["ZAI_ALT_TOKEN"] = "alt-key";
    const agent = create();
    const env = agent.getEnvironment(
      makeLaunchConfig({
        projectConfig: {
          name: "my-project",
          repo: "owner/repo",
          path: "/workspace/repo",
          defaultBranch: "main",
          sessionPrefix: "my",
          agentConfig: { zaiApiKeyEnv: "ZAI_ALT_TOKEN" },
        },
      }),
    );

    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("alt-key");
  });

  it("supports base URL override via agentConfig.zaiBaseUrl", () => {
    process.env["ZAI_API_KEY"] = "zai-key";
    const agent = create();
    const env = agent.getEnvironment(
      makeLaunchConfig({
        projectConfig: {
          name: "my-project",
          repo: "owner/repo",
          path: "/workspace/repo",
          defaultBranch: "main",
          sessionPrefix: "my",
          agentConfig: { zaiBaseUrl: "https://custom.example.com/anthropic" },
        },
      }),
    );

    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://custom.example.com/anthropic");
  });

  it("falls back to ANTHROPIC_AUTH_TOKEN when ZAI_API_KEY is absent", () => {
    process.env["ANTHROPIC_AUTH_TOKEN"] = "anthropic-token";
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig());

    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("anthropic-token");
  });

  it("throws when no token source is configured", () => {
    const agent = create();
    expect(() => agent.getEnvironment(makeLaunchConfig())).toThrow(
      "Missing z.ai auth token. Set ZAI_API_KEY (recommended) or ANTHROPIC_AUTH_TOKEN in your environment.",
    );
  });
});
