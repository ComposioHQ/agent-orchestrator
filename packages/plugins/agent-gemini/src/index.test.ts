import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig, WorkspaceHooksConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
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
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockChmod: vi.fn().mockResolvedValue(undefined),
  mockExistsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return {
    execFile: fn,
    execFileSync: vi.fn(),
    // spawnSync is used for `which gemini` binary resolution at create() time.
    // Return empty stdout so the plugin falls back to "gemini" in tests.
    spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
  };
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

import {
  create,
  manifest,
  default as defaultExport,
  resetPsCache,
  resetSessionFileCache,
  getGeminiProjectHash,
  getGeminiChatsDir,
  METADATA_UPDATER_SCRIPT,
} from "./index.js";

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
    workspacePath: "/workspace/test-project",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeTmuxHandle(id = "ao-session"): RuntimeHandle {
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

function makeHooksConfig(overrides: Partial<WorkspaceHooksConfig> = {}): WorkspaceHooksConfig {
  return { dataDir: "/mock/home/.ao/sessions/abc", ...overrides };
}

function makeTmuxMock(processLine = "12345 ttys001  gemini") {
  mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
    }
    if (cmd === "ps") {
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n  ${processLine}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error(`Unexpected command: ${cmd}`));
  });
}

function makeSessionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sessionId: "gemini-session-uuid-1",
    projectHash: "abc123",
    startTime: new Date(Date.now() - 60_000).toISOString(),
    lastUpdated: new Date(Date.now() - 10_000).toISOString(),
    messages: [
      { type: "user", content: [{ text: "Fix the login bug" }] },
      {
        type: "gemini",
        content: [{ text: "I'll fix that." }],
        tokens: { input: 100, output: 50, cached: 0, total: 150 },
      },
    ],
    ...overrides,
  });
}

function mockChatsDir(
  files: string[],
  sessionJson: string,
  mtime = new Date(Date.now() - 10_000),
) {
  mockReaddir.mockResolvedValue(files);
  mockStat.mockResolvedValue({ mtime, mtimeMs: mtime.getTime() });
  mockReadFile.mockResolvedValue(sessionJson);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPsCache();
  resetSessionFileCache();
  mockHomedir.mockReturnValue("/mock/home");
});

// =============================================================================
// Manifest & Exports
// =============================================================================
describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "gemini",
      slot: "agent",
      description: "Agent plugin: Google Gemini CLI",
      version: "0.1.0",
      displayName: "Google Gemini CLI",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("gemini");
    expect(agent.processName).toBe("gemini");
  });

  it("promptDelivery is post-launch so Gemini stays interactive in tmux", () => {
    const agent = create();
    expect(agent.promptDelivery).toBe("post-launch");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
    expect(typeof defaultExport.detect).toBe("function");
  });
});

