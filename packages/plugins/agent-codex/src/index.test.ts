import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks — available inside vi.mock factories
// ---------------------------------------------------------------------------
const {
  mockExecFileAsync,
  mockWriteFile,
  mockMkdir,
  mockReadFile,
  mockRename,
  mockHomedir,
} = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
  mockRename: vi.fn().mockResolvedValue(undefined),
  mockHomedir: vi.fn(() => "/mock/home"),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  readFile: mockReadFile,
  rename: mockRename,
}));

vi.mock("node:crypto", () => ({
  randomBytes: () => ({ toString: () => "abc123" }),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  mockHomedir.mockReturnValue("/mock/home");
});

// =========================================================================
// Manifest & Exports
// =========================================================================
describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "codex",
      slot: "agent",
      description: "Agent plugin: OpenAI Codex CLI",
      version: "0.1.0",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("codex");
    expect(agent.processName).toBe("codex");
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
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("codex");
  });

  it("includes --full-auto when permissions=skip", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "skip" }));
    expect(cmd).toContain("--full-auto");
  });

  it("includes --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4o" }));
    expect(cmd).toContain("--model 'gpt-4o'");
  });

  it("appends shell-escaped prompt with -- separator", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix it" }));
    expect(cmd).toContain("-- 'Fix it'");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip", model: "o3", prompt: "Go" }),
    );
    expect(cmd).toBe("codex --full-auto --model 'o3' -- 'Go'");
  });

  it("escapes single quotes in prompt (POSIX shell escaping)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's broken" }));
    expect(cmd).toContain("-- 'it'\\''s broken'");
  });

  it("escapes dangerous characters in prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "$(rm -rf /); `evil`; $HOME" }),
    );
    // Single-quoted strings prevent shell expansion
    expect(cmd).toContain("-- '$(rm -rf /); `evil`; $HOME'");
  });

  it("includes -c model_instructions_file when systemPromptFile is set", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPromptFile: "/tmp/prompt.md" }));
    expect(cmd).toContain("-c model_instructions_file='/tmp/prompt.md'");
  });

  it("prefers systemPromptFile over systemPrompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "/tmp/prompt.md", systemPrompt: "Ignored" }),
    );
    expect(cmd).toContain("model_instructions_file='/tmp/prompt.md'");
    expect(cmd).not.toContain("'Ignored'");
  });

  it("includes -c developer_instructions when systemPrompt is set", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPrompt: "Be helpful" }));
    expect(cmd).toContain("-c developer_instructions='Be helpful'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--full-auto");
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("-c");
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

  it("prepends ~/.ao/bin to PATH for shell wrappers", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]).toMatch(/^.*\/\.ao\/bin:/);
  });

  it("PATH starts with the ao bin dir specifically", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]?.startsWith("/mock/home/.ao/bin:")).toBe(true);
  });

  it("falls back to /usr/bin:/bin when process.env.PATH is undefined", () => {
    const originalPath = process.env["PATH"];
    delete process.env["PATH"];
    try {
      const env = agent.getEnvironment(makeLaunchConfig());
      expect(env["PATH"]).toContain("/usr/bin:/bin");
    } finally {
      process.env["PATH"] = originalPath;
    }
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when codex found on tmux pane TTY", async () => {
    mockTmuxWithProcess("codex");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when codex not on tmux pane TTY", async () => {
    mockTmuxWithProcess("codex", false);
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
    // Must NOT call external commands — could match wrong session
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

  it("finds codex on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  codex --model o3\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("does not match similar process names like codex-something", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  /usr/bin/codex-helper\n",
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

  it("returns idle when last line is a bare # prompt", () => {
    expect(agent.detectActivity("some output\n# ")).toBe("idle");
  });

  it("returns idle when prompt follows historical activity indicators", () => {
    // Key regression test: historical active output in the buffer
    // should NOT override an idle prompt on the last line.
    expect(agent.detectActivity("✶ Reading files\nDone.\n> ")).toBe("idle");
    expect(agent.detectActivity("Working on task (esc to interrupt)\nFinished.\n$ ")).toBe("idle");
  });

  // -- Waiting input states --
  it("returns waiting_input for approval required text", () => {
    expect(agent.detectActivity("some output\napproval required\n")).toBe("waiting_input");
  });

  it("returns waiting_input for (y)es / (n)o prompt", () => {
    expect(agent.detectActivity("Do you want to continue?\n(y)es / (n)o\n")).toBe("waiting_input");
  });

  it("returns waiting_input when permission prompt follows historical activity", () => {
    // Permission prompt at the bottom should NOT be overridden by historical
    // spinner/esc output higher in the buffer.
    expect(
      agent.detectActivity("✶ Writing files\nDone.\napproval required\n"),
    ).toBe("waiting_input");
    expect(
      agent.detectActivity("Working (esc to interrupt)\nFinished\n(y)es / (n)o\n"),
    ).toBe("waiting_input");
  });

  // -- Active states --
  it("returns active for non-empty terminal output with no special patterns", () => {
    expect(agent.detectActivity("codex is running some task\n")).toBe("active");
  });

  it("returns active when (esc to interrupt) is present", () => {
    expect(agent.detectActivity("Working on task (esc to interrupt)\n")).toBe("active");
  });

  it("returns active for spinner symbols with -ing words", () => {
    expect(agent.detectActivity("✶ Reading files\n")).toBe("active");
    expect(agent.detectActivity("⏺ Writing to disk\n")).toBe("active");
    expect(agent.detectActivity("✽ Searching codebase\n")).toBe("active");
    expect(agent.detectActivity("⏳ Installing packages\n")).toBe("active");
  });

  it("returns active (not idle) for spinner symbol without -ing word", () => {
    // Spinner symbols alone without -ing words should still fall through to active
    expect(agent.detectActivity("✶ done\n")).toBe("active");
  });

  it("returns active for multi-line output with activity in the middle", () => {
    expect(agent.detectActivity("Starting\n(esc to interrupt)\nstill going\n")).toBe("active");
  });
});

// =========================================================================
// getActivityState
// =========================================================================
describe("getActivityState", () => {
  const agent = create();

  it("returns exited when no runtimeHandle", async () => {
    const session = makeSession({ runtimeHandle: null });
    const result = await agent.getActivityState(session);
    expect(result).toEqual({ state: "exited" });
  });

  it("returns exited when process is not running", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux not running"));
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result).toEqual({ state: "exited" });
  });

  it("returns null (unknown) when process is running", async () => {
    mockTmuxWithProcess("codex");
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    expect(await agent.getActivityState(session)).toBeNull();
  });

  it("returns exited when process handle has dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const session = makeSession({ runtimeHandle: makeProcessHandle(999) });
    const result = await agent.getActivityState(session);
    expect(result).toEqual({ state: "exited" });
    killSpy.mockRestore();
  });

  it("does not include timestamp in exited state", async () => {
    const session = makeSession({ runtimeHandle: null });
    const result = await agent.getActivityState(session);
    // The Codex implementation returns { state: "exited" } without timestamp
    expect(result).toEqual({ state: "exited" });
    expect(result?.timestamp).toBeUndefined();
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

  it("returns null even with null workspacePath", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });
});

