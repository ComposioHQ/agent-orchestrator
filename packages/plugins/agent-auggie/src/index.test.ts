import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks — available inside vi.mock factories
// ---------------------------------------------------------------------------
const {
  mockExecFileAsync,
  mockReaddir,
  mockReadFile,
  mockStat,
  mockHomedir,
  mockWriteFile,
  mockMkdir,
  mockChmod,
  mockExistsSync,
} = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
  mockHomedir: vi.fn(() => "/mock/home"),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockChmod: vi.fn(),
  mockExistsSync: vi.fn(() => false),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  stat: mockStat,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  chmod: mockChmod,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

import { create, manifest, default as defaultExport, resetPsCache } from "./index.js";

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

function mockTmuxWithProcess(processName = "auggie", tty = "/dev/ttys001", pid = 12345) {
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

/** Create a mock Auggie session JSON file content */
function makeAuggieSessionJson(overrides: Record<string, unknown> = {}): string {
  const session = {
    sessionId: "abc-123-def",
    created: "2026-03-17T04:00:00.000Z",
    modified: new Date().toISOString(),
    chatHistory: [
      {
        exchange: {
          request_message: "Fix the bug",
          response_text: "I fixed the null pointer exception in auth.ts",
        },
        completed: true,
        sequenceId: 1,
        finishedAt: new Date().toISOString(),
        changedFiles: ["src/auth.ts"],
        source: "local",
      },
    ],
    agentState: { modelId: "claude-opus-4-6", userEmail: "test@test.com" },
    customTitle: "Fix auth bug",
    terminalId: "/dev/ttys001",
    subAgentCreditsUsed: 0,
    creditUsage: null,
    rootTaskUuid: "task-uuid",
    ...overrides,
  };
  return JSON.stringify(session);
}

/** Mock the sessions directory to return specific session files */
function mockSessionFiles(sessions: Array<{ filename: string; content: string }>) {
  mockReaddir.mockResolvedValue(sessions.map((s) => s.filename));
  mockReadFile.mockImplementation((path: string) => {
    const match = sessions.find((s) => path.endsWith(s.filename));
    if (match) return Promise.resolve(match.content);
    return Promise.reject(new Error("ENOENT"));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  resetPsCache();
  mockHomedir.mockReturnValue("/mock/home");
});

// =========================================================================
// Plugin manifest & exports
// =========================================================================
describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "auggie",
      slot: "agent",
      description: "Agent plugin: Auggie (Augment CLI)",
      version: "0.1.0",
    });
  });

  it("create() returns an agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("auggie");
    expect(agent.processName).toBe("auggie");
    expect(agent.promptDelivery).toBe("post-launch");
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

  it("generates base command with workspace root", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("auggie --workspace-root '/workspace/repo'");
  });

  it("includes --model when specified", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "claude-opus-4-6" }));
    expect(cmd).toContain("--model 'claude-opus-4-6'");
  });

  it("does not include prompt (delivered post-launch)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).not.toContain("Fix the bug");
    expect(cmd).not.toContain("--print");
    expect(cmd).not.toContain("--instruction");
  });

  it("does not include --dangerously-skip-permissions (not applicable)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "skip" }));
    expect(cmd).not.toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("--permission");
  });

  it("includes --rules when agentRulesFile is set", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          name: "my-project",
          repo: "owner/repo",
          path: "/workspace/repo",
          defaultBranch: "main",
          sessionPrefix: "my",
          agentConfig: {
            agentRulesFile: ".agent-rules.md",
          },
        },
      }),
    );
    expect(cmd).toContain("--rules '/workspace/repo/.agent-rules.md'");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        model: "opus",
        prompt: "Hello",
        permissions: "skip",
      }),
    );
    expect(cmd).toBe("auggie --workspace-root '/workspace/repo' --model 'opus'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--rules");
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
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "INT-100" }));
    expect(env["AO_ISSUE_ID"]).toBe("INT-100");
  });

  it("does not set AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });

  it("does not set CLAUDECODE (auggie-specific)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["CLAUDECODE"]).toBeUndefined();
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when auggie is found on tmux pane TTY", async () => {
    mockTmuxWithProcess("auggie");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when no auggie on tmux pane TTY", async () => {
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

  it("returns true when PID exists but throws EPERM", async () => {
    const epermErr = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
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

  it("does not match 'auggie-helper' as auggie process", async () => {
    mockTmuxWithProcess("auggie-helper");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });
});

// =========================================================================
// detectActivity (terminal output parsing)
// =========================================================================
describe("detectActivity", () => {
  const agent = create();

  it("returns idle for empty output", () => {
    expect(agent.detectActivity("")).toBe("idle");
    expect(agent.detectActivity("   ")).toBe("idle");
  });

  it("returns idle when shell prompt is visible", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
    expect(agent.detectActivity("some output\n$ ")).toBe("idle");
    expect(agent.detectActivity("some output\n❯ ")).toBe("idle");
    expect(agent.detectActivity("some output\n› ")).toBe("idle");
  });

  it("returns idle when Auggie status bar is visible", () => {
    const auggieIdle = "›\n────\n ? to show shortcuts                                                 [Sonnet 4]\n                                             ~/Documents/Builds/Web/Make3dviwer\n\n";
    expect(agent.detectActivity(auggieIdle)).toBe("idle");
  });

  it("returns waiting_input for Auggie indexing prompt", () => {
    const indexPrompt = "Choose an option:\n\n     [1] Always index\n     [2] Never index\n\n Press 1/2/3/4 to select directly\n";
    expect(agent.detectActivity(indexPrompt)).toBe("waiting_input");
  });

  it("returns waiting_input for permission prompts", () => {
    expect(agent.detectActivity("Do you want to proceed?\n")).toBe("waiting_input");
    expect(agent.detectActivity("Continue? (Y)es / (N)o\n")).toBe("waiting_input");
    expect(agent.detectActivity("Allow? [y/n]\n")).toBe("waiting_input");
  });

  it("returns active for normal output", () => {
    expect(agent.detectActivity("Processing files...\n")).toBe("active");
    expect(agent.detectActivity("Reading codebase\nAnalyzing...\n")).toBe("active");
  });
});

// =========================================================================
// getActivityState (file-based detection)
// =========================================================================
describe("getActivityState", () => {
  const agent = create();

  it("returns exited when no runtime handle", async () => {
    const session = makeSession({ runtimeHandle: null });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
  });

  it("returns exited when process is not running", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("no tmux"));
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
  });

  it("returns active when last chat entry is not completed", async () => {
    mockTmuxWithProcess("auggie", "/dev/ttys001");
    const sessionContent = makeAuggieSessionJson({
      chatHistory: [
        {
          exchange: { request_message: "Fix bug", response_text: "" },
          completed: false,
          sequenceId: 1,
        },
      ],
    });
    mockSessionFiles([{ filename: "abc-123.json", content: sessionContent }]);

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("active");
  });

  it("returns ready when last chat entry is completed and recent", async () => {
    mockTmuxWithProcess("auggie", "/dev/ttys001");
    const sessionContent = makeAuggieSessionJson({
      modified: new Date().toISOString(),
      chatHistory: [
        {
          exchange: { request_message: "Fix bug", response_text: "Done" },
          completed: true,
          sequenceId: 1,
          finishedAt: new Date().toISOString(),
        },
      ],
    });
    mockSessionFiles([{ filename: "abc-123.json", content: sessionContent }]);

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("ready");
  });

  it("returns idle when last chat entry is completed and stale", async () => {
    mockTmuxWithProcess("auggie", "/dev/ttys001");
    const staleTime = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
    const sessionContent = makeAuggieSessionJson({
      modified: staleTime,
      chatHistory: [
        {
          exchange: { request_message: "Fix bug", response_text: "Done" },
          completed: true,
          sequenceId: 1,
          finishedAt: staleTime,
        },
      ],
    });
    mockSessionFiles([{ filename: "abc-123.json", content: sessionContent }]);

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("idle");
  });

  it("returns active when chat history is empty (just started)", async () => {
    mockTmuxWithProcess("auggie", "/dev/ttys001");
    const sessionContent = makeAuggieSessionJson({ chatHistory: [] });
    mockSessionFiles([{ filename: "abc-123.json", content: sessionContent }]);

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("active");
  });

  it("returns null when no matching session file found", async () => {
    mockTmuxWithProcess("auggie", "/dev/ttys001");
    // Session file has different TTY
    const sessionContent = makeAuggieSessionJson({ terminalId: "/dev/ttys999" });
    mockSessionFiles([{ filename: "abc-123.json", content: sessionContent }]);

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result).toBeNull();
  });

  it("returns null when sessions directory doesn't exist", async () => {
    mockTmuxWithProcess("auggie", "/dev/ttys001");
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result).toBeNull();
  });
});

