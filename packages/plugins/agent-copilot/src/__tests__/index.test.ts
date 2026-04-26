import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createActivitySignal,
  type Session,
  type RuntimeHandle,
  type AgentLaunchConfig,
} from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks — available inside vi.mock factories
// ---------------------------------------------------------------------------
const {
  mockExecFileAsync,
  mockReadFile,
  mockReaddir,
  mockStat,
  mockHomedir,
  mockReadLastJsonlEntry,
  mockReadLastActivityEntry,
  mockCheckActivityLogState,
  mockGetActivityFallbackState,
  mockRecordTerminalActivity,
} = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockReadFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockStat: vi.fn(),
  mockHomedir: vi.fn(() => "/mock/home"),
  mockReadLastJsonlEntry: vi.fn(),
  mockReadLastActivityEntry: vi.fn(),
  mockCheckActivityLogState: vi.fn(),
  mockGetActivityFallbackState: vi.fn(),
  mockRecordTerminalActivity: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn, execFileSync: vi.fn() };
});

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
  readdir: mockReaddir,
  stat: mockStat,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readLastJsonlEntry: mockReadLastJsonlEntry,
    readLastActivityEntry: mockReadLastActivityEntry,
    checkActivityLogState: mockCheckActivityLogState,
    getActivityFallbackState: mockGetActivityFallbackState,
    recordTerminalActivity: mockRecordTerminalActivity,
  };
});

import {
  create,
  manifest,
  default as defaultExport,
  _resetSessionDirCache,
  resetPsCache,
} from "../index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    activitySignal: createActivitySignal("valid", {
      activity: "active",
      timestamp: new Date(),
      source: "native",
    }),
    lifecycle: {
      state: "working",
      sessionStatus: "working",
      stuckReason: null,
      pr: null,
      ci: null,
      review: null,
    },
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
  mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
    }
    if (cmd === "ps") {
      const line = found ? `  789 ttys003  ${processName}` : "  789 ttys003  bash";
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n${line}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
  });
}

/** Build a workspace.yaml string from key-value pairs */
function makeWorkspaceYaml(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetSessionDirCache();
  resetPsCache();
  mockHomedir.mockReturnValue("/mock/home");
  // Default: no session directories found
  mockReaddir.mockRejectedValue(new Error("ENOENT"));
  // Default: no activity log
  mockReadLastActivityEntry.mockResolvedValue(null);
  mockCheckActivityLogState.mockReturnValue(null);
  mockGetActivityFallbackState.mockReturnValue(null);
  mockRecordTerminalActivity.mockResolvedValue(undefined);
});

// =========================================================================
// Manifest & Exports
// =========================================================================
describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "copilot",
      slot: "agent",
      description: "Agent plugin: GitHub Copilot CLI",
      version: "0.1.0",
      displayName: "GitHub Copilot",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("copilot");
    expect(agent.processName).toBe("copilot");
  });

  it("create() returns agent with promptDelivery=inline", () => {
    const agent = create();
    expect(agent.promptDelivery).toBe("inline");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
    expect(typeof defaultExport.detect).toBe("function");
  });
});

// =========================================================================
// getLaunchCommand
// =========================================================================
describe("getLaunchCommand", () => {
  const agent = create();

  it("generates base command with --no-auto-update", () => {
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("copilot --no-auto-update");
  });

  it("includes --allow-all --no-ask-user when permissions=permissionless", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--allow-all");
    expect(cmd).toContain("--no-ask-user");
  });

  it("includes --allow-tool flags when permissions=auto-edit", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "auto-edit" }));
    expect(cmd).toContain("--allow-tool=write");
    expect(cmd).toContain("--allow-tool='shell(git:*)'");
  });

  it("includes --mode plan when permissions=suggest", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "suggest" }));
    expect(cmd).toContain("--mode plan");
  });

  it("omits permission flags when permissions=default", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "default" }));
    expect(cmd).not.toContain("--allow-all");
    expect(cmd).not.toContain("--no-ask-user");
    expect(cmd).not.toContain("--allow-tool");
    expect(cmd).not.toContain("--mode");
  });

  it("includes --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-5.3-codex" }));
    expect(cmd).toContain("--model 'gpt-5.3-codex'");
  });

  it("includes -i with shell-escaped prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).toContain("-i 'Fix the bug'");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "permissionless", model: "gpt-5.3-codex", prompt: "Go" }),
    );
    expect(cmd).toBe(
      "copilot --allow-all --no-ask-user --model 'gpt-5.3-codex' --no-auto-update -i 'Go'",
    );
  });

  it("escapes single quotes in prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's broken" }));
    expect(cmd).toContain("-i 'it'\\''s broken'");
  });

  it("escapes dangerous characters in prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "$(rm -rf /); `evil`; $HOME" }));
    expect(cmd).toContain("-i '$(rm -rf /); `evil`; $HOME'");
  });

  it("always includes --no-auto-update", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-5.4", prompt: "Fix it" }));
    expect(cmd).toContain("--no-auto-update");
  });
});

