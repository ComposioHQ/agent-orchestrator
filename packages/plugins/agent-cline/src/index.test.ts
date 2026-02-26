import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks — available inside vi.mock factories
// ---------------------------------------------------------------------------
const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

import { create, manifest, default as defaultExport } from "./index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/test-project",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeTmuxHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

function makeProcessHandle(pid?: number): RuntimeHandle {
  return { id: "proc-1", runtimeName: "process", data: pid !== undefined ? { pid } : {} };
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

function mockTmuxWithProcess(processName = "cline", tty = "/dev/ttys001", pid = 12345) {
  mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return Promise.resolve({ stdout: `${tty}\n`, stderr: "" });
    }
    if (cmd === "ps") {
      const ttyShort = tty.replace(/^\/dev\//, "");
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n  ${pid} ${ttyShort}  ${processName}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
});

describe("plugin manifest & exports", () => {
  it("has correct manifest metadata", () => {
    expect(manifest).toEqual({
      name: "cline",
      slot: "agent",
      description: "Agent plugin: Cline",
      version: "0.1.0",
    });
  });

  it("create() returns an agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("cline");
    expect(agent.processName).toBe("cline");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

// =========================================================================
// getLaunchCommand
// =========================================================================
describe("getLaunchCommand", () => {
  const agent = create();

  it("generates base command 'cline' with no extra flags", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("cline");
  });

  it("includes --yolo when permissions=skip", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "skip" }));
    expect(cmd).toContain("--yolo");
  });

  it("does not include --yolo when permissions is not skip", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--yolo");
  });

  it("shell-escapes model argument", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "claude-3.5-sonnet" }));
    expect(cmd).toContain("--model 'claude-3.5-sonnet'");
  });

  it("shell-escapes prompt argument (positional)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).toContain("'Fix the bug'");
  });

  it("escapes dangerous characters in prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "$(rm -rf /); `evil`; $HOME" }));
    expect(cmd).toContain("'$(rm -rf /); `evil`; $HOME'");
  });

  it("escapes single quotes in prompt using POSIX method", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's a test" }));
    expect(cmd).toContain("'it'\\''s a test'");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip", model: "opus", prompt: "Hello" }),
    );
    expect(cmd).toBe("cline --yolo --model 'opus' 'Hello'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--yolo");
    expect(cmd).not.toContain("--model");
  });
});

// =========================================================================
// getEnvironment
// =========================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID from config", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("GH-42");
  });

  it("does not set AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });
});

// =========================================================================
// detectActivity
// =========================================================================
describe("detectActivity", () => {
  const agent = create();

  it("returns idle for empty terminal output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns idle for whitespace-only terminal output", () => {
    expect(agent.detectActivity("   \n  \n  ")).toBe("idle");
  });

  it("returns idle when shell prompt > is visible", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
  });

  it("returns idle when shell prompt $ is visible", () => {
    expect(agent.detectActivity("some output\n$ ")).toBe("idle");
  });

  it("returns idle when shell prompt # is visible", () => {
    expect(agent.detectActivity("some output\n# ")).toBe("idle");
  });

  it("returns active for non-empty output with no prompt pattern", () => {
    expect(agent.detectActivity("some random terminal output\n")).toBe("active");
  });

  it("returns active when processing is happening", () => {
    expect(agent.detectActivity("Generating response...\n")).toBe("active");
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when cline is found on tmux pane TTY", async () => {
    mockTmuxWithProcess("cline");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when no cline process on tmux pane TTY", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys002\n", stderr: "" });
      if (cmd === "ps")
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  999 ttys002  bash\n",
          stderr: "",
        });
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false when tmux list-panes returns empty", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process runtime with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(999))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(999, 0);
    killSpy.mockRestore();
  });

  it("returns false for process runtime with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(999))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns false for unknown runtime without PID", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("returns false when tmux command fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("fail"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true when PID exists but throws EPERM", async () => {
    const epermErr = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
    killSpy.mockRestore();
  });

  it("finds cline on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  cline fix test\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("does not match similar process names like cline-extra", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  /usr/bin/cline-extra\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });
});

// =========================================================================
// getSessionInfo
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("returns null (Cline has no JSONL introspection yet)", async () => {
    const result = await agent.getSessionInfo(makeSession());
    expect(result).toBeNull();
  });
});

// =========================================================================
// getActivityState
// =========================================================================
describe("getActivityState", () => {
  const agent = create();

  it("returns null (Cline has no session introspection yet)", async () => {
    const result = await agent.getActivityState(makeSession());
    expect(result).toBeNull();
  });
});
