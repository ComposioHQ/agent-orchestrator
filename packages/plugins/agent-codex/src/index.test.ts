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
  mockReaddir,
  mockRename,
  mockStat,
  mockLstat,
  mockOpen,
  mockHomedir,
} = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockRename: vi.fn().mockResolvedValue(undefined),
  mockStat: vi.fn(),
  mockLstat: vi.fn(),
  mockOpen: vi.fn(),
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
  readdir: mockReaddir,
  rename: mockRename,
  stat: mockStat,
  lstat: mockLstat,
  open: mockOpen,
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

import { create, manifest, default as defaultExport, resolveCodexBinary } from "./index.js";

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

/**
 * Create a mock file handle for `open()` that returns `content` from `read()`.
 * Used by sessionFileMatchesCwd which reads only the first 4 KB.
 */
function makeFakeFileHandle(content: string) {
  const buf = Buffer.from(content, "utf-8");
  return {
    read: vi.fn().mockImplementation((buffer: Buffer, offset: number, length: number, _position: number) => {
      const bytesToCopy = Math.min(length, buf.length);
      buf.copy(buffer, offset, 0, bytesToCopy);
      return Promise.resolve({ bytesRead: bytesToCopy, buffer });
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Set up mockOpen so that any `open(path, "r")` call returns a fake handle
 * reading `content`. This is used by sessionFileMatchesCwd.
 */
function setupMockOpen(content: string) {
  mockOpen.mockResolvedValue(makeFakeFileHandle(content));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHomedir.mockReturnValue("/mock/home");
  // Default: open() returns a handle with empty content (no session_meta match).
  // Session tests call setupMockOpen(content) to override.
  mockOpen.mockResolvedValue(makeFakeFileHandle(""));
  // Default: lstat rejects (no subdirectories). Session tests override as needed.
  mockLstat.mockRejectedValue(new Error("ENOENT"));
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

  it("includes --dangerously-bypass-approvals-and-sandbox when permissions=skip", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "skip" }));
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--full-auto");
  });

  it("includes --ask-for-approval never when permissions=auto-edit", () => {
    // Cast needed: "auto-edit" not yet in AgentLaunchConfig type union
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "auto-edit" as AgentLaunchConfig["permissions"] }),
    );
    expect(cmd).toContain("--ask-for-approval never");
  });

  it("includes --ask-for-approval untrusted when permissions=suggest", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "suggest" as AgentLaunchConfig["permissions"] }),
    );
    expect(cmd).toContain("--ask-for-approval untrusted");
  });

  it("omits approval flags when permissions=default", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "default" }));
    expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--ask-for-approval");
    expect(cmd).not.toContain("--full-auto");
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
    expect(cmd).toBe("codex --dangerously-bypass-approvals-and-sandbox --model 'o3' -c model_reasoning_effort=high -- 'Go'");
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
    expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--ask-for-approval");
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("-c");
    expect(cmd).not.toContain("model_reasoning_effort");
  });

  // -- Reasoning effort tests --
  describe("reasoning effort", () => {
    it("adds model_reasoning_effort=high for o3 model", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "o3" }));
      expect(cmd).toContain("-c model_reasoning_effort=high");
    });

    it("adds model_reasoning_effort=high for o3-mini model", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "o3-mini" }));
      expect(cmd).toContain("-c model_reasoning_effort=high");
    });

    it("adds model_reasoning_effort=high for o4-mini model", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "o4-mini" }));
      expect(cmd).toContain("-c model_reasoning_effort=high");
    });

    it("adds model_reasoning_effort=high for O3 (case-insensitive)", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "O3" }));
      expect(cmd).toContain("-c model_reasoning_effort=high");
    });

    it("adds model_reasoning_effort=high for O4-MINI (case-insensitive)", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "O4-MINI" }));
      expect(cmd).toContain("-c model_reasoning_effort=high");
    });

    it("does NOT add reasoning effort for gpt-4o model", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4o" }));
      expect(cmd).not.toContain("model_reasoning_effort");
    });

    it("does NOT add reasoning effort for gpt-4.1 model", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4.1" }));
      expect(cmd).not.toContain("model_reasoning_effort");
    });

    it("does NOT add reasoning effort when no model specified", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig());
      expect(cmd).not.toContain("model_reasoning_effort");
    });
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
// getSessionInfo — Codex JSONL parsing
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  // Helper to build JSONL content from lines
  function jsonl(...lines: Record<string, unknown>[]): string {
    return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  }

  it("returns null when workspacePath is null", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("returns null when workspacePath is undefined", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: undefined }))).toBeNull();
  });

  it("returns null when ~/.codex/sessions/ directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when sessions directory is empty", async () => {
    mockReaddir.mockResolvedValue([]);
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when no session files match the workspace cwd", async () => {
    mockReaddir.mockResolvedValue(["session-abc.jsonl"]);
    const content = jsonl({ type: "session_meta", cwd: "/other/workspace", model: "gpt-4o" });
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    expect(await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }))).toBeNull();
  });

  it("returns session info with cost and model when matching session found", async () => {
    const sessionContent = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "o3-mini" },
      { type: "event_msg", msg: { type: "token_count", input_tokens: 1000, output_tokens: 500, cached_tokens: 200, reasoning_tokens: 100 } },
      { type: "event_msg", msg: { type: "token_count", input_tokens: 2000, output_tokens: 300, cached_tokens: 0, reasoning_tokens: 0 } },
    );

    mockReaddir.mockResolvedValue(["session-123.jsonl"]);
    setupMockOpen(sessionContent);
    mockReadFile.mockResolvedValue(sessionContent);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));

    expect(result).not.toBeNull();
    expect(result!.agentSessionId).toBe("session-123");
    expect(result!.summary).toBe("Codex session (o3-mini)");
    expect(result!.summaryIsFallback).toBe(true);
    expect(result!.cost).toBeDefined();
    // cached_tokens/reasoning_tokens are subsets, not additive
    // input: 1000 + 2000 = 3000
    // output: 500 + 300 = 800
    expect(result!.cost!.inputTokens).toBe(3000);
    expect(result!.cost!.outputTokens).toBe(800);
    expect(result!.cost!.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("picks the most recently modified matching session file", async () => {
    const oldContent = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
    );
    const newContent = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "o3" },
    );

    mockReaddir.mockResolvedValue(["old-session.jsonl", "new-session.jsonl"]);
    mockOpen.mockImplementation(async (path: string) => {
      if (path.includes("old-session")) return makeFakeFileHandle(oldContent);
      if (path.includes("new-session")) return makeFakeFileHandle(newContent);
      throw new Error("ENOENT");
    });
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes("old-session")) return Promise.resolve(oldContent);
      if (path.includes("new-session")) return Promise.resolve(newContent);
      return Promise.reject(new Error("ENOENT"));
    });
    mockStat.mockImplementation((path: string) => {
      if (path.includes("old-session")) return Promise.resolve({ mtimeMs: 1000 });
      if (path.includes("new-session")) return Promise.resolve({ mtimeMs: 2000 });
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));

    expect(result).not.toBeNull();
    expect(result!.agentSessionId).toBe("new-session");
    expect(result!.summary).toBe("Codex session (o3)");
  });

  it("handles corrupt/malformed JSONL lines gracefully", async () => {
    const content = '{"type":"session_meta","cwd":"/workspace/test","model":"gpt-4o"}\n' +
      "not valid json\n" +
      '{"type":"event_msg","msg":{"type":"token_count","input_tokens":500,"output_tokens":200}}\n';

    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));

    expect(result).not.toBeNull();
    expect(result!.cost!.inputTokens).toBe(500);
    expect(result!.cost!.outputTokens).toBe(200);
  });

  it("returns null summary when no model in session_meta", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test" },
      { type: "event_msg", msg: { type: "token_count", input_tokens: 100, output_tokens: 50 } },
    );

    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));

    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
  });

  it("returns undefined cost when no token_count events", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { type: "event_msg", msg: { type: "other_event" } },
    );

    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));

    expect(result).not.toBeNull();
    expect(result!.cost).toBeUndefined();
  });

  it("handles unreadable session files gracefully", async () => {
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    // open() finds matching session_meta, but readFile fails for full parse
    setupMockOpen(jsonl({ type: "session_meta", cwd: "/workspace/test" }));
    mockStat.mockResolvedValue({ mtimeMs: 1000 });
    mockReadFile.mockRejectedValue(new Error("EACCES"));

    expect(await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }))).toBeNull();
  });

  it("skips session files when stat throws", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockRejectedValue(new Error("EACCES"));

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));
    // stat failed so no bestMatch can be established
    expect(result).toBeNull();
  });

  it("returns null when session JSONL has only empty/malformed lines", async () => {
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    // open() finds matching session_meta for cwd check
    setupMockOpen(jsonl({ type: "session_meta", cwd: "/workspace/test" }));
    // readFile (full parse) returns only garbage
    mockReadFile.mockResolvedValue("not json\n\n   \n");
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));
    expect(result).toBeNull();
  });

  it("finds session files in date-sharded subdirectories (YYYY/MM/DD)", async () => {
    // Simulate ~/.codex/sessions/2026/02/24/rollout-abc.jsonl
    mockReaddir.mockImplementation((dir: string) => {
      if (dir.endsWith("sessions")) return Promise.resolve(["2026"]);
      if (dir.endsWith("2026")) return Promise.resolve(["02"]);
      if (dir.endsWith("02")) return Promise.resolve(["24"]);
      if (dir.endsWith("24")) return Promise.resolve(["rollout-abc.jsonl"]);
      return Promise.resolve([]);
    });
    // lstat is used by collectJsonlFiles to check subdirectories (avoids symlink cycles)
    mockLstat.mockResolvedValue({ isDirectory: () => true });
    // stat is used by findCodexSessionFile to get mtimeMs of matching JSONL files
    mockStat.mockResolvedValue({ mtimeMs: 2000 });
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "o3-mini" },
    );
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));
    expect(result).not.toBeNull();
    expect(result!.agentSessionId).toBe("rollout-abc");
    expect(result!.summary).toBe("Codex session (o3-mini)");
  });

  it("ignores non-JSONL files in sessions directory", async () => {
    mockReaddir.mockResolvedValue(["notes.txt", "config.json", "sess.jsonl"]);
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
    );
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    // Non-JSONL entries trigger lstat to check isDirectory()
    mockLstat.mockResolvedValue({ isDirectory: () => false });
    // stat is used to get mtimeMs for matching JSONL files
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));
    expect(result).not.toBeNull();
    // readFile should only be called once (full parse); cwd check uses open()
    const readFileCalls = mockReadFile.mock.calls.filter(
      (call: string[]) => typeof call[0] === "string" && call[0].includes("sessions/"),
    );
    expect(readFileCalls.length).toBe(1); // once for full parse (cwd check uses open())
  });
});