// =========================================================================
// getEnvironment
// =========================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("GH-42");
  });

  it("omits AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });

  it("sets COPILOT_AUTO_UPDATE=false", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["COPILOT_AUTO_UPDATE"]).toBe("false");
  });

  it("does not set PATH (injected by session-manager)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]).toBeUndefined();
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when copilot found on tmux pane TTY", async () => {
    mockTmuxWithProcess("copilot");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when copilot not on tmux pane TTY", async () => {
    mockTmuxWithProcess("copilot", false);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false when tmux list-panes returns empty", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
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
    expect(mockExecFileAsync).not.toHaveBeenCalled();
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

  it("finds copilot on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  copilot -i 'test'\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("does not match similar process names like copilot-something", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  /usr/bin/copilot-helper\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("handles string PID by converting to number", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle("456"))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(456, 0);
    killSpy.mockRestore();
  });

  it("returns false for non-numeric PID", async () => {
    expect(await agent.isProcessRunning(makeProcessHandle("not-a-pid"))).toBe(false);
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

  // -- Waiting input states --
  it("returns waiting_input for 'Do you want to allow this?'", () => {
    expect(
      agent.detectActivity("some output\nDo you want to allow this?\n  1. Yes\n"),
    ).toBe("waiting_input");
  });

  it("returns waiting_input for 'Do you trust the files in this folder?'", () => {
    expect(
      agent.detectActivity("output\nDo you trust the files in this folder?\n"),
    ).toBe("waiting_input");
  });

  it("returns waiting_input for TUI navigation prompt", () => {
    // \u2191\u2193 = ↑↓
    expect(agent.detectActivity("output\n\u2191\u2193 to navigate\n")).toBe("waiting_input");
  });

  // -- Active states --
  it("returns active for non-empty terminal output with no special patterns", () => {
    expect(agent.detectActivity("copilot is running some task\n")).toBe("active");
  });

  it("returns active for multi-line output with activity", () => {
    expect(agent.detectActivity("Starting\nProcessing files...\nstill going\n")).toBe("active");
  });
});

// =========================================================================
// getActivityState
// =========================================================================
describe("getActivityState", () => {
  const agent = create();

  // Helper to set up session dir discovery
  function setupSessionDir(workspacePath = "/workspace/test", sessionId = "sess-uuid-123") {
    mockReaddir.mockResolvedValue([sessionId]);
    mockReadFile.mockResolvedValue(
      makeWorkspaceYaml({ id: sessionId, cwd: workspacePath, summary: "test task" }),
    );
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
  }

  it("returns exited when no runtimeHandle", async () => {
    const session = makeSession({ runtimeHandle: null });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
    expect(result?.timestamp).toBeInstanceOf(Date);
  });

  it("returns exited when process is not running", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux not running"));
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
  });

  it("returns null when process is running but no workspacePath", async () => {
    mockTmuxWithProcess("copilot");
    const session = makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: undefined });
    expect(await agent.getActivityState(session)).toBeNull();
  });

  it("returns waiting_input from AO activity JSONL", async () => {
    mockTmuxWithProcess("copilot");
    mockCheckActivityLogState.mockReturnValue({
      state: "waiting_input",
      timestamp: new Date(),
    });

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("waiting_input");
  });

  it("returns blocked from AO activity JSONL", async () => {
    mockTmuxWithProcess("copilot");
    mockCheckActivityLogState.mockReturnValue({
      state: "blocked",
      timestamp: new Date(),
    });

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("blocked");
  });

  it("returns active from native events.jsonl when entry is recent", async () => {
    mockTmuxWithProcess("copilot");
    setupSessionDir();
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "user.message",
      payloadType: null,
      modifiedAt: new Date(),
    });

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("active");
  });

  it("returns active from JSONL fallback when native signal unavailable (fresh entry)", async () => {
    mockTmuxWithProcess("copilot");
    // No session dir found → native signal unavailable
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    mockReadLastJsonlEntry.mockResolvedValue(null);
    mockGetActivityFallbackState.mockReturnValue({
      state: "active",
      timestamp: new Date(),
    });

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("active");
  });

  it("returns idle from JSONL fallback when native signal unavailable (old entry)", async () => {
    mockTmuxWithProcess("copilot");
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    mockReadLastJsonlEntry.mockResolvedValue(null);
    mockGetActivityFallbackState.mockReturnValue({
      state: "idle",
      timestamp: new Date(Date.now() - 600_000),
    });

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("idle");
  });

  it("returns null when both native signal and JSONL are unavailable", async () => {
    mockTmuxWithProcess("copilot");
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    mockReadLastJsonlEntry.mockResolvedValue(null);
    mockGetActivityFallbackState.mockReturnValue(null);

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    expect(await agent.getActivityState(session)).toBeNull();
  });

  it("returns ready for assistant.turn_end event type", async () => {
    mockTmuxWithProcess("copilot");
    setupSessionDir();
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "assistant.turn_end",
      payloadType: null,
      modifiedAt: new Date(),
    });

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("ready");
  });

  it("returns ready for assistant.message event type", async () => {
    mockTmuxWithProcess("copilot");
    setupSessionDir();
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "assistant.message",
      payloadType: null,
      modifiedAt: new Date(),
    });

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("ready");
  });

  it("returns idle for stale ready event", async () => {
    mockTmuxWithProcess("copilot");
    setupSessionDir();
    const staleTime = new Date(Date.now() - 600_000);
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "assistant.turn_end",
      payloadType: null,
      modifiedAt: staleTime,
    });

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("idle");
  });

  it("returns exited for session.shutdown event type", async () => {
    mockTmuxWithProcess("copilot");
    setupSessionDir();
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "session.shutdown",
      payloadType: null,
      modifiedAt: new Date(),
    });

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
  });

  it("returns active for tool.execution_start event type", async () => {
    mockTmuxWithProcess("copilot");
    setupSessionDir();
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "tool.execution_start",
      payloadType: null,
      modifiedAt: new Date(),
    });

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("active");
  });

  it("handles tool.execution_complete with age decay", async () => {
    mockTmuxWithProcess("copilot");
    setupSessionDir();
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "tool.execution_complete",
      payloadType: null,
      modifiedAt: new Date(),
    });

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("active");
  });

  it("returns exited when process handle has dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const session = makeSession({ runtimeHandle: makeProcessHandle(999) });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
    killSpy.mockRestore();
  });
});