// =========================================================================
// getSessionInfo
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("returns null when no runtime handle", async () => {
    const session = makeSession({ runtimeHandle: null });
    const result = await agent.getSessionInfo(session);
    expect(result).toBeNull();
  });

  it("returns customTitle as summary when available", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });
    const sessionContent = makeAuggieSessionJson({
      customTitle: "Fix auth bug",
      sessionId: "abc-123-def",
    });
    mockSessionFiles([{ filename: "abc-123-def.json", content: sessionContent }]);

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getSessionInfo(session);
    expect(result?.summary).toBe("Fix auth bug");
    expect(result?.agentSessionId).toBe("abc-123-def");
  });

  it("falls back to last response_text when no customTitle", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });
    const sessionContent = makeAuggieSessionJson({
      customTitle: undefined,
      chatHistory: [
        {
          exchange: {
            request_message: "Fix bug",
            response_text: "I fixed the null pointer exception",
          },
          completed: true,
          sequenceId: 1,
        },
      ],
    });
    mockSessionFiles([{ filename: "abc-123-def.json", content: sessionContent }]);

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getSessionInfo(session);
    expect(result?.summary).toBe("I fixed the null pointer exception");
  });

  it("truncates long response_text to 120 chars", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });
    const longText = "A".repeat(200);
    const sessionContent = makeAuggieSessionJson({
      customTitle: undefined,
      chatHistory: [
        {
          exchange: { request_message: "Fix", response_text: longText },
          completed: true,
          sequenceId: 1,
        },
      ],
    });
    mockSessionFiles([{ filename: "abc-123-def.json", content: sessionContent }]);

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getSessionInfo(session);
    expect(result?.summary?.length).toBe(123); // 120 + "..."
    expect(result?.summary?.endsWith("...")).toBe(true);
  });

  it("returns undefined cost when creditUsage is null", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });
    const sessionContent = makeAuggieSessionJson({
      creditUsage: null,
      subAgentCreditsUsed: 0,
    });
    mockSessionFiles([{ filename: "abc-123-def.json", content: sessionContent }]);

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getSessionInfo(session);
    expect(result?.cost).toBeUndefined();
  });
});