// =============================================================================
// getGeminiProjectHash
// =============================================================================
describe("getGeminiProjectHash", () => {
  it("returns a 64-char hex SHA-256 string", () => {
    expect(getGeminiProjectHash("/some/project")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(getGeminiProjectHash("/foo/bar")).toBe(getGeminiProjectHash("/foo/bar"));
  });

  it("differs for different inputs", () => {
    expect(getGeminiProjectHash("/project/a")).not.toBe(getGeminiProjectHash("/project/b"));
  });
});

// =============================================================================
// getGeminiChatsDir
// =============================================================================
describe("getGeminiChatsDir", () => {
  it("builds path using homedir and SHA-256 hash", () => {
    const hash = getGeminiProjectHash("/workspace/test-project");
    expect(getGeminiChatsDir("/workspace/test-project")).toBe(
      `/mock/home/.gemini/tmp/${hash}/chats`,
    );
  });
});

// =============================================================================
// getLaunchCommand
// =============================================================================
describe("getLaunchCommand", () => {
  const agent = create();

  it("generates base command (no flags when nothing configured)", () => {
    // spawnSync mock returns empty stdout, so binary falls back to "gemini" (quoted by shellEscape)
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("'gemini'");
  });

  it("does NOT include prompt even if provided (post-launch delivery)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).not.toContain("Fix the bug");
    expect(cmd).not.toContain("-p");
  });

  it("adds --approval-mode=yolo for permissionless", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--approval-mode=yolo");
  });

  it("adds --approval-mode=yolo for auto-edit", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "auto-edit" }));
    expect(cmd).toContain("--approval-mode=yolo");
  });

  it("treats legacy permissions=skip as permissionless", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip" as unknown as AgentLaunchConfig["permissions"] }),
    );
    expect(cmd).toContain("--approval-mode=yolo");
  });

  it("does not add --approval-mode for default permissions", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "default" }));
    expect(cmd).not.toContain("--approval-mode");
  });

  it("adds --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gemini-2.5-pro" }));
    expect(cmd).toContain("--model 'gemini-2.5-pro'");
  });

  it("adds --system-prompt from systemPrompt field", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPrompt: "Be concise" }));
    expect(cmd).toContain("--system-prompt");
    expect(cmd).toContain("Be concise");
  });

  it("adds --system-prompt with cat substitution from systemPromptFile", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "/path/to/prompt.md" }),
    );
    expect(cmd).toContain("--system-prompt");
    expect(cmd).toContain("cat");
    expect(cmd).toContain("/path/to/prompt.md");
  });

  it("combines all options except prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "permissionless", model: "flash", prompt: "Fix" }),
    );
    expect(cmd).toBe("'gemini' --approval-mode=yolo --model 'flash'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--approval-mode");
    expect(cmd).not.toContain("--system-prompt");
  });
});

// =============================================================================
// getEnvironment
// =============================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID", () => {
    expect(agent.getEnvironment(makeLaunchConfig())["AO_SESSION_ID"]).toBe("sess-1");
  });

  it("sets AO_ISSUE_ID when provided", () => {
    expect(agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" }))["AO_ISSUE_ID"]).toBe("GH-42");
  });

  it("omits AO_ISSUE_ID when not provided", () => {
    expect(agent.getEnvironment(makeLaunchConfig())["AO_ISSUE_ID"]).toBeUndefined();
  });
});

// =============================================================================
// detectActivity (terminal output classification)
// =============================================================================
describe("detectActivity", () => {
  const agent = create();

  it("returns idle for empty output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns idle for whitespace-only output", () => {
    expect(agent.detectActivity("   \n")).toBe("idle");
  });

  it("returns idle when REPL prompt (❯) is last line", () => {
    expect(agent.detectActivity("some output\ngemini ❯ ")).toBe("idle");
    expect(agent.detectActivity("some output\n❯ ")).toBe("idle");
  });

  it("returns waiting_input on permission prompt", () => {
    expect(agent.detectActivity("Do you want to proceed?\n")).toBe("waiting_input");
    expect(agent.detectActivity("(yes) (no)\n")).toBe("waiting_input");
  });

  it("returns blocked on error lines", () => {
    expect(agent.detectActivity("Error: API request failed\n")).toBe("blocked");
  });

  it("returns active for generic non-empty output", () => {
    expect(agent.detectActivity("Thinking about the problem…\n")).toBe("active");
  });
});

// =============================================================================
// isProcessRunning
// =============================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when gemini found on tmux pane TTY", async () => {
    makeTmuxMock("12345 ttys001  gemini");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when gemini not on tmux pane TTY", async () => {
    makeTmuxMock("12345 ttys001  zsh");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("does not false-positive on gemini-wrapper (word boundary)", async () => {
    makeTmuxMock("12345 ttys001  gemini-wrapper --foo");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("matches gemini by full path", async () => {
    makeTmuxMock("12345 ttys001  /usr/local/bin/gemini --approval-mode=yolo");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns true for alive PID via process handle", async () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(1234))).toBe(true);
    expect(spy).toHaveBeenCalledWith(1234, 0);
    spy.mockRestore();
  });

  it("returns false for dead PID", async () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(1234))).toBe(false);
    spy.mockRestore();
  });

  it("returns true on EPERM (process exists, no signal permission)", async () => {
    const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const spy = vi.spyOn(process, "kill").mockImplementation(() => { throw err; });
    expect(await agent.isProcessRunning(makeProcessHandle(999))).toBe(true);
    spy.mockRestore();
  });

  it("returns false for unknown runtime without PID", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
  });

  it("returns false on tmux failure", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux gone"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });
});

