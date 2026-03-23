import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLaunchConfig, RuntimeHandle, Session } from "@composio/ao-core";

const { mockExecFileAsync, mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const execFile = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return {
    execFile,
    execFileSync: mockExecFileSync,
  };
});

import { create, default as defaultExport, detect, manifest } from "./index.js";

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
      agentConfig: {
        acpxAgent: "pi",
      },
    },
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: "/workspace/repo",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeTmuxHandle(id = "app-1"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

describe("plugin manifest and exports", () => {
  it("exports the expected manifest", () => {
    expect(manifest).toEqual({
      name: "acpx",
      slot: "agent",
      description: "Agent plugin: ACPX bridge",
      version: "0.1.0",
      displayName: "ACPX",
    });
  });

  it("exports a valid plugin module", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("create()", () => {
  const agent = create();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a post-launch agent", () => {
    expect(agent.name).toBe("acpx");
    expect(agent.processName).toBe("node");
    expect(agent.promptDelivery).toBe("post-launch");
  });

  it("builds a bridge launch command with the configured acpx agent", () => {
    const command = agent.getLaunchCommand(makeLaunchConfig());
    expect(command).toContain("bridge.js");
    expect(command).toContain("--agent 'pi'");
    expect(command).not.toContain("Fix the bug");
  });

  it("forwards systemPromptFile to the bridge", () => {
    const command = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "/tmp/orchestrator-prompt.md" }),
    );
    expect(command).toContain("--system-prompt-file '/tmp/orchestrator-prompt.md'");
  });

  it("sets AO session environment values", () => {
    expect(agent.getEnvironment(makeLaunchConfig({ issueId: "INT-42" }))).toEqual({
      AO_SESSION_ID: "sess-1",
      AO_ISSUE_ID: "INT-42",
    });
  });

  it("returns null activity while the bridge process is running", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const result = await agent.getActivityState(
      makeSession({
        runtimeHandle: { id: "proc-1", runtimeName: "process", data: { pid: 123 } },
      }),
    );
    expect(result).toBeNull();
    killSpy.mockRestore();
  });

  it("returns exited when the bridge process is gone", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const result = await agent.getActivityState(
      makeSession({
        runtimeHandle: { id: "proc-1", runtimeName: "process", data: { pid: 123 } },
      }),
    );
    expect(result?.state).toBe("exited");
    killSpy.mockRestore();
  });

  it("detects the bridge inside tmux panes", async () => {
    mockExecFileAsync.mockImplementation((command: string) => {
      if (command === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (command === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  321 ttys003  /usr/bin/node /tmp/agent-acpx/dist/bridge.js --agent pi\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error(`unexpected ${command}`));
    });

    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });
});

describe("detect()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when acpx --help succeeds", () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    expect(detect()).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith("acpx", ["--help"], { stdio: "ignore" });
  });

  it("returns false when acpx is unavailable", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detect()).toBe(false);
  });
});