// =========================================================================
// getRestoreCommand
// =========================================================================
describe("getRestoreCommand", () => {
  const agent = create();
  const project = {
    name: "test",
    repo: "owner/repo",
    path: "/workspace/repo",
    defaultBranch: "main",
    sessionPrefix: "test",
  };

  it("returns auggie --resume <sessionId> when session found", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });
    const sessionContent = makeAuggieSessionJson({ sessionId: "my-session-uuid" });
    mockSessionFiles([{ filename: "my-session-uuid.json", content: sessionContent }]);

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getRestoreCommand(session, project);
    expect(result).toBe("auggie --resume 'my-session-uuid'");
  });

  it("returns null when no session found", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });
    mockSessionFiles([
      { filename: "other.json", content: makeAuggieSessionJson({ terminalId: "/dev/ttys999" }) },
    ]);

    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getRestoreCommand(session, project);
    expect(result).toBeNull();
  });

  it("returns null when no runtime handle", async () => {
    const session = makeSession({ runtimeHandle: null });
    const result = await agent.getRestoreCommand(session, project);
    expect(result).toBeNull();
  });
});

// =========================================================================
// setupWorkspaceHooks
// =========================================================================
describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("creates .augment directory and writes hook files", async () => {
    mockExistsSync.mockReturnValue(false);
    await agent.setupWorkspaceHooks("/workspace/repo", {
      sessionId: "sess-1",
      dataDir: "/data",
    });

    // Should create directory
    expect(mockMkdir).toHaveBeenCalledWith("/workspace/repo/.augment", { recursive: true });

    // Should write metadata-updater.sh
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/workspace/repo/.augment/metadata-updater.sh",
      expect.stringContaining("#!/usr/bin/env bash"),
      "utf-8",
    );

    // Should chmod the script
    expect(mockChmod).toHaveBeenCalledWith("/workspace/repo/.augment/metadata-updater.sh", 0o755);

    // Should write settings.local.json
  expect(mockWriteFile).toHaveBeenCalledWith(
      "/workspace/repo/.augment/settings.local.json",
      expect.stringContaining("PostToolUse"),
      "utf-8",
    );
  });

  it("merges with existing settings.local.json", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify({ existingKey: "value" }));

    await agent.setupWorkspaceHooks("/workspace/repo", {
      sessionId: "sess-1",
      dataDir: "/data",
    });

    // Should preserve existing keys
    const writeCall = mockWriteFile.mock.calls.find(
      (c: string[]) => typeof c[0] === "string" && c[0].endsWith("settings.local.json"),
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1] as string);
    expect(written.existingKey).toBe("value");
    expect(written.hooks.PostToolUse).toBeDefined();
  });
});