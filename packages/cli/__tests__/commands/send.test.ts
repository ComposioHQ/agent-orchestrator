import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockTmux, mockExec, mockDetectActivity } = vi.hoisted(() => ({
  mockTmux: vi.fn(),
  mockExec: vi.fn(),
  mockDetectActivity: vi.fn(),
}));

const { mockConfigRef, mockSessionManager } = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    get: vi.fn(),
    send: vi.fn(),
  },
}));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: mockTmux,
  exec: mockExec,
  execSilent: vi.fn(),
  git: vi.fn(),
  gh: vi.fn(),
}));

vi.mock("../../src/lib/plugins.js", () => ({
  getAgent: () => ({
    name: "claude-code",
    processName: "claude",
    detectActivity: mockDetectActivity,
  }),
  getAgentByName: () => ({
    name: "claude-code",
    processName: "claude",
    detectActivity: mockDetectActivity,
  }),
  getAgentByNameFromRegistry: () => ({
    name: "claude-code",
    processName: "claude",
    detectActivity: mockDetectActivity,
  }),
}));

vi.mock("../../src/lib/session-utils.js", () => ({
  findProjectForSession: () => null,
}));

vi.mock("@aoagents/ao-core", () => ({
  loadConfig: () => {
    if (!mockConfigRef.current) {
      throw new Error("no config");
    }
    return mockConfigRef.current;
  },
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async () => mockSessionManager,
  getPluginRegistry: async () => ({ get: vi.fn(), list: vi.fn(), register: vi.fn() }),
}));

import { Command } from "commander";
import { registerSend } from "../../src/commands/send.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  program = new Command();
  program.exitOverride();
  registerSend(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  mockTmux.mockReset();
  mockExec.mockReset();
  mockDetectActivity.mockReset();
  mockSessionManager.get.mockReset();
  mockSessionManager.send.mockReset();
  mockConfigRef.current = null;
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
});

afterEach(() => {
  vi.useRealTimers();
  consoleSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
});

function makeConfig(): Record<string, unknown> {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    defaults: {
      runtime: "file",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      "my-app": {
        name: "My App",
        sessionPrefix: "app",
        path: "/tmp/my-app",
        defaultBranch: "main",
        repo: "org/my-app",
        agent: "claude-code",
        runtime: "file",
      },
    },
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
    activity: "idle",
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: { id: "app-1", runtimeName: "file", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: { agent: "claude-code" },
    ...overrides,
  };
}

describe("send command", () => {
  describe("session existence check", () => {
    it("exits with error when session does not exist (bare CLI)", async () => {
      mockTmux.mockResolvedValue(null); // has-session fails

      await expect(
        program.parseAsync(["node", "test", "send", "nonexistent", "hello"]),
      ).rejects.toThrow("process.exit(1)");

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
    });
  });

  describe("message delivery via sessionManager", () => {
    it("sends message through sessionManager for managed sessions", async () => {
      mockConfigRef.current = makeConfig();
      mockSessionManager.get.mockResolvedValue(makeSession());
      mockSessionManager.send.mockResolvedValue(undefined);

      await program.parseAsync(["node", "test", "send", "app-1", "hello", "world"]);

      expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "hello world");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Message sent and processing"),
      );
    });

    it("does not use tmux send-keys for managed sessions", async () => {
      mockConfigRef.current = makeConfig();
      mockSessionManager.get.mockResolvedValue(makeSession());
      mockSessionManager.send.mockResolvedValue(undefined);

      await program.parseAsync(["node", "test", "send", "app-1", "fix", "the", "bug"]);

      expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "fix the bug");
      // Zero tmux send-keys in the communication path
      expect(mockExec).not.toHaveBeenCalledWith(
        "tmux",
        expect.arrayContaining(["send-keys"]),
      );
    });

    it("sends long messages through sessionManager without tmux load-buffer", async () => {
      mockConfigRef.current = makeConfig();
      mockSessionManager.get.mockResolvedValue(makeSession());
      mockSessionManager.send.mockResolvedValue(undefined);

      const longMsg = "x".repeat(250);
      await program.parseAsync(["node", "test", "send", "app-1", longMsg]);

      expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", longMsg);
      expect(mockExec).not.toHaveBeenCalledWith("tmux", expect.arrayContaining(["load-buffer"]));
    });

    it("skips tmux busy detection — inbox queues messages", async () => {
      mockConfigRef.current = makeConfig();
      mockSessionManager.get.mockResolvedValue(makeSession({ activity: "active" }));
      mockSessionManager.send.mockResolvedValue(undefined);

      await program.parseAsync(["node", "test", "send", "app-1", "fix", "mapping"]);

      expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "fix mapping");
      // No busy-wait loop — message goes straight to inbox
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Waiting for app-1 to become idle"),
      );
      expect(mockTmux).not.toHaveBeenCalledWith(
        "capture-pane",
        "-t",
        expect.any(String),
        "-p",
        "-S",
        expect.any(String),
      );
    });

    it("skips tmux checks for non-tmux AO sessions and still uses lifecycle send", async () => {
      mockConfigRef.current = makeConfig();
      mockSessionManager.get.mockResolvedValue(
        makeSession({ runtimeHandle: { id: "proc-1", runtimeName: "process", data: {} } }),
      );
      mockSessionManager.send.mockResolvedValue(undefined);

      await program.parseAsync(["node", "test", "send", "app-1", "hello"]);

      expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "hello");
      expect(mockTmux).not.toHaveBeenCalledWith("has-session", "-t", expect.any(String));
    });

    it("passes file contents through SessionManager.send for AO sessions", async () => {
      mockConfigRef.current = makeConfig();
      mockSessionManager.get.mockResolvedValue(makeSession());
      mockSessionManager.send.mockResolvedValue(undefined);

      const filePath = join(tmpdir(), `ao-send-message-${Date.now()}.txt`);
      writeFileSync(filePath, "from file");

      try {
        await program.parseAsync(["node", "test", "send", "app-1", "--file", filePath]);
      } finally {
        rmSync(filePath, { force: true });
      }

      expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "from file");
    });
  });

  describe("bare CLI fallback", () => {
    it("errors out for bare tmux sessions without sessionManager", async () => {
      // No config → resolveSessionContext falls back to bare tmux
      mockTmux.mockResolvedValue(""); // has-session succeeds

      await expect(
        program.parseAsync(["node", "test", "send", "my-session", "hello"]),
      ).rejects.toThrow("process.exit(1)");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("no session manager is available"),
      );
    });
  });
});
