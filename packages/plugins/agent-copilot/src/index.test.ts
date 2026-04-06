import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockExecFileAsync,
  mockReadFile,
  mockReaddir,
  mockStat,
  mockHomedir,
  mockReadLastJsonlEntry,
  mockReadLastActivityEntry,
  mockSetupPathWrapperWorkspace,
  mockRecordTerminalActivity,
} = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockReadFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockStat: vi.fn(),
  mockHomedir: vi.fn(() => "/mock/home"),
  mockReadLastJsonlEntry: vi.fn(),
  mockReadLastActivityEntry: vi.fn(),
  mockSetupPathWrapperWorkspace: vi.fn().mockResolvedValue(undefined),
  mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@composio/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readLastJsonlEntry: mockReadLastJsonlEntry,
    readLastActivityEntry: mockReadLastActivityEntry,
    setupPathWrapperWorkspace: mockSetupPathWrapperWorkspace,
    recordTerminalActivity: mockRecordTerminalActivity,
  };
});

import {
  create,
  manifest,
  default as defaultExport,
  detect,
  _resetSessionCache,
  resolveCopilotBinary,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const WORKSPACE = "/workspace/test";
const _COPILOT_DIR = "/mock/home/.copilot/session-state";
const SESSION_ID = "abc-123-session";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: WORKSPACE,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeTmuxHandle(id = "tmux-1"): RuntimeHandle {
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

function workspaceYaml(overrides: Partial<Record<string, string>> = {}): string {
  const defaults = {
    id: SESSION_ID,
    cwd: WORKSPACE,
    git_root: WORKSPACE,
    summary: "Fix login bug",
    branch: "feat/fix-login",
    created_at: "2026-04-05T12:00:00.000Z",
    updated_at: "2026-04-05T12:30:00.000Z",
    ...overrides,
  };
  return Object.entries(defaults)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/** Set up readdir + readFile + stat to return a single matching session. */
function mockOneMatchingSession(options: { yaml?: string; eventsMtimeMs?: number } = {}) {
  const yaml = options.yaml ?? workspaceYaml();
  const mtimeMs = options.eventsMtimeMs ?? Date.now();

  mockReaddir.mockResolvedValue([SESSION_ID]);
  mockReadFile.mockResolvedValue(yaml);
  mockStat.mockImplementation((path: string) => {
    if (path.endsWith("events.jsonl")) {
      return Promise.resolve({ mtimeMs, mtime: new Date(mtimeMs) });
    }
    if (path.endsWith("workspace.yaml")) {
      return Promise.resolve({ mtimeMs, mtime: new Date(mtimeMs) });
    }
    return Promise.reject(new Error("ENOENT"));
  });
}

function mockTmuxProcess(running: boolean, binaryName = "copilot") {
  mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
    }
    if (cmd === "ps") {
      const line = running ? `  789 ttys003  /usr/local/bin/${binaryName} --autopilot` : "  789 ttys003  bash";
      return Promise.resolve({ stdout: `  PID TT ARGS\n${line}\n`, stderr: "" });
    }
    return Promise.reject(new Error(`Unexpected exec: ${cmd} ${args.join(" ")}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetSessionCache();
  mockHomedir.mockReturnValue("/mock/home");
  mockReaddir.mockResolvedValue([]);
  mockReadFile.mockRejectedValue(new Error("ENOENT"));
  mockStat.mockRejectedValue(new Error("ENOENT"));
  mockReadLastJsonlEntry.mockResolvedValue(null);
  mockReadLastActivityEntry.mockResolvedValue(null);
});

// ===========================================================================
// Manifest & Exports
// ===========================================================================
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

  it("default export is a PluginModule with manifest/create/detect", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
    expect(typeof defaultExport.detect).toBe("function");
  });

  it("create() returns an Agent with name 'copilot'", () => {
    const agent = create();
    expect(agent.name).toBe("copilot");
    expect(agent.processName).toBe("copilot");
  });
});

// ===========================================================================
// getLaunchCommand
// ===========================================================================
describe("getLaunchCommand", () => {
  it("builds a base command with sensible defaults", () => {
    const cmd = create().getLaunchCommand(makeLaunchConfig());
    // Always-on flags for AO-managed sessions
    expect(cmd).toContain("--no-ask-user");
    expect(cmd).toContain("--autopilot");
    expect(cmd).toContain("--no-auto-update");
    // Default permission = auto-edit/default → --allow-all-tools
    expect(cmd).toContain("--allow-all-tools");
    expect(cmd).not.toContain("--yolo");
  });

  it("maps permissionless → --yolo", () => {
    const cmd = create().getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--yolo");
    expect(cmd).not.toContain("--allow-all-tools");
  });

  it("maps suggest → no permission flags", () => {
    const cmd = create().getLaunchCommand(makeLaunchConfig({ permissions: "suggest" }));
    expect(cmd).not.toContain("--yolo");
    expect(cmd).not.toContain("--allow-all-tools");
  });

  it("legacy 'skip' permission is normalized to permissionless → --yolo", () => {
    const cmd = create().getLaunchCommand(makeLaunchConfig({ permissions: "skip" }));
    expect(cmd).toContain("--yolo");
  });

  it("adds --model when configured", () => {
    const cmd = create().getLaunchCommand(makeLaunchConfig({ model: "gpt-5-mini" }));
    expect(cmd).toContain("--model 'gpt-5-mini'");
  });

  it("passes prompt via -i for interactive mode", () => {
    const cmd = create().getLaunchCommand(
      makeLaunchConfig({ prompt: "Fix the login bug" }),
    );
    expect(cmd).toMatch(/-i 'Fix the login bug'/);
  });

  it("shell-escapes prompts with quotes and special chars", () => {
    const cmd = create().getLaunchCommand(
      makeLaunchConfig({ prompt: "don't break; echo pwned" }),
    );
    // shellEscape wraps in single quotes, escapes internal quotes
    expect(cmd).toContain("-i 'don'\\''t break; echo pwned'");
  });
});

// ===========================================================================
// getEnvironment
// ===========================================================================
describe("getEnvironment", () => {
  it("sets AO_SESSION_ID and builds PATH via wrapper", () => {
    const env = create().getEnvironment(makeLaunchConfig({ sessionId: "sess-42" }));
    expect(env["AO_SESSION_ID"]).toBe("sess-42");
    expect(env["PATH"]).toContain(".ao/bin");
    expect(env["GH_PATH"]).toBeDefined();
    expect(env["COPILOT_ALLOW_ALL"]).toBe("1");
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = create().getEnvironment(makeLaunchConfig({ issueId: "JIRA-123" }));
    expect(env["AO_ISSUE_ID"]).toBe("JIRA-123");
  });

  it("omits AO_ISSUE_ID when not provided", () => {
    const env = create().getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });
});

// ===========================================================================
// detectActivity
// ===========================================================================
describe("detectActivity", () => {
  const agent = create();

  it("returns idle for empty output", () => {
    expect(agent.detectActivity("")).toBe("idle");
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("returns idle when the last line is an empty prompt", () => {
    expect(agent.detectActivity("welcome to copilot\n> ")).toBe("idle");
    expect(agent.detectActivity("bla bla\n❯ ")).toBe("idle");
  });

  it("returns waiting_input for permission prompts", () => {
    expect(agent.detectActivity("Allow this command? [y/n/a]")).toBe("waiting_input");
    expect(agent.detectActivity("running tool\nAllow this tool? [y/n]")).toBe("waiting_input");
    expect(agent.detectActivity("do the thing\nconfirm:")).toBe("waiting_input");
  });

  it("returns blocked for rate limit / quota errors", () => {
    expect(agent.detectActivity("Error: rate limited, retry later")).toBe("blocked");
    expect(agent.detectActivity("quota exceeded on your plan")).toBe("blocked");
    expect(agent.detectActivity("premium request quota exhausted")).toBe("blocked");
    expect(agent.detectActivity("http 429 too many requests")).toBe("blocked");
    expect(agent.detectActivity("authentication failed: token expired")).toBe("blocked");
  });

  it("returns active for streaming responses", () => {
    expect(agent.detectActivity("Reading files...\nAnalyzing...")).toBe("active");
    expect(agent.detectActivity("✓ Ran tool get_file\n…thinking")).toBe("active");
  });
});

// ===========================================================================
// isProcessRunning
// ===========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when copilot is running in a tmux pane", async () => {
    mockTmuxProcess(true);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when no copilot process in the pane", async () => {
    mockTmuxProcess(false);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("matches .copilot-wrapped node wrapper variant", async () => {
    mockTmuxProcess(true, ".copilot-wrapped");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false on tmux errors", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux: no session"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("checks PID via signal 0 for process runtime", async () => {
    // Use a PID that belongs to our own test process — guaranteed alive.
    expect(await agent.isProcessRunning(makeProcessHandle(process.pid))).toBe(true);
  });

  it("returns false for a non-existent PID", async () => {
    // PID 1 is unlikely to match our perms or could be init — use a huge one.
    expect(await agent.isProcessRunning(makeProcessHandle(9_999_999))).toBe(false);
  });

  it("returns false when handle has no pid data", async () => {
    expect(await agent.isProcessRunning(makeProcessHandle())).toBe(false);
  });

  it("does not false-positive match github-copilot-language-server", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  789 ttys003  /usr/lib/github-copilot-language-server --stdio\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error(`Unexpected exec: ${cmd}`));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("does not false-positive match paths containing copilot substring", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  789 ttys003  /var/log/copilot-extension.log\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error(`Unexpected exec: ${cmd}`));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });
});

// ===========================================================================
// Session discovery
// ===========================================================================
describe("session discovery (workspace.yaml matching)", () => {
  it("matches a session by cwd", async () => {
    mockOneMatchingSession();
    mockTmuxProcess(true);
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "user.message",
      modifiedAt: new Date(),
    });
    const info = await create().getSessionInfo(makeSession());
    expect(info).not.toBeNull();
    expect(info?.agentSessionId).toBe(SESSION_ID);
    expect(info?.summary).toBe("Fix login bug");
  });

  it("falls back to git_root when cwd does not match", async () => {
    mockOneMatchingSession({
      yaml: workspaceYaml({ cwd: "/some/other/dir", git_root: WORKSPACE }),
    });
    const info = await create().getSessionInfo(makeSession());
    expect(info).not.toBeNull();
    expect(info?.agentSessionId).toBe(SESSION_ID);
  });

  it("returns null when no session matches the workspace", async () => {
    mockReaddir.mockResolvedValue(["other-session"]);
    mockReadFile.mockResolvedValue(workspaceYaml({ cwd: "/different/path", git_root: "/different/path" }));
    expect(await create().getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when session-state dir doesn't exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    expect(await create().getSessionInfo(makeSession())).toBeNull();
  });

  it("picks the most recently updated matching session", async () => {
    const OLD = "old-session";
    const NEW = "new-session";
    mockReaddir.mockResolvedValue([OLD, NEW]);
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes(OLD)) {
        return Promise.resolve(workspaceYaml({ id: OLD, summary: "Old work" }));
      }
      if (path.includes(NEW)) {
        return Promise.resolve(workspaceYaml({ id: NEW, summary: "New work" }));
      }
      return Promise.reject(new Error("ENOENT"));
    });
    mockStat.mockImplementation((path: string) => {
      if (path.includes(OLD) && path.endsWith("events.jsonl")) {
        return Promise.resolve({ mtimeMs: 1_000, mtime: new Date(1_000) });
      }
      if (path.includes(NEW) && path.endsWith("events.jsonl")) {
        return Promise.resolve({ mtimeMs: 5_000, mtime: new Date(5_000) });
      }
      return Promise.reject(new Error("ENOENT"));
    });
    const info = await create().getSessionInfo(makeSession());
    expect(info?.agentSessionId).toBe(NEW);
    expect(info?.summary).toBe("New work");
  });
});

// ===========================================================================
// getActivityState — the critical cascade
// ===========================================================================
describe("getActivityState", () => {
  it("returns exited when no runtime handle", async () => {
    const s = await create().getActivityState(makeSession({ runtimeHandle: null }));
    expect(s?.state).toBe("exited");
  });

  it("returns exited when process is not running", async () => {
    mockTmuxProcess(false);
    const s = await create().getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(s?.state).toBe("exited");
  });

  it("returns active when native JSONL shows fresh user.message", async () => {
    mockTmuxProcess(true);
    mockOneMatchingSession();
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "user.message",
      modifiedAt: new Date(), // fresh → active
    });
    const s = await create().getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(s?.state).toBe("active");
  });

  it("returns ready when native JSONL shows turn_end recently but past active window", async () => {
    mockTmuxProcess(true);
    mockOneMatchingSession();
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "assistant.turn_end",
      modifiedAt: new Date(Date.now() - 60_000), // 60s ago
    });
    const s = await create().getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(s?.state).toBe("ready");
  });

  it("returns idle when native JSONL entry is older than threshold", async () => {
    mockTmuxProcess(true);
    mockOneMatchingSession();
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "assistant.turn_end",
      modifiedAt: new Date(Date.now() - 10 * 60_000), // 10 min ago
    });
    const s = await create().getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(s?.state).toBe("idle");
  });

  it("returns exited when native JSONL shows session.shutdown", async () => {
    mockTmuxProcess(true);
    mockOneMatchingSession();
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "session.shutdown",
      modifiedAt: new Date(),
    });
    const s = await create().getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(s?.state).toBe("exited");
  });

  it("returns blocked for fresh session.warning", async () => {
    mockTmuxProcess(true);
    mockOneMatchingSession();
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "session.warning",
      modifiedAt: new Date(),
    });
    const s = await create().getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(s?.state).toBe("blocked");
  });

  it("returns waiting_input from AO activity JSONL when native is silent", async () => {
    mockTmuxProcess(true);
    mockOneMatchingSession();
    mockReadLastJsonlEntry.mockResolvedValue(null);
    // Fresh waiting_input entry — checkActivityLogState should surface it.
    mockReadLastActivityEntry.mockResolvedValue({
      entry: {
        ts: new Date().toISOString(),
        state: "waiting_input",
        source: "terminal",
        trigger: "Allow this tool? [y/n]",
      },
      modifiedAt: new Date(),
    });
    const s = await create().getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(s?.state).toBe("waiting_input");
  });

  it("falls back to JSONL age decay when native signal missing", async () => {
    mockTmuxProcess(true);
    mockOneMatchingSession();
    mockReadLastJsonlEntry.mockResolvedValue(null);
    // Fresh terminal entry classified as active
    mockReadLastActivityEntry.mockResolvedValue({
      entry: {
        ts: new Date().toISOString(),
        state: "active",
        source: "terminal",
      },
      modifiedAt: new Date(),
    });
    const s = await create().getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(s?.state).toBe("active");
  });

  it("uses events.jsonl mtime as last resort when all else fails", async () => {
    mockTmuxProcess(true);
    const mtimeMs = Date.now() - 10 * 60_000; // 10 min ago → idle
    mockOneMatchingSession({ eventsMtimeMs: mtimeMs });
    mockReadLastJsonlEntry.mockResolvedValue(null);
    mockReadLastActivityEntry.mockResolvedValue(null);
    const s = await create().getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(s?.state).toBe("idle");
  });

  it("returns null when no workspace path and process is running", async () => {
    mockTmuxProcess(true);
    const s = await create().getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: null as unknown as string }),
    );
    expect(s).toBeNull();
  });
});

// ===========================================================================
// getRestoreCommand
// ===========================================================================
describe("getRestoreCommand", () => {
  it("returns null when no session is found", async () => {
    mockReaddir.mockResolvedValue([]);
    const cmd = await create().getRestoreCommand!(makeSession(), {
      name: "p",
      repo: "o/r",
      path: "/",
      defaultBranch: "main",
      sessionPrefix: "p",
    });
    expect(cmd).toBeNull();
  });

  it("builds a --resume command for the matched session", async () => {
    mockOneMatchingSession();
    const cmd = await create().getRestoreCommand!(makeSession(), {
      name: "p",
      repo: "o/r",
      path: "/",
      defaultBranch: "main",
      sessionPrefix: "p",
      agentConfig: { model: "gpt-5-mini" },
    });
    expect(cmd).toContain(`--resume='${SESSION_ID}'`);
    expect(cmd).toContain("--model 'gpt-5-mini'");
    expect(cmd).toContain("--autopilot");
  });
});

// ===========================================================================
// detect
// ===========================================================================
describe("detect", () => {
  it("returns a boolean", () => {
    // Can't assert true/false since it depends on whether copilot is on the
    // host, but it must at least return a boolean and not throw.
    const result = detect();
    expect(typeof result).toBe("boolean");
  });
});

// ===========================================================================
// recordActivity
// ===========================================================================
describe("recordActivity", () => {
  it("delegates to recordTerminalActivity when workspacePath is set", async () => {
    await create().recordActivity!(makeSession(), "> ");
    expect(mockRecordTerminalActivity).toHaveBeenCalledTimes(1);
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      WORKSPACE,
      "> ",
      expect.any(Function),
    );
  });

  it("no-ops when workspacePath is missing", async () => {
    await create().recordActivity!(
      makeSession({ workspacePath: null as unknown as string }),
      "anything",
    );
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// setupWorkspaceHooks / postLaunchSetup
// ===========================================================================
describe("workspace hooks", () => {
  it("setupWorkspaceHooks installs PATH wrappers", async () => {
    await create().setupWorkspaceHooks!(WORKSPACE, {});
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith(WORKSPACE);
  });

  it("postLaunchSetup installs PATH wrappers and resolves binary", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "/usr/local/bin/copilot\n", stderr: "" });
    await create().postLaunchSetup!(makeSession());
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith(WORKSPACE);
  });
});

// ===========================================================================
// resolveCopilotBinary
// ===========================================================================
describe("resolveCopilotBinary", () => {
  it("returns path from `which copilot` when available", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "/opt/homebrew/bin/copilot\n", stderr: "" });
    const resolved = await resolveCopilotBinary();
    expect(resolved).toBe("/opt/homebrew/bin/copilot");
  });

  it("falls back to common locations when which fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockImplementation((p: string) => {
      if (p === "/opt/homebrew/bin/copilot") return Promise.resolve({});
      return Promise.reject(new Error("ENOENT"));
    });
    const resolved = await resolveCopilotBinary();
    expect(resolved).toBe("/opt/homebrew/bin/copilot");
  });

  it("returns bare 'copilot' as final fallback", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockRejectedValue(new Error("ENOENT"));
    const resolved = await resolveCopilotBinary();
    expect(resolved).toBe("copilot");
  });
});
