import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockExecFileAsync, mockStat, mockAccess, mockReadFile } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockStat: vi.fn(),
  mockAccess: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

vi.mock("node:fs/promises", () => ({
  stat: mockStat,
  access: mockAccess,
  readFile: mockReadFile,
}));

vi.mock("node:fs", () => ({
  constants: { R_OK: 4 },
}));

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
  mockStat.mockRejectedValue(new Error("ENOENT"));
  mockAccess.mockRejectedValue(new Error("ENOENT"));
  mockReadFile.mockRejectedValue(new Error("ENOENT"));
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

  it("returns idle for aider> prompt", () => {
    expect(agent.detectActivity("some output\naider>\n")).toBe("idle");
    expect(agent.detectActivity("some output\naider> ")).toBe("idle");
  });

  it("returns idle when prompt follows historical activity", () => {
    expect(agent.detectActivity("Editing files...\nDone.\n> ")).toBe("idle");
  });

  it("returns idle for Tokens: line (completion indicator)", () => {
    expect(agent.detectActivity("some output\nTokens: 1.2k sent, 3.4k received.\n")).toBe("idle");
  });

  it("returns idle for applied edit indicator", () => {
    expect(agent.detectActivity("Applied edit to src/index.ts\n")).toBe("idle");
  });

  it("returns idle for commit hash indicator", () => {
    expect(agent.detectActivity("commit abc1234 fix: update logic\n")).toBe("idle");
  });

  it("returns idle for Done on last line", () => {
    expect(agent.detectActivity("Processing...\nDone\n")).toBe("idle");
  });

  // -- Waiting input states --
  it("returns waiting_input for apply edit prompt", () => {
    expect(agent.detectActivity("Apply edit to src/main.ts?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for (y)es / (n)o prompt", () => {
    expect(agent.detectActivity("Proceed?\n(y)es / (n)o\n")).toBe("waiting_input");
  });

  it("returns waiting_input for (Y/n) prompt", () => {
    expect(agent.detectActivity("Create new file? (Y/n)\n")).toBe("waiting_input");
  });

  it("returns waiting_input for (y/n) prompt", () => {
    expect(agent.detectActivity("Overwrite? (y/n)\n")).toBe("waiting_input");
  });

  it("returns waiting_input for allow creation prompt", () => {
    expect(agent.detectActivity("Allow creation of new-file.ts?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for add to chat prompt", () => {
    expect(agent.detectActivity("Add src/utils.ts to the chat?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for drop from chat prompt", () => {
    expect(agent.detectActivity("Drop old-file.ts from the chat?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for create new file prompt", () => {
    expect(agent.detectActivity("Create a new file helpers.ts?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for run command prompt", () => {
    expect(agent.detectActivity("Run this command: npm test?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for commit change prompt", () => {
    expect(agent.detectActivity("Commit this change?\n")).toBe("waiting_input");
  });

  it("returns waiting_input when prompt follows historical activity", () => {
    expect(agent.detectActivity("Editing files...\nDone.\nAdd src/main.ts to the chat?\n")).toBe("waiting_input");
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

  it("returns blocked for context window exceeded", () => {
    expect(agent.detectActivity("Context window limit exceeded for model\n")).toBe("blocked");
  });

  it("returns blocked for 429 Too Many Requests", () => {
    expect(agent.detectActivity("HTTP 429 Too Many Requests\n")).toBe("blocked");
  });

  it("returns blocked for retrying message", () => {
    expect(agent.detectActivity("Retrying in 30 seconds...\n")).toBe("blocked");
  });

  it("returns blocked for model not found", () => {
    expect(agent.detectActivity("Model gpt-5 not found\n")).toBe("blocked");
  });

  it("returns blocked for unauthorized", () => {
    expect(agent.detectActivity("401 Unauthorized\n")).toBe("blocked");
  });

  // -- Active states --
  it("returns active for non-empty terminal output with no special patterns", () => {
    expect(agent.detectActivity("aider is processing files\n")).toBe("active");
  });

  it("returns active for editing output", () => {
    expect(agent.detectActivity("Editing src/index.ts...\n")).toBe("active");
  });

  // -- Priority order tests --
  it("idle prompt takes priority over blocked text higher in buffer", () => {
    expect(agent.detectActivity("rate limit hit\nretrying...\n> ")).toBe("idle");
  });

  it("waiting_input takes priority over blocked text higher in buffer", () => {
    expect(agent.detectActivity("Connection refused\nRetried.\nAdd file.ts to the chat?\n")).toBe("waiting_input");
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

  it("returns null when workspacePath is null", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("returns null when workspacePath is undefined", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: undefined }))).toBeNull();
  });

  it("returns null when chat history file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when chat history is empty", async () => {
    mockReadFile.mockResolvedValue("");
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("extracts summary from first user message", async () => {
    mockReadFile.mockResolvedValue(
      "#### Fix the login bug\n\nSure, I'll look at the login code...\n",
    );
    const result = await agent.getSessionInfo(makeSession());
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Fix the login bug");
    expect(result!.summaryIsFallback).toBe(true);
    expect(result!.agentSessionId).toBeNull();
  });

  it("truncates long summaries to 120 chars", async () => {
    const longMsg = "A".repeat(200);
    mockReadFile.mockResolvedValue(`#### ${longMsg}\n\nResponse...\n`);
    const result = await agent.getSessionInfo(makeSession());
    expect(result).not.toBeNull();
    expect(result!.summary!.length).toBeLessThanOrEqual(120);
    expect(result!.summary).toMatch(/\.\.\.$/); 
  });

  it("extracts token counts from Tokens: lines", async () => {
    mockReadFile.mockResolvedValue(
      "#### Fix bug\n\nDone.\n\nTokens: 1.2k sent, 3.4k received. Cost: $0.01 message, $0.05 session.\n",
    );
    const result = await agent.getSessionInfo(makeSession());
    expect(result).not.toBeNull();
    expect(result!.cost).toBeDefined();
    expect(result!.cost!.inputTokens).toBe(1200);
    expect(result!.cost!.outputTokens).toBe(3400);
    expect(result!.cost!.estimatedCostUsd).toBe(0.05);
  });

  it("aggregates multiple Tokens: lines", async () => {
    mockReadFile.mockResolvedValue(
      "#### Fix bug\n\nDone.\n\n" +
      "Tokens: 1k sent, 2k received.\n" +
      "#### Another task\n\n" +
      "Tokens: 3k sent, 4k received. Cost: $0.10 message, $0.20 session.\n",
    );
    const result = await agent.getSessionInfo(makeSession());
    expect(result).not.toBeNull();
    expect(result!.cost!.inputTokens).toBe(4000);
    expect(result!.cost!.outputTokens).toBe(6000);
    // Should use the last session cost
    expect(result!.cost!.estimatedCostUsd).toBe(0.20);
  });

  it("returns undefined cost when no Tokens: lines present", async () => {
    mockReadFile.mockResolvedValue(
      "#### Fix the bug\n\nI fixed it.\n",
    );
    const result = await agent.getSessionInfo(makeSession());
    expect(result).not.toBeNull();
    expect(result!.cost).toBeUndefined();
  });

  it("handles plain numeric tokens (no k suffix)", async () => {
    mockReadFile.mockResolvedValue(
      "#### Fix\n\nTokens: 12,345 sent, 67,890 received.\n",
    );
    const result = await agent.getSessionInfo(makeSession());
    expect(result).not.toBeNull();
    expect(result!.cost!.inputTokens).toBe(12345);
    expect(result!.cost!.outputTokens).toBe(67890);
    // Fallback cost estimate (no $session line)
    expect(result!.cost!.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("handles chat history with only whitespace content", async () => {
    mockReadFile.mockResolvedValue("   \n  \n  ");
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns summary with no user message match", async () => {
    mockReadFile.mockResolvedValue("Some random content without headers\n");
    const result = await agent.getSessionInfo(makeSession());
    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
  });
});