// =========================================================================
// recordActivity
// =========================================================================
describe("recordActivity", () => {
  const agent = create();

  it("delegates to recordTerminalActivity when workspacePath exists", async () => {
    const session = makeSession({ workspacePath: "/workspace/test" });
    await agent.recordActivity!(session, "some terminal output");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "some terminal output",
      expect.any(Function),
    );
  });

  it("does nothing when workspacePath is missing", async () => {
    const session = makeSession({ workspacePath: undefined });
    await agent.recordActivity!(session, "some output");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
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

  it("returns null when workspacePath is undefined", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: undefined }))).toBeNull();
  });

  it("returns null when no session directory matches", async () => {
    mockReaddir.mockResolvedValue(["sess-abc"]);
    mockReadFile.mockResolvedValue(makeWorkspaceYaml({ cwd: "/other/path", id: "sess-abc" }));
    mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000) });

    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns session info with summary from workspace.yaml", async () => {
    mockReaddir.mockResolvedValue(["sess-uuid"]);
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes("workspace.yaml")) {
        return Promise.resolve(
          makeWorkspaceYaml({ id: "sess-uuid", cwd: "/workspace/test", summary: "fix login bug" }),
        );
      }
      // events.jsonl read returns empty
      return Promise.resolve("");
    });
    mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000), size: 0 });

    const result = await agent.getSessionInfo(makeSession());
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("fix login bug");
    expect(result!.summaryIsFallback).toBe(false);
    expect(result!.agentSessionId).toBe("sess-uuid");
  });

  it("sets summaryIsFallback=true when no summary in workspace.yaml", async () => {
    mockReaddir.mockResolvedValue(["sess-uuid"]);
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes("workspace.yaml")) {
        return Promise.resolve(makeWorkspaceYaml({ id: "sess-uuid", cwd: "/workspace/test" }));
      }
      return Promise.resolve("");
    });
    mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000), size: 0 });

    const result = await agent.getSessionInfo(makeSession());
    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
    expect(result!.summaryIsFallback).toBe(true);
  });

  it("returns null when workspace.yaml is unreadable", async () => {
    mockReaddir.mockResolvedValue(["sess-uuid"]);
    mockReadFile.mockRejectedValue(new Error("EACCES"));
    mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000) });

    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("picks the most recently modified matching session directory", async () => {
    mockReaddir.mockResolvedValue(["old-sess", "new-sess"]);
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes("old-sess") && path.includes("workspace.yaml")) {
        return Promise.resolve(
          makeWorkspaceYaml({ id: "old-sess", cwd: "/workspace/test", summary: "old task" }),
        );
      }
      if (path.includes("new-sess") && path.includes("workspace.yaml")) {
        return Promise.resolve(
          makeWorkspaceYaml({ id: "new-sess", cwd: "/workspace/test", summary: "new task" }),
        );
      }
      return Promise.resolve("");
    });
    mockStat.mockImplementation((path: string) => {
      if (path.includes("old-sess")) {
        return Promise.resolve({ mtimeMs: 1000, mtime: new Date(1000) });
      }
      if (path.includes("new-sess")) {
        return Promise.resolve({ mtimeMs: 2000, mtime: new Date(2000) });
      }
      return Promise.resolve({ mtimeMs: 0, mtime: new Date(0), size: 0 });
    });

    const result = await agent.getSessionInfo(makeSession());
    expect(result).not.toBeNull();
    expect(result!.agentSessionId).toBe("new-sess");
    expect(result!.summary).toBe("new task");
  });
});