// =============================================================================
// getActivityState
// =============================================================================
describe("getActivityState", () => {
  const agent = create();

  it("returns exited when no runtimeHandle", async () => {
    expect((await agent.getActivityState(makeSession({ runtimeHandle: null })))?.state).toBe("exited");
  });

  it("returns exited when process not running", async () => {
    makeTmuxMock("12345 ttys001  zsh");
    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result?.state).toBe("exited");
  });

  it("returns null when no chats dir exists", async () => {
    makeTmuxMock();
    mockReaddir.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    expect(await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }))).toBeNull();
  });

  it("returns null when no session files exist", async () => {
    makeTmuxMock();
    mockReaddir.mockResolvedValue([]);
    expect(await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }))).toBeNull();
  });

  it("returns active when lastUpdated is within 30s", async () => {
    makeTmuxMock();
    const t = new Date(Date.now() - 5_000);
    mockChatsDir(["session-abc.json"], makeSessionJson({ lastUpdated: t.toISOString() }), t);
    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result?.state).toBe("active");
  });

  it("returns ready when lastUpdated is between 30s and threshold", async () => {
    makeTmuxMock();
    const t = new Date(Date.now() - 60_000);
    mockChatsDir(["session-abc.json"], makeSessionJson({ lastUpdated: t.toISOString() }), t);
    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }), 300_000);
    expect(result?.state).toBe("ready");
  });

  it("returns idle when lastUpdated is beyond threshold", async () => {
    makeTmuxMock();
    const t = new Date(Date.now() - 400_000);
    mockChatsDir(["session-abc.json"], makeSessionJson({ lastUpdated: t.toISOString() }), t);
    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }), 300_000);
    expect(result?.state).toBe("idle");
  });

  it("falls back to file mtime when lastUpdated is missing", async () => {
    makeTmuxMock();
    const mtime = new Date(Date.now() - 5_000);
    mockChatsDir(["session-abc.json"], makeSessionJson({ lastUpdated: undefined }), mtime);
    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result?.state).toBe("active");
  });

  it("returns null when workspacePath is missing", async () => {
    makeTmuxMock();
    expect(
      await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: null })),
    ).toBeNull();
  });

  it("uses cached session file on second call within TTL", async () => {
    makeTmuxMock();
    const t = new Date(Date.now() - 5_000);
    mockChatsDir(["session-abc.json"], makeSessionJson({ lastUpdated: t.toISOString() }), t);
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    await agent.getActivityState(session);
    await agent.getActivityState(session);
    // readdir should only be called once — second call hits cache
    expect(mockReaddir).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// getSessionInfo
// =============================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("returns null when no workspacePath", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("returns null when chats dir is missing", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when no session files exist", async () => {
    mockReaddir.mockResolvedValue([]);
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("extracts sessionId as agentSessionId", async () => {
    mockChatsDir(["session-abc.json"], makeSessionJson({ sessionId: "my-uuid-123" }));
    expect((await agent.getSessionInfo(makeSession()))?.agentSessionId).toBe("my-uuid-123");
  });

  it("uses auto-generated summary when present", async () => {
    mockChatsDir(["session-abc.json"], makeSessionJson({ summary: "Fixed the auth bug" }));
    const info = await agent.getSessionInfo(makeSession());
    expect(info?.summary).toBe("Fixed the auth bug");
    expect(info?.summaryIsFallback).toBe(false);
  });

  it("falls back to first user message when no summary", async () => {
    mockChatsDir(["session-abc.json"], makeSessionJson({ summary: undefined }));
    const info = await agent.getSessionInfo(makeSession());
    expect(info?.summary).toBe("Fix the login bug");
    expect(info?.summaryIsFallback).toBe(true);
  });

  it("truncates long fallback summary to 120 chars + ...", async () => {
    const long = "a".repeat(200);
    mockChatsDir(
      ["session-abc.json"],
      makeSessionJson({ summary: undefined, messages: [{ type: "user", content: [{ text: long }] }] }),
    );
    const info = await agent.getSessionInfo(makeSession());
    expect(info?.summary).toHaveLength(123);
    expect(info?.summary?.endsWith("...")).toBe(true);
  });

  it("extracts token counts and cost from gemini messages", async () => {
    mockChatsDir(["session-abc.json"], makeSessionJson());
    const info = await agent.getSessionInfo(makeSession());
    expect(info?.cost?.inputTokens).toBe(100);
    expect(info?.cost?.outputTokens).toBe(50);
    expect(info?.cost?.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("returns undefined cost when no token data", async () => {
    mockChatsDir(
      ["session-abc.json"],
      makeSessionJson({ messages: [{ type: "user", content: "hello" }, { type: "gemini", content: "world" }] }),
    );
    expect((await agent.getSessionInfo(makeSession()))?.cost).toBeUndefined();
  });

  it("picks most recently modified session file", async () => {
    const older = new Date(Date.now() - 120_000);
    const newer = new Date(Date.now() - 5_000);
    mockReaddir.mockResolvedValue(["session-old.json", "session-new.json"]);
    mockStat
      .mockResolvedValueOnce({ mtime: older, mtimeMs: older.getTime() })
      .mockResolvedValueOnce({ mtime: newer, mtimeMs: newer.getTime() });
    mockReadFile.mockResolvedValue(makeSessionJson({ sessionId: "newest" }));
    expect((await agent.getSessionInfo(makeSession()))?.agentSessionId).toBe("newest");
  });
});

// =============================================================================
// getRestoreCommand
// =============================================================================
describe("getRestoreCommand", () => {
  const agent = create();
  const project = makeLaunchConfig().projectConfig;

  it("returns null when no agentSessionId", async () => {
    expect(await agent.getRestoreCommand!(makeSession({ agentInfo: null }), project)).toBeNull();
  });

  it("returns gemini --resume <id>", async () => {
    const session = makeSession({ agentInfo: { summary: "Fix bug", agentSessionId: "abc-123" } });
    const cmd = await agent.getRestoreCommand!(session, project);
    expect(cmd).toBe("'gemini' --resume 'abc-123'");
  });

  it("shell-escapes session IDs with spaces", async () => {
    const session = makeSession({ agentInfo: { summary: "x", agentSessionId: "id with space" } });
    const cmd = await agent.getRestoreCommand!(session, project);
    expect(cmd).toContain("--resume");
    expect(cmd).toContain("id with space");
  });

  it("does not include -p (AO sends prompt post-launch via sendMessage)", async () => {
    const session = makeSession({ agentInfo: { summary: "x", agentSessionId: "abc" } });
    const cmd = await agent.getRestoreCommand!(session, project);
    expect(cmd).not.toContain("-p");
  });
});

// =============================================================================
// setupWorkspaceHooks
// =============================================================================
describe("setupWorkspaceHooks", () => {
  const agent = create();
  const config = makeHooksConfig();

  it("creates .gemini directory", async () => {
    mockExistsSync.mockReturnValue(false);
    await agent.setupWorkspaceHooks!("/workspace/test", config);
    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining(".gemini"), { recursive: true });
  });

  it("writes the hook script", async () => {
    mockExistsSync.mockReturnValue(false);
    await agent.setupWorkspaceHooks!("/workspace/test", config);
    const call = mockWriteFile.mock.calls.find((c) => String(c[0]).endsWith("ao-metadata-updater.sh"));
    expect(call).toBeDefined();
    expect(call?.[1]).toBe(METADATA_UPDATER_SCRIPT);
  });

  it("makes the hook script executable (0o755)", async () => {
    mockExistsSync.mockReturnValue(false);
    await agent.setupWorkspaceHooks!("/workspace/test", config);
    expect(mockChmod).toHaveBeenCalledWith(expect.stringContaining("ao-metadata-updater.sh"), 0o755);
  });

  it("writes AfterTool hook to .gemini/settings.json", async () => {
    mockExistsSync.mockReturnValue(false);
    await agent.setupWorkspaceHooks!("/workspace/test", config);
    const settingsCall = mockWriteFile.mock.calls.find((c) => String(c[0]).endsWith("settings.json"));
    expect(settingsCall).toBeDefined();
    const written = JSON.parse(String(settingsCall?.[1]));
    expect(Array.isArray(written.hooks?.AfterTool)).toBe(true);
    const entry = written.hooks.AfterTool[0];
    expect(entry.matcher).toBe("run_shell_command");
    expect(entry.hooks[0].name).toBe("ao-metadata-updater");
    expect(entry.hooks[0].type).toBe("command");
  });

  it("merges into existing settings without clobbering other keys", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify({ theme: "dark", autoUpdate: false }));
    await agent.setupWorkspaceHooks!("/workspace/test", config);
    const settingsCall = mockWriteFile.mock.calls.find((c) => String(c[0]).endsWith("settings.json"));
    const written = JSON.parse(String(settingsCall?.[1]));
    expect(written.theme).toBe("dark");
    expect(written.autoUpdate).toBe(false);
    expect(written.hooks?.AfterTool).toBeDefined();
  });

  it("does not duplicate ao-metadata-updater hook on repeated calls", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        hooks: {
          AfterTool: [
            {
              matcher: "run_shell_command",
              hooks: [{ type: "command", name: "ao-metadata-updater", command: "/old/path.sh" }],
            },
          ],
        },
      }),
    );
    await agent.setupWorkspaceHooks!("/workspace/test", config);
    const settingsCall = mockWriteFile.mock.calls.find((c) => String(c[0]).endsWith("settings.json"));
    const written = JSON.parse(String(settingsCall?.[1]));
    expect(written.hooks.AfterTool).toHaveLength(1);
  });

  it("pre-trusts the hook in trusted_hooks.json to skip warning dialog", async () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFile.mockRejectedValue(new Error("ENOENT")); // no existing trusted_hooks.json
    await agent.setupWorkspaceHooks!("/workspace/test", config);
    const trustedCall = mockWriteFile.mock.calls.find((c) =>
      String(c[0]).endsWith("trusted_hooks.json"),
    );
    expect(trustedCall).toBeDefined();
    const written = JSON.parse(String(trustedCall?.[1]));
    expect(written["/workspace/test"]).toContain(
      "ao-metadata-updater:.gemini/ao-metadata-updater.sh",
    );
  });

  it("does not duplicate entry in trusted_hooks.json on repeated calls", async () => {
    mockExistsSync.mockReturnValue(false);
    // Existing trusted_hooks.json already has the entry
    mockReadFile.mockImplementation((path: unknown) => {
      if (String(path).endsWith("trusted_hooks.json")) {
        return Promise.resolve(
          JSON.stringify({
            "/workspace/test": ["ao-metadata-updater:.gemini/ao-metadata-updater.sh"],
          }),
        );
      }
      return Promise.reject(new Error("ENOENT"));
    });
    await agent.setupWorkspaceHooks!("/workspace/test", config);
    const trustedCalls = mockWriteFile.mock.calls.filter((c) =>
      String(c[0]).endsWith("trusted_hooks.json"),
    );
    // Should NOT write trusted_hooks.json again since entry already exists
    expect(trustedCalls).toHaveLength(0);
  });
});

