import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig, ProjectConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockExecFileAsync,
  mockWriteFile,
  mockMkdir,
  mockReadFile,
  mockReaddir,
  mockRename,
  mockHomedir,
} = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
  mockReaddir: vi.fn(),
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
  readdir: mockReaddir,
  rename: mockRename,
}));

vi.mock("node:crypto", () => ({
  randomBytes: () => ({ toString: () => "abc123" }),
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
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

function makeProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "my-project",
    repo: "owner/repo",
    path: "/workspace/repo",
    defaultBranch: "main",
    sessionPrefix: "my",
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
  mockHomedir.mockReturnValue("/mock/home");
});

// =========================================================================
// Manifest & Exports
// =========================================================================
describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "gemini",
      slot: "agent",
      description: "Agent plugin: Gemini CLI",
      version: "0.1.0",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("gemini");
    expect(agent.processName).toBe("gemini");
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

  it("generates base command without prompt", () => {
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("gemini");
  });

  it("uses -p flag with shell-escaped prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).toBe("gemini -p 'Fix the bug'");
  });

  it("includes -m with shell-escaped model", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gemini-2.5-pro" }));
    expect(cmd).toBe("gemini -m 'gemini-2.5-pro'");
  });

  it("combines --yolo, model, and prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip", model: "gemini-2.5-pro", prompt: "Go" }),
    );
    expect(cmd).toBe("gemini --yolo -m 'gemini-2.5-pro' -p 'Go'");
  });

  it("adds --yolo flag for skip permissions", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "skip" }));
    expect(cmd).toBe("gemini --yolo");
  });

  it("does not add --yolo for default permissions", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "default" }));
    expect(cmd).not.toContain("--yolo");
  });

  it("escapes single quotes in prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's broken" }));
    expect(cmd).toContain("-p 'it'\\''s broken'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("-m");
    expect(cmd).not.toContain("-p");
    expect(cmd).not.toContain("--yolo");
  });

  it("prepends cp to write systemPromptFile to GEMINI.md", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "/tmp/ao-prompt.md", prompt: "Go" }),
    );
    expect(cmd).toBe("cp '/tmp/ao-prompt.md' GEMINI.md && gemini -p 'Go'");
  });

  it("prepends printf to write inline systemPrompt to GEMINI.md", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPrompt: "You are an agent", prompt: "Go" }),
    );
    expect(cmd).toBe("printf '%s' 'You are an agent' > GEMINI.md && gemini -p 'Go'");
  });

  it("prefers systemPromptFile over systemPrompt when both set", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "/tmp/prompt.md", systemPrompt: "ignored" }),
    );
    expect(cmd).toContain("cp '/tmp/prompt.md' GEMINI.md &&");
    expect(cmd).not.toContain("printf");
  });

  it("does not prepend anything when no system prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Go" }));
    expect(cmd).toBe("gemini -p 'Go'");
    expect(cmd).not.toContain("&&");
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

  it("prepends ~/.ao/bin to PATH for shell wrappers", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]).toMatch(/^\/mock\/home\/\.ao\/bin:/);
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when gemini found on tmux pane TTY", async () => {
    mockTmuxWithProcess("gemini");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when gemini not on tmux pane TTY", async () => {
    mockTmuxWithProcess("gemini", false);
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

  it("finds gemini on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  gemini -p hello\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });
});

// =========================================================================
// detectActivity
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
    expect(agent.detectActivity("gemini is working\n")).toBe("active");
  });

  it("returns idle when last line is a prompt character", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
  });

  it("returns waiting_input for approval prompts", () => {
    expect(agent.detectActivity("Do you approve this?\n(y)es (n)o")).toBe("waiting_input");
  });
});

// =========================================================================
// getActivityState
// =========================================================================
describe("getActivityState", () => {
  const agent = create();

  it("returns exited when no runtimeHandle", async () => {
    const result = await agent.getActivityState(makeSession({ runtimeHandle: null }));
    expect(result?.state).toBe("exited");
  });

  it("returns exited when process is not running", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux not running"));
    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result?.state).toBe("exited");
  });

  it("returns null when process is running (cannot scope sessions per workspace)", async () => {
    mockTmuxWithProcess("gemini");
    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result).toBeNull();
  });
});

// =========================================================================
// getSessionInfo
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("always returns null (cannot scope sessions per workspace)", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
    expect(await agent.getSessionInfo(makeSession({ workspacePath: "/some/path" }))).toBeNull();
  });
});