// =========================================================================
// getRestoreCommand
// =========================================================================
describe("getRestoreCommand", () => {
  const agent = create();

  function makeProjectConfig(overrides: Record<string, unknown> = {}) {
    return {
      name: "test-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "test",
      ...overrides,
    };
  }

  it("returns null when workspacePath is null", async () => {
    const session = makeSession({ workspacePath: null });
    expect(await agent.getRestoreCommand!(session, makeProjectConfig())).toBeNull();
  });

  it("returns null when no matching session directory found", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const session = makeSession({ workspacePath: "/workspace/test" });
    expect(await agent.getRestoreCommand!(session, makeProjectConfig())).toBeNull();
  });

  it("returns null when workspace.yaml has no session id", async () => {
    mockReaddir.mockResolvedValue(["sess-uuid"]);
    mockReadFile.mockResolvedValue(makeWorkspaceYaml({ cwd: "/workspace/test" }));
    mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000) });

    const session = makeSession({ workspacePath: "/workspace/test" });
    expect(await agent.getRestoreCommand!(session, makeProjectConfig())).toBeNull();
  });

  it("builds resume command with --resume=<uuid>", async () => {
    mockReaddir.mockResolvedValue(["sess-uuid"]);
    mockReadFile.mockResolvedValue(
      makeWorkspaceYaml({ id: "cbe88136-cfb2", cwd: "/workspace/test", summary: "test" }),
    );
    mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000) });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig());

    expect(cmd).not.toBeNull();
    expect(cmd).toContain("copilot");
    expect(cmd).toContain("--resume='cbe88136-cfb2'");
    expect(cmd).toContain("--no-auto-update");
  });

  it("includes --allow-all --no-ask-user when project permissions=permissionless", async () => {
    mockReaddir.mockResolvedValue(["sess-uuid"]);
    mockReadFile.mockResolvedValue(
      makeWorkspaceYaml({ id: "sess-uuid", cwd: "/workspace/test" }),
    );
    mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000) });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(
      session,
      makeProjectConfig({ agentConfig: { permissions: "permissionless" } }),
    );

    expect(cmd).toContain("--allow-all");
    expect(cmd).toContain("--no-ask-user");
  });

  it("includes --allow-tool flags when project permissions=auto-edit", async () => {
    mockReaddir.mockResolvedValue(["sess-uuid"]);
    mockReadFile.mockResolvedValue(
      makeWorkspaceYaml({ id: "sess-uuid", cwd: "/workspace/test" }),
    );
    mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000) });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(
      session,
      makeProjectConfig({ agentConfig: { permissions: "auto-edit" } }),
    );

    expect(cmd).toContain("--allow-tool=write");
    expect(cmd).toContain("--allow-tool='shell(git:*)'");
  });

  it("includes --mode plan when project permissions=suggest", async () => {
    mockReaddir.mockResolvedValue(["sess-uuid"]);
    mockReadFile.mockResolvedValue(
      makeWorkspaceYaml({ id: "sess-uuid", cwd: "/workspace/test" }),
    );
    mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000) });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(
      session,
      makeProjectConfig({ agentConfig: { permissions: "suggest" } }),
    );

    expect(cmd).toContain("--mode plan");
  });

  it("includes --model from project config", async () => {
    mockReaddir.mockResolvedValue(["sess-uuid"]);
    mockReadFile.mockResolvedValue(
      makeWorkspaceYaml({ id: "sess-uuid", cwd: "/workspace/test" }),
    );
    mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000) });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(
      session,
      makeProjectConfig({ agentConfig: { model: "claude-sonnet-4.6" } }),
    );

    expect(cmd).toContain("--model 'claude-sonnet-4.6'");
  });
});

// =========================================================================
// setupWorkspaceHooks & postLaunchSetup
// =========================================================================
describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("is a no-op (PATH wrappers are installed by session-manager)", async () => {
    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });
    // No file writes expected
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});

describe("postLaunchSetup", () => {
  const agent = create();

  it("is a no-op (PATH wrappers are re-ensured by session-manager)", async () => {
    await agent.postLaunchSetup!(makeSession());
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});
