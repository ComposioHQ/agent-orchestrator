import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExec, mockConfigRef, mockTmux, mockSessionManager } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockTmux: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    list: vi.fn(),
  },
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
  execSilent: vi.fn(),
  tmux: mockTmux,
  git: vi.fn(),
  gh: vi.fn(),
  getTmuxSessions: async () => {
    const output = await mockTmux("list-sessions", "-F", "#{session_name}");
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  },
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("@composio/ao-core", () => ({
  loadConfig: () => mockConfigRef.current,
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async () => mockSessionManager,
}));

import { Command } from "commander";
import { registerOpen } from "../../src/commands/open.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

function makeSession(id: string, projectId: string) {
  return {
    id,
    projectId,
    runtimeHandle: { id, runtimeName: "tmux", data: {} },
  };
}

beforeEach(() => {
  mockConfigRef.current = {
    dataDir: "/tmp/ao",
    worktreeDir: "/tmp/wt",
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/home/user/my-app",
        defaultBranch: "main",
        sessionPrefix: "app",
      },
      backend: {
        name: "Backend",
        repo: "org/backend",
        path: "/home/user/backend",
        defaultBranch: "main",
      },
    },
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as Record<string, unknown>;

  program = new Command();
  program.exitOverride();
  registerOpen(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockExec.mockReset();
  mockTmux.mockReset();
  mockSessionManager.list.mockReset();
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
  mockSessionManager.list.mockResolvedValue([
    makeSession("app-1", "my-app"),
    makeSession("app-2", "my-app"),
    makeSession("backend-1", "backend"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("open command", () => {
  it("opens all sessions when target is 'all'", async () => {
    await program.parseAsync(["node", "test", "open", "all"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 3 sessions");
    expect(output).toContain("app-1");
    expect(output).toContain("app-2");
    expect(output).toContain("backend-1");
  });

  it("opens all sessions when no target given", async () => {
    mockSessionManager.list.mockResolvedValue([makeSession("app-1", "my-app")]);

    await program.parseAsync(["node", "test", "open"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 1 session");
  });

  it("opens sessions for a specific project", async () => {
    await program.parseAsync(["node", "test", "open", "my-app"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 2 sessions");
    expect(output).toContain("app-1");
    expect(output).toContain("app-2");
    expect(output).not.toContain("backend-1");
  });

  it("opens a single session by name", async () => {
    await program.parseAsync(["node", "test", "open", "app-1"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 1 session");
    expect(output).toContain("app-1");
  });

  it("rejects unknown target", async () => {
    mockSessionManager.list.mockResolvedValue([makeSession("app-1", "my-app")]);

    await expect(program.parseAsync(["node", "test", "open", "nonexistent"])).rejects.toThrow(
      "process.exit(1)",
    );
  });

  it("passes --new-window flag to open-iterm-tab", async () => {
    mockSessionManager.list.mockResolvedValue([makeSession("app-1", "my-app")]);

    await program.parseAsync(["node", "test", "open", "-w", "app-1"]);

    expect(mockExec).toHaveBeenCalledWith("open-iterm-tab", ["--new-window", "app-1"]);
  });

  it("falls back gracefully when open-iterm-tab fails", async () => {
    mockSessionManager.list.mockResolvedValue([makeSession("app-1", "my-app")]);
    mockExec.mockRejectedValue(new Error("command not found"));

    await program.parseAsync(["node", "test", "open", "app-1"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("tmux attach");
  });

  it("shows 'No sessions to open' when none exist", async () => {
    mockSessionManager.list.mockResolvedValue([]);

    await program.parseAsync(["node", "test", "open", "my-app"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No sessions to open");
  });
});
