import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
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
// Helpers
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
    workspacePath: "/workspace/test",
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

function makeProcessHandle(pid?: number | string): RuntimeHandle {
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

function mockTmuxWithProcess(processName: string, found = true) {
  mockExecFileAsync.mockImplementation((cmd: string) => {
    if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
    if (cmd === "ps") {
      const line = found ? `  789 ttys003  ${processName}` : "  789 ttys003  bash";
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n${line}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error("unexpected"));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// =========================================================================
// Manifest & Exports
// =========================================================================
describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "opencode",
      slot: "agent",
      description: "Agent plugin: OpenCode",
      version: "0.1.0",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("opencode");
    expect(agent.processName).toBe("opencode");
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

  it("generates base command without prompt", () => {
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("opencode");
  });

  it("uses run subcommand with shell-escaped prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix it" }));
    expect(cmd).toContain("run 'Fix it'");
  });

  it("includes --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "claude-sonnet-4-5-20250929" }));
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929'");
  });

  it("combines prompt and model", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Go", model: "gpt-4o" }));
    expect(cmd).toBe("opencode run 'Go' --model 'gpt-4o'");
  });

  it("escapes single quotes in prompt (POSIX shell escaping)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's broken" }));
    expect(cmd).toContain("run 'it'\\''s broken'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("run");
  });
});