// =========================================================================
// getRestoreCommand — conversation resume
// =========================================================================
describe("getRestoreCommand", () => {
  const agent = create();

  function jsonl(...lines: Record<string, unknown>[]): string {
    return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  }

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

  it("returns null when workspacePath is undefined", async () => {
    const session = makeSession({ workspacePath: undefined });
    expect(await agent.getRestoreCommand!(session, makeProjectConfig())).toBeNull();
  });

  it("returns null when no matching session file found", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const session = makeSession({ workspacePath: "/workspace/test" });
    expect(await agent.getRestoreCommand!(session, makeProjectConfig())).toBeNull();
  });

  it("returns null when session has no threadId", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { role: "user", content: "Some prompt" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    // Native resume requires a threadId
    expect(await agent.getRestoreCommand!(session, makeProjectConfig())).toBeNull();
  });

  it("builds native resume command with codex resume <threadId>", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { threadId: "thread-abc-123" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig());

    expect(cmd).not.toBeNull();
    expect(cmd).toContain("codex resume");
    expect(cmd).toContain("thread-abc-123");
  });

  it("includes --dangerously-bypass-approvals-and-sandbox from project config", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { threadId: "thread-1" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig({
      agentConfig: { permissions: "skip" },
    }));

    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("includes --ask-for-approval never from project config", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { threadId: "thread-1" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig({
      agentConfig: { permissions: "auto-edit" },
    }));

    expect(cmd).toContain("--ask-for-approval never");
    expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("includes --ask-for-approval untrusted from project config", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { threadId: "thread-1" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig({
      agentConfig: { permissions: "suggest" },
    }));

    expect(cmd).toContain("--ask-for-approval untrusted");
  });

  it("places flags before positional threadId in resume command", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "o3-mini" },
      { threadId: "thread-order-test" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig({
      agentConfig: { permissions: "auto-edit", model: "o3-mini" },
    }));

    expect(cmd).not.toBeNull();
    // threadId should come after all flags
    const threadIdIdx = cmd!.indexOf("thread-order-test");
    const flagIdx = cmd!.indexOf("--ask-for-approval");
    const modelIdx = cmd!.indexOf("--model");
    expect(flagIdx).toBeLessThan(threadIdIdx);
    expect(modelIdx).toBeLessThan(threadIdIdx);
  });

  it("includes model from project config (overrides session model)", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { threadId: "thread-1" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig({
      agentConfig: { model: "o3-mini" },
    }));

    expect(cmd).toContain("--model 'o3-mini'");
    expect(cmd).toContain("-c model_reasoning_effort=high");
  });

  it("falls back to session model when project config has no model", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "o4-mini" },
      { threadId: "thread-1" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig());

    expect(cmd).toContain("--model 'o4-mini'");
    expect(cmd).toContain("-c model_reasoning_effort=high");
  });

  it("handles unreadable session files gracefully", async () => {
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    // open() finds matching session_meta for cwd check
    setupMockOpen(jsonl({ type: "session_meta", cwd: "/workspace/test" }));
    // readFile (full parse) fails
    mockReadFile.mockRejectedValue(new Error("EACCES"));
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    expect(await agent.getRestoreCommand!(session, makeProjectConfig())).toBeNull();
  });
});

