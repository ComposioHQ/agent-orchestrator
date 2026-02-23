import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockExecFileAsync, mockWriteFile, mockMkdir, mockChmod } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockChmod: vi.fn().mockResolvedValue(undefined),
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
  chmod: mockChmod,
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
  mockExecFileAsync.mockImplementation((cmd: string) => {
    if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
    if (cmd === "ps") {
      const line = found ? `  789 ttys003  ${processName}` : "  789 ttys003  bash";
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

  it("includes --approval-mode full-auto when permissions=skip", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "skip" }));
    expect(cmd).toContain("--approval-mode full-auto");
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
    expect(cmd).toBe("codex --approval-mode full-auto --model 'o3' -- 'Go'");
  });

  it("escapes single quotes in prompt (POSIX shell escaping)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's broken" }));
    expect(cmd).toContain("-- 'it'\\''s broken'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--approval-mode");
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
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("GH-42");
  });

  it("omits AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });

  it("prepends .ao-hooks/bin to PATH", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]).toMatch(/^\/workspace\/repo\/\.ao-hooks\/bin:/);
  });

  it("preserves system PATH after hooks bin directory", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    const parts = env["PATH"]!.split(":");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toBe("/workspace/repo/.ao-hooks/bin");
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
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
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
    expect(agent.detectActivity("codex is running some task\n")).toBe("active");
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
});

// =========================================================================
// setupWorkspaceHooks — installs git/gh wrapper scripts
// =========================================================================
describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("creates .ao-hooks/bin directory", async () => {
    await agent.setupWorkspaceHooks!("/workspace/project", { dataDir: "/data/sessions" });
    expect(mockMkdir).toHaveBeenCalledWith("/workspace/project/.ao-hooks/bin", { recursive: true });
  });

  it("writes git wrapper script and makes it executable", async () => {
    await agent.setupWorkspaceHooks!("/workspace/project", { dataDir: "/data/sessions" });
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/workspace/project/.ao-hooks/bin/git",
      expect.stringContaining("#!/usr/bin/env bash"),
      "utf-8",
    );
    expect(mockChmod).toHaveBeenCalledWith("/workspace/project/.ao-hooks/bin/git", 0o755);
  });

  it("writes gh wrapper script and makes it executable", async () => {
    await agent.setupWorkspaceHooks!("/workspace/project", { dataDir: "/data/sessions" });
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/workspace/project/.ao-hooks/bin/gh",
      expect.stringContaining("#!/usr/bin/env bash"),
      "utf-8",
    );
    expect(mockChmod).toHaveBeenCalledWith("/workspace/project/.ao-hooks/bin/gh", 0o755);
  });

  it("git wrapper script contains branch detection logic", async () => {
    await agent.setupWorkspaceHooks!("/workspace/project", { dataDir: "/data/sessions" });
    const gitCall = mockWriteFile.mock.calls.find(
      (c: unknown[]) => c[0] === "/workspace/project/.ao-hooks/bin/git",
    );
    expect(gitCall).toBeDefined();
    const script = gitCall![1] as string;
    expect(script).toContain("checkout");
    expect(script).toContain("switch");
    expect(script).toContain("_update_key");
    expect(script).toContain("AO_SESSION");
    expect(script).toContain("AO_DATA_DIR");
  });

  it("gh wrapper script contains PR detection logic", async () => {
    await agent.setupWorkspaceHooks!("/workspace/project", { dataDir: "/data/sessions" });
    const ghCall = mockWriteFile.mock.calls.find(
      (c: unknown[]) => c[0] === "/workspace/project/.ao-hooks/bin/gh",
    );
    expect(ghCall).toBeDefined();
    const script = ghCall![1] as string;
    expect(script).toContain("pr_open");
    expect(script).toContain("merged");
    expect(script).toContain("github");
  });

  it("is idempotent (safe to call multiple times)", async () => {
    await agent.setupWorkspaceHooks!("/workspace/project", { dataDir: "/data/sessions" });
    await agent.setupWorkspaceHooks!("/workspace/project", { dataDir: "/data/sessions" });
    expect(mockMkdir).toHaveBeenCalledTimes(2);
  });
});

// =========================================================================
// postLaunchSetup — writes hooks to session workspace
// =========================================================================
describe("postLaunchSetup", () => {
  const agent = create();

  it("writes hooks to session workspacePath", async () => {
    await agent.postLaunchSetup!(makeSession({ workspacePath: "/worktree/session-1" }));
    expect(mockMkdir).toHaveBeenCalledWith("/worktree/session-1/.ao-hooks/bin", {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/worktree/session-1/.ao-hooks/bin/git",
      expect.stringContaining("AO_SESSION"),
      "utf-8",
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/worktree/session-1/.ao-hooks/bin/gh",
      expect.stringContaining("AO_SESSION"),
      "utf-8",
    );
  });

  it("skips when workspacePath is null", async () => {
    await agent.postLaunchSetup!(makeSession({ workspacePath: null }));
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