// =========================================================================
// setupWorkspaceHooks — file writing behavior
// =========================================================================
describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("has setupWorkspaceHooks method", () => {
    expect(typeof agent.setupWorkspaceHooks).toBe("function");
  });

  it("creates ~/.ao/bin directory", async () => {
    // Version marker doesn't exist — triggers full install
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    expect(mockMkdir).toHaveBeenCalledWith("/mock/home/.ao/bin", { recursive: true });
  });

  it("writes ao-metadata-helper.sh with executable permissions via atomic write", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    // Atomic write: writes to .tmp file first, then renames
    const helperWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes("ao-metadata-helper.sh.tmp."),
    );
    expect(helperWriteCall).toBeDefined();
    expect(helperWriteCall![1]).toContain("update_ao_metadata()");
    expect(helperWriteCall![2]).toEqual({ encoding: "utf-8", mode: 0o755 });

    // Then renamed to final path
    const helperRenameCall = mockRename.mock.calls.find(
      (call: string[]) => typeof call[1] === "string" && call[1].endsWith("ao-metadata-helper.sh"),
    );
    expect(helperRenameCall).toBeDefined();
  });

  it("writes gh and git wrappers atomically when version marker is missing", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    // gh wrapper: written to temp, then renamed
    const ghWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes("/gh.tmp."),
    );
    expect(ghWriteCall).toBeDefined();
    expect(ghWriteCall![1]).toContain("ao gh wrapper");

    const ghRenameCall = mockRename.mock.calls.find(
      (call: string[]) => typeof call[1] === "string" && call[1].endsWith("/gh"),
    );
    expect(ghRenameCall).toBeDefined();

    // git wrapper: written to temp, then renamed
    const gitWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes("/git.tmp."),
    );
    expect(gitWriteCall).toBeDefined();
    expect(gitWriteCall![1]).toContain("ao git wrapper");

    const gitRenameCall = mockRename.mock.calls.find(
      (call: string[]) => typeof call[1] === "string" && call[1].endsWith("/git"),
    );
    expect(gitRenameCall).toBeDefined();
  });

  it("sets executable permissions on gh and git wrappers via writeFile mode", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    const ghWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes("/gh.tmp."),
    );
    expect(ghWriteCall![2]).toEqual({ encoding: "utf-8", mode: 0o755 });

    const gitWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes("/git.tmp."),
    );
    expect(gitWriteCall![2]).toEqual({ encoding: "utf-8", mode: 0o755 });
  });

  it("skips wrapper writes when version marker matches", async () => {
    // First call for version marker — matches current version
    // Second call for AGENTS.md — file doesn't exist
    mockReadFile.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".ao-version")) {
        return Promise.resolve("0.1.0");
      }
      // AGENTS.md read attempt
      return Promise.reject(new Error("ENOENT"));
    });

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    // Should still write the metadata helper (always written)
    const helperWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes("ao-metadata-helper.sh.tmp."),
    );
    expect(helperWriteCall).toBeDefined();

    // But should NOT write gh/git wrappers (version matches)
    const ghWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes("/gh.tmp."),
    );
    expect(ghWriteCall).toBeUndefined();
  });

  it("writes version marker after installing wrappers", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    // Version marker is also atomically written
    const versionWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes(".ao-version.tmp."),
    );
    expect(versionWriteCall).toBeDefined();
    expect(versionWriteCall![1]).toBe("0.1.0");

    const versionRenameCall = mockRename.mock.calls.find(
      (call: string[]) => typeof call[1] === "string" && call[1].endsWith(".ao-version"),
    );
    expect(versionRenameCall).toBeDefined();
  });

  it("appends ao section to AGENTS.md when not present", async () => {
    // Version marker matches (skip wrapper install)
    // AGENTS.md exists without ao section
    mockReadFile.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".ao-version")) {
        return Promise.resolve("0.1.0");
      }
      if (typeof path === "string" && path.endsWith("AGENTS.md")) {
        return Promise.resolve("# Existing Content\n\nSome stuff here.\n");
      }
      return Promise.reject(new Error("ENOENT"));
    });

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    const agentsMdCall = mockWriteFile.mock.calls.find(
      (call: string[]) => typeof call[0] === "string" && call[0].endsWith("AGENTS.md"),
    );
    expect(agentsMdCall).toBeDefined();
    expect(agentsMdCall![1]).toContain("Agent Orchestrator (ao) Session");
    expect(agentsMdCall![1]).toContain("# Existing Content");
  });

  it("creates AGENTS.md if it does not exist", async () => {
    // Version marker matches, AGENTS.md doesn't exist
    mockReadFile.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".ao-version")) {
        return Promise.resolve("0.1.0");
      }
      return Promise.reject(new Error("ENOENT"));
    });

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    const agentsMdCall = mockWriteFile.mock.calls.find(
      (call: string[]) => typeof call[0] === "string" && call[0].endsWith("AGENTS.md"),
    );
    expect(agentsMdCall).toBeDefined();
    expect(agentsMdCall![1]).toContain("Agent Orchestrator (ao) Session");
  });

  it("uses atomic write (temp + rename) to prevent partial reads from concurrent sessions", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    // Every wrapper file should be written to a .tmp file first, then renamed
    // This ensures concurrent readers never see a partially written file
    const tmpWrites = mockWriteFile.mock.calls.filter(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes(".tmp."),
    );
    const renames = mockRename.mock.calls;

    // We expect atomic writes for: helper, gh, git, version marker = 4
    expect(tmpWrites.length).toBe(4);
    expect(renames.length).toBe(4);

    // Each rename should move a .tmp file to the final path
    for (const [src, dst] of renames) {
      expect(src).toContain(".tmp.");
      expect(dst).not.toContain(".tmp.");
    }
  });

  it("does not duplicate ao section in AGENTS.md if already present", async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".ao-version")) {
        return Promise.resolve("0.1.0");
      }
      if (typeof path === "string" && path.endsWith("AGENTS.md")) {
        return Promise.resolve("# Existing\n\n## Agent Orchestrator (ao) Session\n\nAlready here.\n");
      }
      return Promise.reject(new Error("ENOENT"));
    });

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    const agentsMdCall = mockWriteFile.mock.calls.find(
      (call: string[]) => typeof call[0] === "string" && call[0].endsWith("AGENTS.md"),
    );
    // Should NOT write AGENTS.md since the section already exists
    expect(agentsMdCall).toBeUndefined();
  });
});