// =========================================================================
// getEnvironment
// =========================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID but not AO_PROJECT_ID (caller's responsibility)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_PROJECT_ID"]).toBeUndefined();
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("GH-42");
  });

  it("omits AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when opencode found on tmux pane TTY", async () => {
    mockTmuxWithProcess("opencode");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when opencode not on tmux pane TTY", async () => {
    mockTmuxWithProcess("opencode", false);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process handle with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("returns false for process handle with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns false for unknown runtime without PID", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
  });

  it("returns false on tmux command failure", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux not running"));
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

  it("finds opencode on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  opencode run hello\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });
});

// =========================================================================
// detectActivity — terminal output classification
// =========================================================================
describe("detectActivity", () => {
  const agent = create();

  // -- Idle states --
  it("returns idle for empty terminal output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns idle for whitespace-only terminal output", () => {
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("returns idle when last line is a bare > prompt", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
  });

  it("returns idle when last line is a bare $ prompt", () => {
    expect(agent.detectActivity("some output\n$ ")).toBe("idle");
  });

  it("returns idle when last line is a bare # prompt", () => {
    expect(agent.detectActivity("some output\n# ")).toBe("idle");
  });

  it("returns idle for ❯ prompt character", () => {
    expect(agent.detectActivity("some output\n❯ ")).toBe("idle");
  });

  it("returns idle when prompt follows historical activity", () => {
    expect(agent.detectActivity("Processing...\nFinished.\n> ")).toBe("idle");
  });

  it("returns idle for Done on last line", () => {
    expect(agent.detectActivity("Processing...\nDone\n")).toBe("idle");
  });

  it("returns idle for Done. on last line", () => {
    expect(agent.detectActivity("Finished writing.\nDone.\n")).toBe("idle");
  });

  it("returns idle for task completed on last line", () => {
    expect(agent.detectActivity("All files updated.\ntask completed\n")).toBe("idle");
  });

  it("returns idle for session ended on last line", () => {
    expect(agent.detectActivity("Goodbye.\nsession ended\n")).toBe("idle");
  });

  it("returns idle for exiting on last line", () => {
    expect(agent.detectActivity("Cleanup done.\nexiting\n")).toBe("idle");
  });

  // -- Waiting input states --
  it("returns waiting_input for (y)es / (n)o prompt", () => {
    expect(agent.detectActivity("Proceed?\n(y)es / (n)o\n")).toBe("waiting_input");
  });

  it("returns waiting_input for (Y/n) prompt", () => {
    expect(agent.detectActivity("Create file? (Y/n)\n")).toBe("waiting_input");
  });

  it("returns waiting_input for (y/n) prompt", () => {
    expect(agent.detectActivity("Overwrite? (y/n)\n")).toBe("waiting_input");
  });

  it("returns waiting_input for approve? prompt", () => {
    expect(agent.detectActivity("Execute command:\nApprove?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for allow tool prompt", () => {
    expect(agent.detectActivity("Allow tool bash to run?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for confirm? prompt", () => {
    expect(agent.detectActivity("Delete 3 files.\nConfirm?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for do you want to proceed? prompt", () => {
    expect(agent.detectActivity("This will modify 5 files.\nDo you want to proceed?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for press enter to confirm", () => {
    expect(agent.detectActivity("Changes staged.\nPress enter to confirm\n")).toBe("waiting_input");
  });

  it("returns waiting_input for accept changes? prompt", () => {
    expect(agent.detectActivity("Diff preview:\nAccept changes?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for apply changes? prompt", () => {
    expect(agent.detectActivity("Ready to write.\nApply changes?\n")).toBe("waiting_input");
  });

  it("returns waiting_input when prompt follows historical activity", () => {
    expect(agent.detectActivity("Working...\nDone.\nApprove?\n")).toBe("waiting_input");
  });

  // -- Blocked states --
  it("returns blocked for rate limit errors", () => {
    expect(agent.detectActivity("Error: rate limit exceeded\n")).toBe("blocked");
  });

  it("returns blocked for authentication errors", () => {
    expect(agent.detectActivity("Error: authentication failed\n")).toBe("blocked");
  });

  it("returns blocked for invalid API key", () => {
    expect(agent.detectActivity("API key is invalid\n")).toBe("blocked");
  });

  it("returns blocked for token limit exceeded", () => {
    expect(agent.detectActivity("Token limit exceeded\n")).toBe("blocked");
  });

  it("returns blocked for context window exceeded", () => {
    expect(agent.detectActivity("Context window limit exceeded\n")).toBe("blocked");
  });

  it("returns blocked for connection refused", () => {
    expect(agent.detectActivity("Connection refused\n")).toBe("blocked");
  });

  it("returns blocked for quota exceeded", () => {
    expect(agent.detectActivity("Quota exceeded\n")).toBe("blocked");
  });

  it("returns blocked for 429 Too Many Requests", () => {
    expect(agent.detectActivity("HTTP 429 Too Many Requests\n")).toBe("blocked");
  });

  it("returns blocked for retrying message", () => {
    expect(agent.detectActivity("Retrying in 30 seconds\n")).toBe("blocked");
  });

  it("returns blocked for model not found", () => {
    expect(agent.detectActivity("Model gpt-5 not found\n")).toBe("blocked");
  });

  it("returns blocked for unauthorized", () => {
    expect(agent.detectActivity("401 Unauthorized\n")).toBe("blocked");
  });

  it("returns blocked for ECONNREFUSED", () => {
    expect(agent.detectActivity("FetchError: ECONNREFUSED\n")).toBe("blocked");
  });

  // -- Active states --
  it("returns active for non-empty terminal output with no special patterns", () => {
    expect(agent.detectActivity("opencode is working\n")).toBe("active");
  });

  it("returns active for processing output", () => {
    expect(agent.detectActivity("Reading files...\n")).toBe("active");
  });

  // -- Priority order tests --
  it("idle prompt takes priority over blocked text higher in buffer", () => {
    expect(agent.detectActivity("rate limit hit\nretrying...\n> ")).toBe("idle");
  });

  it("waiting_input takes priority over blocked text higher in buffer", () => {
    expect(agent.detectActivity("Connection refused\nRetried.\nApprove?\n")).toBe("waiting_input");
  });

  it("blocked takes priority over completion text", () => {
    expect(agent.detectActivity("Done\nrate limit exceeded\n")).toBe("blocked");
  });
});

// =========================================================================
// getSessionInfo
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("always returns null (not implemented)", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
    expect(await agent.getSessionInfo(makeSession({ workspacePath: "/some/path" }))).toBeNull();
  });
});
