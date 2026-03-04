import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockExecFileAsync, mockReaddir, mockReadFile, mockStat } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
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
    readdir: mockReaddir,
    readFile: mockReadFile,
    stat: mockStat,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("agent-cline plugin", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Manifest & exports
  // -------------------------------------------------------------------------
  describe("manifest", () => {
    it("has correct name and slot", () => {
      expect(manifest.name).toBe("cline");
      expect(manifest.slot).toBe("agent");
    });

    it("default export satisfies PluginModule shape", () => {
      expect(defaultExport.manifest).toBe(manifest);
      expect(typeof defaultExport.create).toBe("function");
    });
  });

  describe("create()", () => {
    it("returns an agent with correct name and processName", () => {
      const agent = create();
      expect(agent.name).toBe("cline");
      expect(agent.processName).toBe("cline");
    });
  });

  // -------------------------------------------------------------------------
  // getLaunchCommand
  // -------------------------------------------------------------------------
  describe("getLaunchCommand", () => {
    it("builds basic command with --act flag", () => {
      const agent = create();
      const cmd = agent.getLaunchCommand(makeLaunchConfig());
      expect(cmd).toBe("cline --act");
    });

    it("adds --yolo when permissions=skip", () => {
      const agent = create();
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "skip" }));
      expect(cmd).toContain("--yolo");
      expect(cmd).toContain("--act");
    });

    it("adds -m flag for model", () => {
      const agent = create();
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4o" }));
      expect(cmd).toContain("-m");
      expect(cmd).toContain("gpt-4o");
    });

    it("appends prompt", () => {
      const agent = create();
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
      expect(cmd).toContain("Fix the bug");
    });

    it("combines all options", () => {
      const agent = create();
      const cmd = agent.getLaunchCommand(
        makeLaunchConfig({ permissions: "skip", model: "claude-sonnet-4-5-20250929", prompt: "Do stuff" }),
      );
      expect(cmd).toContain("--yolo");
      expect(cmd).toContain("--act");
      expect(cmd).toContain("-m");
      expect(cmd).toContain("claude-sonnet-4-5-20250929");
      expect(cmd).toContain("Do stuff");
    });
  });

  // -------------------------------------------------------------------------
  // getEnvironment
  // -------------------------------------------------------------------------
  describe("getEnvironment", () => {
    it("sets AO_SESSION_ID", () => {
      const agent = create();
      const env = agent.getEnvironment(makeLaunchConfig({ sessionId: "s-42" }));
      expect(env["AO_SESSION_ID"]).toBe("s-42");
    });

    it("sets AO_ISSUE_ID when provided", () => {
      const agent = create();
      const env = agent.getEnvironment(makeLaunchConfig({ issueId: "ISSUE-99" }));
      expect(env["AO_ISSUE_ID"]).toBe("ISSUE-99");
    });

    it("omits AO_ISSUE_ID when not provided", () => {
      const agent = create();
      const env = agent.getEnvironment(makeLaunchConfig());
      expect(env["AO_ISSUE_ID"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // detectActivity
  // -------------------------------------------------------------------------
  describe("detectActivity", () => {
    it("returns idle for empty output", () => {
      const agent = create();
      expect(agent.detectActivity("")).toBe("idle");
      expect(agent.detectActivity("   ")).toBe("idle");
    });

    it("returns waiting_input for Y/n prompt", () => {
      const agent = create();
      expect(agent.detectActivity("Do you want to proceed? [Y/n]")).toBe("waiting_input");
    });

    it("returns waiting_input for approval prompt", () => {
      const agent = create();
      expect(agent.detectActivity("Approve this change? ")).toBe("waiting_input");
    });

    it("returns blocked for Error:", () => {
      const agent = create();
      expect(agent.detectActivity("Error: connection refused")).toBe("blocked");
    });

    it("returns blocked for API Error", () => {
      const agent = create();
      expect(agent.detectActivity("API Error: unauthorized")).toBe("blocked");
    });

    it("returns blocked for rate limit", () => {
      const agent = create();
      expect(agent.detectActivity("rate limit exceeded")).toBe("blocked");
    });

    it("returns blocked for authentication failure", () => {
      const agent = create();
      expect(agent.detectActivity("Authentication failed")).toBe("blocked");
    });

    it("returns idle for task completed", () => {
      const agent = create();
      expect(agent.detectActivity("Task completed successfully")).toBe("idle");
    });

    it("returns active for normal output", () => {
      const agent = create();
      expect(agent.detectActivity("Reading file: src/index.ts")).toBe("active");
    });
  });

  // -------------------------------------------------------------------------
  // isProcessRunning — tmux
  // -------------------------------------------------------------------------
  describe("isProcessRunning (tmux)", () => {
    it("returns true when cline process is on the tmux tty", async () => {
      const agent = create();
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: "/dev/ttys001\n", stderr: "" })
        .mockResolvedValueOnce({
          stdout: "  123 ttys001 /usr/local/bin/cline --act\n",
          stderr: "",
        });
      expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
    });

    it("returns false when no cline process found", async () => {
      const agent = create();
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: "/dev/ttys001\n", stderr: "" })
        .mockResolvedValueOnce({
          stdout: "  123 ttys001 /usr/bin/bash\n",
          stderr: "",
        });
      expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
    });

    it("returns false when tmux lists no panes", async () => {
      const agent = create();
      mockExecFileAsync.mockResolvedValueOnce({ stdout: "\n", stderr: "" });
      expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isProcessRunning — pid-based
  // -------------------------------------------------------------------------
  describe("isProcessRunning (pid)", () => {
    it("returns true when process.kill(pid, 0) succeeds", async () => {
      const agent = create();
      const handle = makeProcessHandle(99999);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      expect(await agent.isProcessRunning(handle)).toBe(true);
      killSpy.mockRestore();
    });

    it("returns false when process.kill throws ESRCH", async () => {
      const agent = create();
      const handle = makeProcessHandle(99999);
      const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw err;
      });
      expect(await agent.isProcessRunning(handle)).toBe(false);
      killSpy.mockRestore();
    });

    it("returns false when no pid in handle data", async () => {
      const agent = create();
      const handle = makeProcessHandle();
      expect(await agent.isProcessRunning(handle)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getActivityState
  // -------------------------------------------------------------------------
  describe("getActivityState", () => {
    it("returns exited when no runtimeHandle", async () => {
      const agent = create();
      const result = await agent.getActivityState!(makeSession({ runtimeHandle: null }));
      expect(result).not.toBeNull();
      expect(result!.state).toBe("exited");
    });

    it("returns exited when process not running", async () => {
      const agent = create();
      mockExecFileAsync.mockRejectedValue(new Error("no session"));
      const session = makeSession({ runtimeHandle: makeTmuxHandle() });
      const result = await agent.getActivityState!(session);
      expect(result).not.toBeNull();
      expect(result!.state).toBe("exited");
    });
  });

  // -------------------------------------------------------------------------
  // getSessionInfo
  // -------------------------------------------------------------------------
  describe("getSessionInfo", () => {
    it("returns null when tasks dir does not exist", async () => {
      const agent = create();
      mockReaddir.mockRejectedValue(new Error("ENOENT"));
      const result = await agent.getSessionInfo(makeSession());
      expect(result).toBeNull();
    });

    it("returns null when tasks dir is empty", async () => {
      const agent = create();
      mockReaddir.mockResolvedValue([]);
      const result = await agent.getSessionInfo(makeSession());
      expect(result).toBeNull();
    });

    it("returns task summary and id from latest task", async () => {
      const agent = create();
      mockReaddir.mockResolvedValue([
        { name: "task-abc", isDirectory: () => true },
      ]);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() });
      mockReadFile.mockResolvedValue(
        JSON.stringify({ task: "Fix the login bug", totalCost: 0.05 }),
      );

      const result = await agent.getSessionInfo(makeSession());
      expect(result).not.toBeNull();
      expect(result!.summary).toBe("Fix the login bug");
      expect(result!.agentSessionId).toBe("task-abc");
      expect(result!.cost).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0.05,
      });
    });

    it("returns null summary when metadata has no task field", async () => {
      const agent = create();
      mockReaddir.mockResolvedValue([
        { name: "task-xyz", isDirectory: () => true },
      ]);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() });
      mockReadFile.mockResolvedValue(JSON.stringify({}));

      const result = await agent.getSessionInfo(makeSession());
      expect(result).not.toBeNull();
      expect(result!.summary).toBeNull();
      expect(result!.agentSessionId).toBe("task-xyz");
      expect(result!.cost).toBeUndefined();
    });

    it("truncates long summaries to 120 chars", async () => {
      const agent = create();
      const longTask = "A".repeat(200);
      mockReaddir.mockResolvedValue([
        { name: "task-long", isDirectory: () => true },
      ]);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() });
      mockReadFile.mockResolvedValue(JSON.stringify({ task: longTask }));

      const result = await agent.getSessionInfo(makeSession());
      expect(result).not.toBeNull();
      expect(result!.summary!.length).toBe(120);
    });

    it("picks the most recently modified task directory", async () => {
      const agent = create();
      mockReaddir.mockResolvedValue([
        { name: "task-old", isDirectory: () => true },
        { name: "task-new", isDirectory: () => true },
      ]);
      mockStat
        .mockResolvedValueOnce({ mtimeMs: 1000 }) // task-old
        .mockResolvedValueOnce({ mtimeMs: 9000 }); // task-new
      mockReadFile.mockResolvedValue(
        JSON.stringify({ task: "New task" }),
      );

      const result = await agent.getSessionInfo(makeSession());
      expect(result).not.toBeNull();
      expect(result!.agentSessionId).toBe("task-new");
    });
  });
});
