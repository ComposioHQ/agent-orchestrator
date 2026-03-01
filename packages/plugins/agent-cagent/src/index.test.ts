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

function mockTmuxWithProcess(processName = "cagent", tty = "/dev/ttys001", pid = 12345) {
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
      name: "cagent",
      slot: "agent",
      description: "Agent plugin: Docker cagent framework",
      version: "0.1.0",
    });
  });

  it("create() returns an agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("cagent");
    expect(agent.processName).toBe("cagent");
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

  it("generates base command 'cagent run' with no extra flags", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("cagent run");
  });

  it("includes --non-interactive when permissions=skip", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "skip" }));
    expect(cmd).toContain("--non-interactive");
  });

  it("does not include --non-interactive when permissions is not skip", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--non-interactive");
  });

  it("shell-escapes model argument", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4o" }));
    expect(cmd).toContain("--model 'gpt-4o'");
  });

  it("shell-escapes prompt argument", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).toContain("--prompt 'Fix the bug'");
  });

  it("escapes dangerous characters in prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "$(rm -rf /); `evil`; $HOME" }));
    expect(cmd).toContain("--prompt '$(rm -rf /); `evil`; $HOME'");
  });

  it("escapes single quotes in prompt using POSIX method", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's a test" }));
    expect(cmd).toContain("--prompt 'it'\\''s a test'");
  });

  it("includes --system-prompt with systemPrompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPrompt: "Be helpful" }));
    expect(cmd).toContain("--system-prompt 'Be helpful'");
  });

  it("includes --system-prompt-file with systemPromptFile", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPromptFile: "/tmp/prompt.txt" }));
    expect(cmd).toContain("--system-prompt-file '/tmp/prompt.txt'");
  });

  it("prefers systemPromptFile over systemPrompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPrompt: "Be helpful",
        systemPromptFile: "/tmp/prompt.txt",
      }),
    );
    expect(cmd).toContain("--system-prompt-file");
    expect(cmd).not.toContain("--system-prompt 'Be helpful'");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip", model: "opus", prompt: "Hello" }),
    );
    expect(cmd).toBe("cagent run --model 'opus' --non-interactive --prompt 'Hello'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--non-interactive");
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--prompt");
    expect(cmd).not.toContain("--system-prompt");
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

  it("returns idle when (cagent) prompt is visible", () => {
    expect(agent.detectActivity("some output\n(cagent)")).toBe("idle");
  });

  it("returns idle when (Cagent) prompt is visible (case-insensitive)", () => {
    expect(agent.detectActivity("some output\n(Cagent)")).toBe("idle");
  });

  it("returns waiting_input for confirmation prompts", () => {
    expect(agent.detectActivity("Do you want to proceed?\nConfirm changes?")).toBe(
      "waiting_input",
    );
  });

  it("returns waiting_input for [y/n] prompts", () => {
    expect(agent.detectActivity("Apply changes? [y/n]")).toBe("waiting_input");
  });

  it("returns waiting_input for approve prompts", () => {
    expect(agent.detectActivity("line1\nline2\nPlease approve this action")).toBe("waiting_input");
  });

  it("returns blocked for error output", () => {
    expect(agent.detectActivity("error: something went wrong")).toBe("blocked");
  });

  it("returns blocked for failed output", () => {
    expect(agent.detectActivity("Operation failed")).toBe("blocked");
  });

  it("returns blocked for fatal output", () => {
    expect(agent.detectActivity("fatal: cannot proceed")).toBe("blocked");
  });

  it("returns ready for completed output", () => {
    expect(agent.detectActivity("Task completed")).toBe("ready");
  });

  it("returns ready for finished output", () => {
    expect(agent.detectActivity("Process finished")).toBe("ready");
  });

  it("returns ready for done output", () => {
    expect(agent.detectActivity("All tasks done")).toBe("ready");
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

  it("returns true when cagent is found on tmux pane TTY", async () => {
    mockTmuxWithProcess("cagent");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when no cagent process on tmux pane TTY", async () => {
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

  it("finds cagent on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  cagent run --prompt test\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("does not match similar process names like cagent-extra", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  /usr/bin/cagent-extra\n",
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

  it("returns null (cagent has no JSONL introspection yet)", async () => {
    const result = await agent.getSessionInfo(makeSession());
    expect(result).toBeNull();
  });
});

// =========================================================================
// getActivityState
// =========================================================================
describe("getActivityState", () => {
  const agent = create();

  it("returns exited when session has no runtimeHandle", async () => {
    const result = await agent.getActivityState(makeSession({ runtimeHandle: null }));
    expect(result).toEqual({ state: "exited" });
  });

  it("returns exited when process is not running", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(result).toEqual({ state: "exited" });
  });

  it("returns null when process is running (terminal-based detection)", async () => {
    mockTmuxWithProcess("cagent");
    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(result).toBeNull();
  });
});
