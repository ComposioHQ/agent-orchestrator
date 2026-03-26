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

function makeProcessHandle(pid?: number): RuntimeHandle {
  return {
    id: "proc-1",
    runtimeName: "process",
    data: pid !== undefined ? { pid } : {},
  };
}

function makeLaunchConfig(
  overrides: Partial<AgentLaunchConfig> = {},
): AgentLaunchConfig {
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
    if (cmd === "tmux")
      return Promise.resolve({ stdout: "/dev/ttys005\n", stderr: "" });
    if (cmd === "ps") {
      const line = found
        ? `  444 ttys005  ${processName}`
        : "  444 ttys005  zsh";
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
    expect(agent.processName).toBe("cursor-agent");
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

  it("generates base command with workspace", () => {
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe(
      "'cursor-agent' --workspace '/workspace/repo'",
    );
  });

  it("includes --mode plan when permissions=suggest", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "suggest" }),
    );
    expect(cmd).toContain("--mode plan");
  });

  it("includes --force for permissionless", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "permissionless" }),
    );
    expect(cmd).toContain("--force");
  });

  it("includes --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ model: "claude-sonnet-4-5-20250929" }),
    );
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929'");
  });

  it("includes inline prompt as positional argument", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "Fix the tests" }),
    );
    expect(cmd).toContain("'Fix the tests'");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        permissions: "suggest",
        model: "gpt-4o",
        prompt: "Go",
      }),
    );
    expect(cmd).toBe(
      "'cursor-agent' --workspace '/workspace/repo' --mode plan --model 'gpt-4o' 'Go'",
    );
  });

  it("escapes single quotes in prompt (POSIX shell escaping)", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "it's broken" }),
    );
    expect(cmd).toContain("'it'\\''s broken'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--mode");
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--prompt");
  });

  it("combines systemPrompt with prompt into a single initial message", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPrompt: "You are a helpful engineer",
        prompt: "Fix the bug",
      }),
    );
    expect(cmd).toContain("'You are a helpful engineer\n\nFix the bug'");
  });

  it("prefers systemPromptFile over inline systemPrompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPrompt: "inline",
        systemPromptFile: "/tmp/prompt.txt",
        prompt: "do the task",
      }),
    );
    expect(cmd).toContain("$(cat '/tmp/prompt.txt'; printf '\\n\\n'; printf %s 'do the task')");
    expect(cmd).not.toContain("'inline'");
  });

  it("treats legacy permissions=skip as permissionless", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        permissions: "skip" as unknown as AgentLaunchConfig["permissions"],
      }),
    );
    expect(cmd).toContain("--force");
  });

  it("includes --force for auto-edit", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "auto-edit" }),
    );
    expect(cmd).toContain("--force");
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
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "LIN-99" }));
    expect(env["AO_ISSUE_ID"]).toBe("LIN-99");
  });

  it("omits AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });

  it("passes through CURSOR_API_KEY from parent env", () => {
    const original = process.env["CURSOR_API_KEY"];
    try {
      process.env["CURSOR_API_KEY"] = "test-key-123";
      const env = agent.getEnvironment(makeLaunchConfig());
      expect(env["CURSOR_API_KEY"]).toBe("test-key-123");
    } finally {
      if (original === undefined) {
        delete process.env["CURSOR_API_KEY"];
      } else {
        process.env["CURSOR_API_KEY"] = original;
      }
    }
  });

  it("passes through CURSOR_AUTH_TOKEN from parent env", () => {
    const original = process.env["CURSOR_AUTH_TOKEN"];
    try {
      process.env["CURSOR_AUTH_TOKEN"] = "auth-token-456";
      const env = agent.getEnvironment(makeLaunchConfig());
      expect(env["CURSOR_AUTH_TOKEN"]).toBe("auth-token-456");
    } finally {
      if (original === undefined) {
        delete process.env["CURSOR_AUTH_TOKEN"];
      } else {
        process.env["CURSOR_AUTH_TOKEN"] = original;
      }
    }
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when cursor found on tmux pane TTY", async () => {
    mockTmuxWithProcess("cursor-agent");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns true when cursor wrapper command found on tmux pane", async () => {
    mockTmuxWithProcess("cursor agent --prompt hello");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when cursor not on tmux pane TTY", async () => {
    mockTmuxWithProcess("cursor-agent", false);
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

  it("finds cursor on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({
          stdout: "/dev/ttys001\n/dev/ttys002\n",
          stderr: "",
        });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout:
            "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  cursor agent --prompt fix\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("finds cursor-agent on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({
          stdout: "/dev/ttys001\n/dev/ttys002\n",
          stderr: "",
        });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout:
            "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  cursor-agent --workspace /tmp/repo\n",
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
    expect(agent.detectActivity("cursor is processing files\n")).toBe(
      "active",
    );
  });

  it("returns idle when showing input prompt", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
  });

  it("returns waiting_input for permission prompts", () => {
    expect(
      agent.detectActivity("Editing file.ts\nPermission required to write"),
    ).toBe("waiting_input");
  });

  it("returns waiting_input for yes/no prompts", () => {
    expect(
      agent.detectActivity("Apply changes?\n(y)es / (n)o"),
    ).toBe("waiting_input");
  });

  it("returns waiting_input for allow/deny prompts", () => {
    expect(
      agent.detectActivity("File access requested\nAllow or Deny?"),
    ).toBe("waiting_input");
  });
});

// =========================================================================
// getSessionInfo
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("always returns null (not yet implemented)", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
    expect(
      await agent.getSessionInfo(makeSession({ workspacePath: "/some/path" })),
    ).toBeNull();
  });
});
