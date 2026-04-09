import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// Mock fs/promises for getSessionInfo tests
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    access: vi.fn().mockRejectedValue(new Error("ENOENT")),
    stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  };
});

// Mock activity log utilities from core
const { mockAppendActivityEntry, mockReadLastActivityEntry, mockRecordTerminalActivity } =
  vi.hoisted(() => ({
    mockAppendActivityEntry: vi.fn().mockResolvedValue(undefined),
    mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
    mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("@composio/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    appendActivityEntry: mockAppendActivityEntry,
    readLastActivityEntry: mockReadLastActivityEntry,
    recordTerminalActivity: mockRecordTerminalActivity,
  };
});

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

function mockTmuxWithProcess(processName: string, found = true) {
  mockExecFileAsync.mockImplementation((cmd: string) => {
    if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys005\n", stderr: "" });
    if (cmd === "ps") {
      const line = found ? `  444 ttys005  ${processName}` : "  444 ttys005  zsh";
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
      name: "cursor",
      slot: "agent",
      description: "Agent plugin: Cursor Agent CLI",
      version: "0.1.0",
      displayName: "Cursor",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("cursor");
    expect(agent.processName).toBe("agent");
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

  it("generates base command", () => {
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("agent");
  });

  it("includes --force --sandbox disabled --approve-mcps when permissions=permissionless", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--force");
    expect(cmd).toContain("--sandbox disabled");
    expect(cmd).toContain("--approve-mcps");
  });

  it("treats legacy permissions=skip as permissionless", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip" as unknown as AgentLaunchConfig["permissions"] }),
    );
    expect(cmd).toContain("--force");
  });

  it("maps permissions=auto-edit to force mode on Cursor", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "auto-edit" }));
    expect(cmd).toContain("--force");
  });

  it("includes --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4o" }));
    expect(cmd).toContain("--model 'gpt-4o'");
  });

  it("includes prompt as positional argument (not --prompt flag)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the tests" }));
    expect(cmd).toContain("'Fix the tests'");
    expect(cmd).not.toContain("--prompt");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "permissionless", model: "sonnet", prompt: "Go" }),
    );
    expect(cmd).toBe("agent --force --sandbox disabled --approve-mcps --model 'sonnet' -- 'Go'");
  });

  it("escapes single quotes in prompt (POSIX shell escaping)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's broken" }));
    expect(cmd).toContain("'it'\\''s broken'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--force");
    expect(cmd).not.toContain("--model");
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
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "LIN-99" }));
    expect(env["AO_ISSUE_ID"]).toBe("LIN-99");
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

  it("returns true when agent found on tmux pane TTY", async () => {
    mockTmuxWithProcess("agent");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns true when /path/to/agent found on tmux pane TTY", async () => {
    mockTmuxWithProcess("/usr/local/bin/agent");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when agent not on tmux pane TTY", async () => {
    mockTmuxWithProcess("agent", false);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process handle with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(456))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(456, 0);
    killSpy.mockRestore();
  });

  it("returns false for process handle with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(456))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns false for unknown runtime without PID", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
  });

  it("returns false on tmux command failure", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux gone"));
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

  it("finds agent on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  agent --force\n",
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

  it("returns idle for empty terminal output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns idle for whitespace-only terminal output", () => {
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("returns idle when prompt char visible", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
    expect(agent.detectActivity("some output\n$ ")).toBe("idle");
  });

  it("returns idle for agent-specific prompts", () => {
    expect(agent.detectActivity("Processing...\nagent> ")).toBe("idle");
    expect(agent.detectActivity("Ready.\n[agent] ")).toBe("idle");
  });

  it("returns waiting_input for Y/N confirmation", () => {
    expect(agent.detectActivity("Approve these changes?\n(Y)es/(N)o")).toBe("waiting_input");
  });

  it("returns waiting_input for continue prompt", () => {
    expect(agent.detectActivity("Ready to proceed. Continue?")).toBe("waiting_input");
  });

  it("returns waiting_input for press enter prompt", () => {
    expect(agent.detectActivity("Press Enter to continue")).toBe("waiting_input");
  });

  it("returns active for non-empty terminal output", () => {
    expect(agent.detectActivity("agent is processing files\n")).toBe("active");
  });
});

// =========================================================================
// getSessionInfo
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("returns null when workspacePath is null", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("returns null when no cursor session file exists", async () => {
    const { readFile } = await import("node:fs/promises");
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT"));
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("extracts summary from cursor chat file", async () => {
    const { access, readFile } = await import("node:fs/promises");
    vi.mocked(access).mockResolvedValueOnce(undefined);
    vi.mocked(readFile).mockResolvedValueOnce("# Cursor Session\n\nFix the login bug in auth.ts\n");
    const info = await agent.getSessionInfo(makeSession());
    expect(info).not.toBeNull();
    expect(info!.summary).toBe("Fix the login bug in auth.ts");
    expect(info!.summaryIsFallback).toBe(true);
    expect(info!.agentSessionId).toBeNull();
    expect(info!.cost).toBeUndefined();
  });

  it("truncates long summaries to 120 chars", async () => {
    const { access, readFile } = await import("node:fs/promises");
    const longMsg = "A".repeat(200);
    vi.mocked(access).mockResolvedValueOnce(undefined);
    vi.mocked(readFile).mockResolvedValueOnce(longMsg);
    const info = await agent.getSessionInfo(makeSession());
    expect(info!.summary).toHaveLength(123); // 120 + "..."
    expect(info!.summary!.endsWith("...")).toBe(true);
  });
});

// =========================================================================
// getRestoreCommand
// =========================================================================
describe("getRestoreCommand", () => {
  const agent = create();

  it("returns null (cursor does not support session resume)", async () => {
    const result = await agent.getRestoreCommand!(
      makeSession(),
      { name: "proj", repo: "o/r", path: "/p", defaultBranch: "main", sessionPrefix: "p" },
    );
    expect(result).toBeNull();
  });
});

// =========================================================================
// setupWorkspaceHooks
// =========================================================================
describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("is defined (delegates to shared setupPathWrapperWorkspace)", () => {
    expect(agent.setupWorkspaceHooks).toBeDefined();
    expect(typeof agent.setupWorkspaceHooks).toBe("function");
  });
});