// =========================================================================
// resolveCodexBinary
// =========================================================================
describe("resolveCodexBinary", () => {
  it("returns path from `which` when codex is found", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "/usr/local/bin/codex\n", stderr: "" });
    const result = await resolveCodexBinary();
    expect(result).toBe("/usr/local/bin/codex");
    expect(mockExecFileAsync).toHaveBeenCalledWith("which", ["codex"], { timeout: 10_000 });
  });

  it("falls back to common locations when `which` fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockImplementation((path: string) => {
      if (path === "/usr/local/bin/codex") {
        return Promise.resolve({ mtimeMs: 1000 });
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await resolveCodexBinary();
    expect(result).toBe("/usr/local/bin/codex");
  });

  it("checks /opt/homebrew/bin/codex as fallback", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockImplementation((path: string) => {
      if (path === "/opt/homebrew/bin/codex") {
        return Promise.resolve({ mtimeMs: 1000 });
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await resolveCodexBinary();
    expect(result).toBe("/opt/homebrew/bin/codex");
  });

  it("checks ~/.cargo/bin/codex as fallback (Rust-based codex)", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockImplementation((path: string) => {
      if (path === "/mock/home/.cargo/bin/codex") {
        return Promise.resolve({ mtimeMs: 1000 });
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await resolveCodexBinary();
    expect(result).toBe("/mock/home/.cargo/bin/codex");
  });

  it("checks ~/.npm/bin/codex as fallback", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockImplementation((path: string) => {
      if (path === "/mock/home/.npm/bin/codex") {
        return Promise.resolve({ mtimeMs: 1000 });
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await resolveCodexBinary();
    expect(result).toBe("/mock/home/.npm/bin/codex");
  });

  it("returns 'codex' when not found anywhere", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockRejectedValue(new Error("ENOENT"));

    const result = await resolveCodexBinary();
    expect(result).toBe("codex");
  });

  it("returns 'codex' when `which` returns empty stdout", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    mockStat.mockRejectedValue(new Error("ENOENT"));

    const result = await resolveCodexBinary();
    expect(result).toBe("codex");
  });
});

// =========================================================================
// postLaunchSetup — binary resolution
// =========================================================================
describe("postLaunchSetup", () => {
  it("has postLaunchSetup method", () => {
    const agent = create();
    expect(typeof agent.postLaunchSetup).toBe("function");
  });

  it("runs setup when session has workspacePath", async () => {
    const agent = create();
    // which fails, stat fails → resolves to "codex"
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockRejectedValue(new Error("ENOENT"));
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    await agent.postLaunchSetup!(makeSession({ workspacePath: "/workspace/test" }));
    expect(mockMkdir).toHaveBeenCalled();
  });

  it("returns early when session has no workspacePath", async () => {
    const agent = create();
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockRejectedValue(new Error("ENOENT"));
    await agent.postLaunchSetup!(makeSession({ workspacePath: undefined }));
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it("resolves binary and uses it in getLaunchCommand after postLaunchSetup", async () => {
    const agent = create();
    mockExecFileAsync.mockResolvedValue({ stdout: "/opt/bin/codex\n", stderr: "" });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    // Before postLaunchSetup, binary is "codex"
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("codex");

    // After postLaunchSetup resolves the binary
    await agent.postLaunchSetup!(makeSession({ workspacePath: "/workspace/test" }));

    // Now getLaunchCommand should use the resolved binary
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("/opt/bin/codex");
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
