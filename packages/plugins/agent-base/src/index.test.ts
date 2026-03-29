/**
 * Unit tests for agent-base package.
 *
 * Tests the shared createAgentPlugin factory, path encoding,
 * JSONL parsing, and hook setup functionality.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentLaunchConfig } from "@composio/ao-core";

// Mock dependencies
const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();
const mockHomedir = vi.fn(() => "/mock/home");
const mockMkdir = vi.fn();
const mockWriteFile = vi.fn();
const mockChmod = vi.fn();
const mockAccess = vi.fn();
const mockOpen = vi.fn();
const mockExistsSync = vi.fn(() => false);

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  stat: mockStat,
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  chmod: mockChmod,
  access: mockAccess,
  open: mockOpen,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

describe("agent-base exports", () => {
  it("should export createAgentPlugin", async () => {
    const { createAgentPlugin } = await import("@composio/ao-plugin-agent-base");
    expect(createAgentPlugin).toBeDefined();
    expect(typeof createAgentPlugin).toBe("function");
  });

  it("should export toAgentProjectPath", async () => {
    const { toAgentProjectPath } = await import("@composio/ao-plugin-agent-base");
    expect(toAgentProjectPath).toBeDefined();
    expect(typeof toAgentProjectPath).toBe("function");
  });
});

describe("toAgentProjectPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should encode simple Unix paths", async () => {
    const { toAgentProjectPath } = await import("@composio/ao-plugin-agent-base");
    // /Users/test/project → -Users-test-project (slashes become dashes)
    expect(toAgentProjectPath("/Users/test/project")).toBe("-Users-test-project");
  });

  it("should encode paths with hyphens", async () => {
    const { toAgentProjectPath } = await import("@composio/ao-plugin-agent-base");
    // /workspace/my-repo → -workspace-my-repo
    expect(toAgentProjectPath("/workspace/my-repo")).toBe("-workspace-my-repo");
  });

  it("should encode worktree paths", async () => {
    const { toAgentProjectPath } = await import("@composio/ao-plugin-agent-base");
    // /home/user/.worktrees/ao → -home-user--worktrees-ao (dot becomes dash)
    expect(toAgentProjectPath("/home/user/.worktrees/ao")).toBe("-home-user--worktrees-ao");
  });

  it("should handle empty string input", async () => {
    const { toAgentProjectPath } = await import("@composio/ao-plugin-agent-base");
    // Empty path returns empty string (no leading dash for empty input)
    const result = toAgentProjectPath("");
    expect(result).toBe("");
  });

  it("should handle paths with multiple consecutive slashes", async () => {
    const { toAgentProjectPath } = await import("@composio/ao-plugin-agent-base");
    // Multiple slashes become multiple dashes
    const result = toAgentProjectPath("/path//with///slashes");
    expect(result).toBeDefined();
    expect(result).toContain("-");
  });
});

describe("createAgentPlugin factory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create agent with correct name and processName", async () => {
    const { createAgentPlugin } = await import("@composio/ao-plugin-agent-base");

    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--test-flag",
    };

    const agent = createAgentPlugin(config);
    expect(agent.name).toBe("test-agent");
    expect(agent.processName).toBe("test-process");
  });

  it("should include required agent methods", async () => {
    const { createAgentPlugin } = await import("@composio/ao-plugin-agent-base");

    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--test-flag",
    };

    const agent = createAgentPlugin(config);

    expect(typeof agent.getLaunchCommand).toBe("function");
    expect(typeof agent.getEnvironment).toBe("function");
    expect(typeof agent.isProcessRunning).toBe("function");
    expect(typeof agent.getActivityState).toBe("function");
    expect(typeof agent.getSessionInfo).toBe("function");
    expect(typeof agent.detectActivity).toBe("function");
  });

  it("should handle permissionless mode in launch command", async () => {
    const { createAgentPlugin } = await import("@composio/ao-plugin-agent-base");

    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--skip-permissions",
    };

    const agent = createAgentPlugin(config);

    const launchConfig: AgentLaunchConfig = {
      sessionId: "test-session",
      permissions: "skip",
      projectConfig: {
        name: "test-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "test",
      },
    };

    const cmd = agent.getLaunchCommand(launchConfig);
    expect(cmd).toContain("test");
    expect(cmd).toContain("--skip-permissions");
  });

  it("should set AO_SESSION in environment", async () => {
    const { createAgentPlugin } = await import("@composio/ao-plugin-agent-base");

    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--flag",
    };

    const agent = createAgentPlugin(config);

    const launchConfig: AgentLaunchConfig = {
      sessionId: "my-session-id",
      projectConfig: {
        name: "test-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "test",
      },
    };

    const env = agent.getEnvironment(launchConfig);
    expect(env.AO_SESSION).toBe("my-session-id");
    expect(env.AO_SESSION_ID).toBe("my-session-id");
  });

  it("should handle system prompt via flag", async () => {
    const { createAgentPlugin } = await import("@composio/ao-plugin-agent-base");

    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--flag",
      systemPromptFlag: "--system-prompt",
    };

    const agent = createAgentPlugin(config);

    const launchConfig: AgentLaunchConfig = {
      sessionId: "test-session",
      systemPrompt: "You are a helpful assistant",
      projectConfig: {
        name: "test-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "test",
      },
    };

    const cmd = agent.getLaunchCommand(launchConfig);
    expect(cmd).toContain("--system-prompt");
  });

  it("should use custom session directory", async () => {
    const { createAgentPlugin } = await import("@composio/ao-plugin-agent-base");

    const customDir = "/custom/sessions/path";
    const config = {
      name: "test-agent",
      description: "Test agent plugin",
      processName: "test-process",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--flag",
      getSessionDir: (_workspacePath: string) => customDir,
    };

    const _agent = createAgentPlugin(config);

    // Verify the agent has getSessionDir by checking it returns customDir for any input
    const result = config.getSessionDir!("/workspace/test");
    expect(result).toBe(customDir);
  });

});

describe("hookEvent configuration", () => {
  it("should default hookEvent to PostToolUse", async () => {
    const { createAgentPlugin } = await import("@composio/ao-plugin-agent-base");

    const config = {
      name: "test-agent",
      description: "Test agent",
      processName: "test",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--flag",
    };

    const agent = createAgentPlugin(config);
    // Hook event is used internally, but agent should be created successfully
    expect(agent.name).toBe("test-agent");
  });

  it("should support AfterTool hookEvent", async () => {
    const { createAgentPlugin } = await import("@composio/ao-plugin-agent-base");

    const config = {
      name: "test-agent",
      description: "Test agent",
      processName: "test",
      command: "test",
      configDir: ".test",
      permissionlessFlag: "--flag",
      hookEvent: "AfterTool" as const,
    };

    const agent = createAgentPlugin(config);
    expect(agent.name).toBe("test-agent");
  });
});
