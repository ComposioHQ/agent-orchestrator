import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Session, SessionManager } from "@composio/ao-core";

const { mockExec, mockConfigRef, mockSessionManager } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    list: vi.fn(),
    getAttachInfo: vi.fn(),
  },
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
  execSilent: vi.fn(),
  tmux: vi.fn(),
  git: vi.fn(),
  gh: vi.fn(),
  getTmuxSessions: vi.fn().mockResolvedValue([]),
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

import { Command } from "commander";
import { registerOpen } from "../../src/commands/open.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "running",
    activity: null,
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/workspace",
    runtimeHandle: { id: "app-1", runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

let program: Command;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

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

  mockSessionManager.list.mockReset();
  mockSessionManager.getAttachInfo.mockReset();
  mockSessionManager.getAttachInfo.mockResolvedValue(null);
  mockExec.mockReset();
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });

  program = new Command();
  program.exitOverride();
  registerOpen(program);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("open command", () => {
  it("opens all sessions when target is 'all'", async () => {
    mockSessionManager.list.mockResolvedValue([
      makeSession({ id: "app-1" }),
      makeSession({ id: "app-2", runtimeHandle: { id: "app-2", runtimeName: "tmux", data: {} } }),
      makeSession({
        id: "backend-1",
        projectId: "backend",
        runtimeHandle: { id: "backend-1", runtimeName: "tmux", data: {} },
      }),
    ]);

    await program.parseAsync(["node", "test", "open", "all"]);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 3 sessions");
    expect(output).toContain("app-1");
    expect(output).toContain("app-2");
    expect(output).toContain("backend-1");
  });

  it("opens all sessions when no target given", async () => {
    mockSessionManager.list.mockResolvedValue([makeSession({ id: "app-1" })]);

    await program.parseAsync(["node", "test", "open"]);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 1 session");
  });

  it("opens sessions for a specific project", async () => {
    mockSessionManager.list.mockResolvedValue([
      makeSession({ id: "app-1" }),
      makeSession({ id: "app-2", runtimeHandle: { id: "app-2", runtimeName: "tmux", data: {} } }),
      makeSession({
        id: "backend-1",
        projectId: "backend",
        runtimeHandle: { id: "backend-1", runtimeName: "tmux", data: {} },
      }),
    ]);

    await program.parseAsync(["node", "test", "open", "my-app"]);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 2 sessions");
    expect(output).toContain("app-1");
    expect(output).toContain("app-2");
    expect(output).not.toContain("backend-1");
  });

  it("opens a single session by name", async () => {
    mockSessionManager.list.mockResolvedValue([
      makeSession({ id: "app-1" }),
      makeSession({ id: "app-2", runtimeHandle: { id: "app-2", runtimeName: "tmux", data: {} } }),
    ]);

    await program.parseAsync(["node", "test", "open", "app-1"]);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 1 session");
    expect(output).toContain("app-1");
  });

  it("rejects unknown target", async () => {
    mockSessionManager.list.mockResolvedValue([makeSession({ id: "app-1" })]);

    await expect(program.parseAsync(["node", "test", "open", "nonexistent"])).rejects.toThrow(
      "process.exit(1)",
    );

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown target: nonexistent"),
    );
  });

  it("passes --new-window flag to open-iterm-tab for tmux sessions", async () => {
    mockSessionManager.list.mockResolvedValue([makeSession({ id: "app-1" })]);

    await program.parseAsync(["node", "test", "open", "-w", "app-1"]);

    expect(mockExec).toHaveBeenCalledWith("open-iterm-tab", ["--new-window", "app-1"]);
  });

  it("opens docker sessions in iTerm using runtime attach info", async () => {
    mockSessionManager.list.mockResolvedValue([
      makeSession({
        id: "app-1",
        runtimeHandle: {
          id: "container-1",
          runtimeName: "docker",
          data: { tmuxSessionName: "tmux-1" },
        },
      }),
    ]);
    mockSessionManager.getAttachInfo.mockResolvedValue({
      type: "docker",
      target: "container-1",
      command: "docker exec -it container-1 tmux attach -t tmux-1",
      program: "docker",
      args: ["exec", "-it", "container-1", "tmux", "attach", "-t", "tmux-1"],
      requiresPty: true,
    });

    await program.parseAsync(["node", "test", "open", "app-1"]);

    expect(mockExec).toHaveBeenCalledWith("open-iterm-tab", [
      "--title",
      "container-1",
      "--command",
      "docker exec -it container-1 tmux attach -t tmux-1",
    ]);
  });

  it("falls back gracefully when open-iterm-tab fails", async () => {
    mockSessionManager.list.mockResolvedValue([makeSession({ id: "app-1" })]);
    mockExec.mockRejectedValue(new Error("command not found"));

    await program.parseAsync(["node", "test", "open", "app-1"]);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("tmux attach");
  });

  it("prints docker attach command when runtime-aware open fails", async () => {
    mockSessionManager.list.mockResolvedValue([
      makeSession({
        id: "app-1",
        runtimeHandle: {
          id: "container-1",
          runtimeName: "docker",
          data: { tmuxSessionName: "tmux-1" },
        },
      }),
    ]);
    mockSessionManager.getAttachInfo.mockResolvedValue({
      type: "docker",
      target: "container-1",
      command: "docker exec -it container-1 tmux attach -t tmux-1",
      program: "docker",
      args: ["exec", "-it", "container-1", "tmux", "attach", "-t", "tmux-1"],
      requiresPty: true,
    });
    mockExec.mockRejectedValue(new Error("command not found"));

    await program.parseAsync(["node", "test", "open", "app-1"]);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("docker exec -it container-1 tmux attach -t tmux-1");
  });

  it("shows 'No sessions to open' when none exist", async () => {
    mockSessionManager.list.mockResolvedValue([]);

    await program.parseAsync(["node", "test", "open", "my-app"]);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No sessions to open");
  });
});