// =========================================================================
// getRestoreCommand
// =========================================================================
describe("getRestoreCommand", () => {
  const agent = create();

  it("returns null when no Gemini sessions exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const cmd = await agent.getRestoreCommand!(makeSession(), makeProjectConfig());
    expect(cmd).toBeNull();
  });

  it("returns gemini -r latest when sessions exist", async () => {
    mockReaddir.mockResolvedValue(["project-1"]);
    const cmd = await agent.getRestoreCommand!(makeSession(), makeProjectConfig());
    expect(cmd).toBe("gemini -r latest");
  });

  it("includes --yolo when permissions is skip", async () => {
    mockReaddir.mockResolvedValue(["project-1"]);
    const project = makeProjectConfig({ agentConfig: { permissions: "skip" } });
    const cmd = await agent.getRestoreCommand!(makeSession(), project);
    expect(cmd).toBe("gemini --yolo -r latest");
  });

  it("includes -m when model is configured", async () => {
    mockReaddir.mockResolvedValue(["project-1"]);
    const project = makeProjectConfig({ agentConfig: { model: "gemini-2.5-pro" } });
    const cmd = await agent.getRestoreCommand!(makeSession(), project);
    expect(cmd).toBe("gemini -m 'gemini-2.5-pro' -r latest");
  });

  it("includes both --yolo and -m when both configured", async () => {
    mockReaddir.mockResolvedValue(["project-1"]);
    const project = makeProjectConfig({
      agentConfig: { permissions: "skip", model: "gemini-2.5-pro" },
    });
    const cmd = await agent.getRestoreCommand!(makeSession(), project);
    expect(cmd).toBe("gemini --yolo -m 'gemini-2.5-pro' -r latest");
  });
});

// =========================================================================
// setupWorkspaceHooks — shell wrapper creation + AGENTS.md
// =========================================================================
describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("creates ~/.ao/bin directory", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/data" });
    expect(mockMkdir).toHaveBeenCalledWith("/mock/home/.ao/bin", { recursive: true });
  });

  it("writes ao-metadata-helper.sh", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/data" });

    const helperCalls = mockWriteFile.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("ao-metadata-helper"),
    );
    expect(helperCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("writes gh and git wrappers when version marker is missing", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/data" });

    const writtenFiles = mockWriteFile.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(writtenFiles.some((f: string) => f.includes("/gh.tmp."))).toBe(true);
    expect(writtenFiles.some((f: string) => f.includes("/git.tmp."))).toBe(true);
  });

  it("skips gh/git wrappers when version marker is current", async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes(".ao-version")) return Promise.resolve("0.1.0");
      return Promise.reject(new Error("ENOENT"));
    });

    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/data" });

    const writtenFiles = mockWriteFile.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(writtenFiles.some((f: string) => f.includes("/gh.tmp."))).toBe(false);
    expect(writtenFiles.some((f: string) => f.includes("/git.tmp."))).toBe(false);
  });

  it("appends ao section to AGENTS.md", async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes("AGENTS.md")) return Promise.resolve("# Existing content\n");
      return Promise.reject(new Error("ENOENT"));
    });

    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/data" });

    const agentsMdCalls = mockWriteFile.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("AGENTS.md"),
    );
    expect(agentsMdCalls.length).toBe(1);
    const content = agentsMdCalls[0][1] as string;
    expect(content).toContain("Agent Orchestrator (ao) Session");
    expect(content).toContain("# Existing content");
  });

  it("creates AGENTS.md if it does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/data" });

    const agentsMdCalls = mockWriteFile.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("AGENTS.md"),
    );
    expect(agentsMdCalls.length).toBe(1);
    const content = agentsMdCalls[0][1] as string;
    expect(content).toContain("Agent Orchestrator (ao) Session");
  });

  it("is idempotent — does not duplicate ao section in AGENTS.md", async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes("AGENTS.md")) {
        return Promise.resolve("# Existing\n\n## Agent Orchestrator (ao) Session\nalready here\n");
      }
      return Promise.reject(new Error("ENOENT"));
    });

    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/data" });

    const agentsMdCalls = mockWriteFile.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("AGENTS.md"),
    );
    expect(agentsMdCalls.length).toBe(0);
  });
});

// =========================================================================
// postLaunchSetup
// =========================================================================
describe("postLaunchSetup", () => {
  const agent = create();

  it("delegates to workspace setup when workspacePath is set", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    await agent.postLaunchSetup!(makeSession({ workspacePath: "/workspace/test" }));
    expect(mockMkdir).toHaveBeenCalledWith("/mock/home/.ao/bin", { recursive: true });
  });

  it("does nothing when workspacePath is null", async () => {
    await agent.postLaunchSetup!(makeSession({ workspacePath: null }));
    expect(mockMkdir).not.toHaveBeenCalled();
  });
});