// =============================================================================
// METADATA_UPDATER_SCRIPT content sanity checks
// =============================================================================
describe("METADATA_UPDATER_SCRIPT", () => {
  it("is a valid bash script", () => {
    expect(METADATA_UPDATER_SCRIPT).toContain("#!/usr/bin/env bash");
  });

  it("only processes run_shell_command tool calls", () => {
    expect(METADATA_UPDATER_SCRIPT).toContain("run_shell_command");
  });

  it("handles gh pr create detection", () => {
    expect(METADATA_UPDATER_SCRIPT).toContain("gh pr create");
  });

  it("handles git checkout -b detection", () => {
    expect(METADATA_UPDATER_SCRIPT).toContain("git checkout");
  });

  it("handles gh pr merge detection", () => {
    expect(METADATA_UPDATER_SCRIPT).toContain("gh pr merge");
  });

  it("validates AO_SESSION against path traversal", () => {
    expect(METADATA_UPDATER_SCRIPT).toContain("*..*");
  });
});

// =============================================================================
// postLaunchSetup
// =============================================================================
describe("postLaunchSetup", () => {
  const agent = create();
  const tmuxHandle: RuntimeHandle = { id: "tmux-session-abc", runtimeName: "tmux", data: {} };

  beforeEach(() => {
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(false);
  });

  it("has postLaunchSetup method", () => {
    expect(typeof agent.postLaunchSetup).toBe("function");
  });

  it("writes hooks when workspacePath is set", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "gemini ❯ ", stderr: "" });
    const session = makeSession({ workspacePath: "/workspace/proj", runtimeHandle: tmuxHandle });
    await agent.postLaunchSetup!(session);
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/workspace/proj/.gemini/ao-metadata-updater.sh",
      METADATA_UPDATER_SCRIPT,
      "utf-8",
    );
  });

  it("skips hook writing when workspacePath is null", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "❯ ", stderr: "" });
    const session = makeSession({ workspacePath: null, runtimeHandle: null });
    await agent.postLaunchSetup!(session);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("returns immediately when runtimeHandle is null", async () => {
    const session = makeSession({ workspacePath: "/workspace/proj", runtimeHandle: null });
    await agent.postLaunchSetup!(session);
    // Should not call tmux at all (execFileAsync for tmux capture-pane)
    const tmuxCalls = mockExecFileAsync.mock.calls.filter((c) => String(c[0]) === "tmux");
    expect(tmuxCalls).toHaveLength(0);
  });

  it("stops polling when REPL prompt (❯) is detected", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "Welcome to Gemini\ngemini ❯ ", stderr: "" });
    const session = makeSession({ workspacePath: "/workspace/proj", runtimeHandle: tmuxHandle });
    await agent.postLaunchSetup!(session);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "tmux",
      ["capture-pane", "-p", "-t", "tmux-session-abc"],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it("stops polling when > prompt is detected", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "some output\n> ", stderr: "" });
    const session = makeSession({ workspacePath: "/workspace/proj", runtimeHandle: tmuxHandle });
    await agent.postLaunchSetup!(session);
    // Should return after first successful tmux capture showing ">"
    const tmuxCalls = mockExecFileAsync.mock.calls.filter(
      (c) => String(c[0]) === "tmux" && String(c[1][0]) === "capture-pane",
    );
    expect(tmuxCalls.length).toBeGreaterThan(0);
  });

  it("returns early when guard message detected in output", async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: "gemini guard: Gemini CLI is not installed here",
      stderr: "",
    });
    const session = makeSession({ workspacePath: "/workspace/proj", runtimeHandle: tmuxHandle });
    await agent.postLaunchSetup!(session);
    // Should have stopped after first poll finding guard message
    const tmuxCalls = mockExecFileAsync.mock.calls.filter(
      (c) => String(c[0]) === "tmux" && String(c[1][0]) === "capture-pane",
    );
    expect(tmuxCalls).toHaveLength(1);
  });

  it("returns early when tmux command fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux: no server running"));
    const session = makeSession({ workspacePath: "/workspace/proj", runtimeHandle: tmuxHandle });
    // Should not throw
    await expect(agent.postLaunchSetup!(session)).resolves.toBeUndefined();
  });

  it("uses relative path for hook script in settings.json", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "gemini ❯ ", stderr: "" });
    const session = makeSession({ workspacePath: "/workspace/proj", runtimeHandle: tmuxHandle });
    await agent.postLaunchSetup!(session);
    const settingsCall = mockWriteFile.mock.calls.find((c) => String(c[0]).endsWith("settings.json"));
    const written = JSON.parse(String(settingsCall?.[1]));
    const hookCommand = written.hooks.AfterTool[0].hooks[0].command;
    expect(hookCommand).toBe(".gemini/ao-metadata-updater.sh");
    expect(hookCommand).not.toMatch(/^\//);
  });
});
