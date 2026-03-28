import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockExecFileAsync, mockReadFile } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readFile: mockReadFile,
  };
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
      name: "aider",
      slot: "agent",
      description: "Agent plugin: Aider",
      version: "0.1.0",
      displayName: "Aider",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("aider");
    expect(agent.processName).toBe("aider");
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
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("aider");
  });

  it("includes --yes when permissions=permissionless", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--yes");
  });

  it("treats legacy permissions=skip as permissionless", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip" as unknown as AgentLaunchConfig["permissions"] }),
    );
    expect(cmd).toContain("--yes");
  });

  it("maps permissions=auto-edit to no-prompt mode on Aider", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "auto-edit" }));
    expect(cmd).toContain("--yes");
  });

  it("includes --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4o" }));
    expect(cmd).toContain("--model 'gpt-4o'");
  });

  it("includes --message with shell-escaped prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the tests" }));
    expect(cmd).toContain("--message 'Fix the tests'");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "permissionless", model: "sonnet", prompt: "Go" }),
    );
    expect(cmd).toBe("aider --yes --model 'sonnet' --message 'Go'");
  });

  it("escapes single quotes in prompt (POSIX shell escaping)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's broken" }));
    expect(cmd).toContain("--message 'it'\\''s broken'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--yes");
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--message");
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

  it("returns true when aider found on tmux pane TTY", async () => {
    mockTmuxWithProcess("aider");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when aider not on tmux pane TTY", async () => {
    mockTmuxWithProcess("aider", false);
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

  it("finds aider on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  aider --yes\n",
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

  it("returns active for non-empty terminal output", () => {
    expect(agent.detectActivity("aider is processing files\n")).toBe("active");
  });

  it("returns ready when aider prompt is shown", () => {
    expect(agent.detectActivity("some output\naider > ")).toBe("ready");
  });

  it("returns ready for bare > prompt", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("ready");
  });

  it("returns waiting_input for Y/N confirmation", () => {
    expect(agent.detectActivity("Allow edits to src/index.ts?\n(Y)es/(N)o")).toBe("waiting_input");
  });

  it("returns waiting_input for add-to-chat prompt", () => {
    expect(agent.detectActivity("Add src/utils.ts to the chat?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for create new file prompt", () => {
    expect(agent.detectActivity("Create new file src/new.ts?\n")).toBe("waiting_input");
  });

  it("returns blocked for error lines", () => {
    expect(agent.detectActivity("Error: file not found\n")).toBe("blocked");
  });

  it("returns blocked for API errors", () => {
    expect(agent.detectActivity("Processing...\nAPI Error: rate limited\n")).toBe("blocked");
  });

  it("returns blocked for rate limit messages", () => {
    expect(agent.detectActivity("Waiting...\nrate limit exceeded\n")).toBe("blocked");
  });
});

// =========================================================================
// getSessionInfo
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("returns null when workspacePath is missing", async () => {
    const result = await agent.getSessionInfo(makeSession({ workspacePath: null }));
    expect(result).toBeNull();
  });

  it("returns null summary when chat history file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const result = await agent.getSessionInfo(makeSession());
    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
    expect(result!.summaryIsFallback).toBe(false);
    expect(result!.agentSessionId).toBeNull();
  });

  it("extracts summary from last assistant message", async () => {
    mockReadFile.mockResolvedValue(
      "#### user\nFix the login bug\n\n#### assistant\nI'll fix the authentication issue in login.ts by updating the token validation logic.\n",
    );
    const result = await agent.getSessionInfo(makeSession());
    expect(result!.summary).toBe(
      "I'll fix the authentication issue in login.ts by updating the token validation logic.",
    );
    expect(result!.summaryIsFallback).toBe(false);
  });

  it("falls back to first user message when no assistant response", async () => {
    mockReadFile.mockResolvedValue("#### user\nPlease refactor the database module\n");
    const result = await agent.getSessionInfo(makeSession());
    expect(result!.summary).toBe("Please refactor the database module");
    expect(result!.summaryIsFallback).toBe(true);
  });

  it("returns null summary for empty chat history", async () => {
    mockReadFile.mockResolvedValue("");
    const result = await agent.getSessionInfo(makeSession());
    expect(result!.summary).toBeNull();
  });

  it("handles multiple assistant messages (uses last one)", async () => {
    mockReadFile.mockResolvedValue(
      "#### user\nFirst task\n\n#### assistant\nDone with first task.\n\n#### user\nSecond task\n\n#### assistant\nCompleted the refactoring of utils.ts.\n",
    );
    const result = await agent.getSessionInfo(makeSession());
    expect(result!.summary).toBe("Completed the refactoring of utils.ts.");
    expect(result!.summaryIsFallback).toBe(false);
  });

  it("skips code blocks in assistant messages", async () => {
    mockReadFile.mockResolvedValue(
      "#### user\nFix it\n\n#### assistant\n```python\ndef fix():\n  pass\n```\nHere is the fix for the issue.\n",
    );
    const result = await agent.getSessionInfo(makeSession());
    expect(result!.summary).toBe("Here is the fix for the issue.");
    expect(result!.summaryIsFallback).toBe(false);
  });

  it("truncates long summaries to 120 characters", async () => {
    const longMessage = "A".repeat(200);
    mockReadFile.mockResolvedValue(`#### user\nDo something\n\n#### assistant\n${longMessage}\n`);
    const result = await agent.getSessionInfo(makeSession());
    expect(result!.summary!.length).toBe(120);
  });
});