// =========================================================================
// postLaunchSetup
// =========================================================================
describe("postLaunchSetup", () => {
  const agent = create();

  it("is defined", () => {
    expect(agent.postLaunchSetup).toBeDefined();
    expect(typeof agent.postLaunchSetup).toBe("function");
  });

  it("does nothing when workspacePath is null", async () => {
    // Should not throw
    await agent.postLaunchSetup!(makeSession({ workspacePath: null }));
  });
});

// =========================================================================
// getEnvironment — PATH wrapping
// =========================================================================
describe("getEnvironment PATH", () => {
  const agent = create();

  it("prepends ~/.ao/bin to PATH", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]).toMatch(/\.ao\/bin/);
  });

  it("sets GH_PATH", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["GH_PATH"]).toBe("/usr/local/bin/gh");
  });
});

// =========================================================================
// recordActivity
// =========================================================================
describe("recordActivity", () => {
  const agent = create();

  it("is defined", () => {
    expect(agent.recordActivity).toBeDefined();
  });

  it("does nothing when workspacePath is null", async () => {
    await agent.recordActivity!(makeSession({ workspacePath: null }), "some output");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });

  it("delegates to recordTerminalActivity", async () => {
    await agent.recordActivity!(makeSession(), "agent is processing files");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "agent is processing files",
      expect.any(Function),
    );
  });
});

// =========================================================================
// getActivityState — reads from activity JSONL
// =========================================================================
describe("getActivityState with activity JSONL", () => {
  const agent = create();

  it("returns exited when process is not running", async () => {
    mockTmuxWithProcess("agent", false);
    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result?.state).toBe("exited");
  });

  it("returns waiting_input from activity JSONL", async () => {
    mockTmuxWithProcess("agent");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result?.state).toBe("waiting_input");
  });

  it("returns blocked from activity JSONL", async () => {
    mockTmuxWithProcess("agent");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "blocked", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result?.state).toBe("blocked");
  });

  it("returns active from JSONL entry fallback when native signal fails (fresh entry)", async () => {
    mockTmuxWithProcess("agent");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "active", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result?.state).toBe("active");
  });

  it("returns idle from JSONL entry fallback when native signal fails (old entry with age decay)", async () => {
    mockTmuxWithProcess("agent");
    const oldDate = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: oldDate.toISOString(), state: "active", source: "terminal" },
      modifiedAt: oldDate,
    });

    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result?.state).toBe("idle");
  });

  it("returns null when both native signal and JSONL are unavailable", async () => {
    mockTmuxWithProcess("agent");
    mockReadLastActivityEntry.mockResolvedValueOnce(null);

    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result).toBeNull();
  });
});