// =========================================================================
// postLaunchSetup
// =========================================================================
describe("postLaunchSetup", () => {
  const agent = create();

  it("has postLaunchSetup method", () => {
    expect(typeof agent.postLaunchSetup).toBe("function");
  });

  it("runs setup when session has workspacePath", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    await agent.postLaunchSetup!(makeSession({ workspacePath: "/workspace/test" }));
    expect(mockMkdir).toHaveBeenCalled();
  });

  it("returns early when session has no workspacePath", async () => {
    await agent.postLaunchSetup!(makeSession({ workspacePath: undefined }));
    expect(mockMkdir).not.toHaveBeenCalled();
  });
});

// =========================================================================
// Shell wrapper content verification
// =========================================================================
describe("shell wrapper content", () => {
  const agent = create();

  beforeEach(() => {
    // Force wrapper installation by making version marker miss
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
  });

  async function getWrapperContent(name: string): Promise<string> {
    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    // With atomic writes, content is written to a .tmp. file
    const call = mockWriteFile.mock.calls.find(
      (c: [string, string, object]) =>
        typeof c[0] === "string" && c[0].includes(`/${name}.tmp.`),
    );
    return call ? call[1] as string : "";
  }

  describe("metadata helper", () => {
    it("contains update_ao_metadata function", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      expect(content).toContain("update_ao_metadata()");
    });

    it("uses AO_DATA_DIR and AO_SESSION env vars", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      expect(content).toContain("AO_DATA_DIR");
      expect(content).toContain("AO_SESSION");
    });

    it("escapes sed metacharacters in values", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      // Should contain the sed escaping logic for &, |, and \
      expect(content).toContain("escaped_value");
      expect(content).toMatch(/sed.*\\\\&/);
    });

    it("uses atomic temp file + mv pattern", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      expect(content).toContain("temp_file");
      expect(content).toContain("mv");
    });

    it("validates session name has no path separators", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      // Rejects session names containing / or ..
      expect(content).toContain("*/*");
      expect(content).toContain("*..*");
    });

    it("validates ao_dir is an absolute path under expected locations", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      // Only allows paths under $HOME/.ao/, $HOME/.agent-orchestrator/, or /tmp/
      expect(content).toContain('$HOME"/.ao/*');
      expect(content).toContain('$HOME"/.agent-orchestrator/*');
      expect(content).toContain("/tmp/*");
    });

    it("resolves symlinks and verifies file stays within ao_dir", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      expect(content).toContain("pwd -P");
      expect(content).toContain("real_ao_dir");
      expect(content).toContain("real_dir");
    });
  });

  describe("gh wrapper", () => {
    it("uses grep -Fxv for PATH cleaning (not regex grep)", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain("grep -Fxv");
      expect(content).not.toMatch(/grep -v "\^\$ao_bin_dir\$"/);
    });

    it("only captures output for pr/create and pr/merge", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain("pr/create|pr/merge");
    });

    it("uses exec for non-PR commands (transparent passthrough)", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain('exec "$real_gh"');
    });

    it("extracts PR URL from gh pr create output", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain("https://github");
      expect(content).toContain("update_ao_metadata pr");
    });

    it("updates status to merged on gh pr merge", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain("update_ao_metadata status merged");
    });

    it("cleans up temp file on exit", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain("trap");
      expect(content).toContain("rm -f");
    });
  });

  describe("git wrapper", () => {
    it("uses grep -Fxv for PATH cleaning (not regex grep)", async () => {
      const content = await getWrapperContent("git");
      expect(content).toContain("grep -Fxv");
      expect(content).not.toMatch(/grep -v "\^\$ao_bin_dir\$"/);
    });

    it("captures branch name from checkout -b", async () => {
      const content = await getWrapperContent("git");
      expect(content).toContain("checkout/-b");
      expect(content).toContain("update_ao_metadata branch");
    });

    it("captures branch name from switch -c", async () => {
      const content = await getWrapperContent("git");
      expect(content).toContain("switch/-c");
    });

    it("only updates metadata on success (exit code 0)", async () => {
      const content = await getWrapperContent("git");
      expect(content).toContain("exit_code -eq 0");
    });

    it("sources the metadata helper", async () => {
      const content = await getWrapperContent("git");
      expect(content).toContain("source");
      expect(content).toContain("ao-metadata-helper.sh");
    });
  });
});
