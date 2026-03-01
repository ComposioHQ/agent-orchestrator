import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Session, type SessionManager, getProjectBaseDir } from "@composio/ao-core";

const { mockExec, mockConfigRef, mockSessionManager } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    list: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    get: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    send: vi.fn(),
  },
}));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: vi.fn(),
  exec: mockExec,
  execSilent: vi.fn(),
  git: vi.fn(),
  gh: vi.fn(),
  getTmuxSessions: vi.fn().mockResolvedValue([]),
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

vi.mock("../../src/lib/metadata.js", () => ({
  findSessionForIssue: vi.fn().mockResolvedValue(null),
  writeMetadata: vi.fn(),
}));

let tmpDir: string;
let configPath: string;

import { Command } from "commander";
import { registerSpawn } from "../../src/commands/spawn.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-spawn-test-"));
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}");

  mockConfigRef.current = {
    configPath,
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
        path: join(tmpDir, "main-repo"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as Record<string, unknown>;

  mkdirSync(join(tmpDir, "main-repo"), { recursive: true });

  program = new Command();
  program.exitOverride();
  registerSpawn(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockSessionManager.spawn.mockReset();
  mockExec.mockReset();
});

afterEach(() => {
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "main-repo"));
  if (projectBaseDir) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("spawn command", () => {
  it("delegates to sessionManager.spawn() instead of creating tmux sessions directly", async () => {
    // This is the core regression test: spawn must delegate to sm.spawn(),
    // not manually create tmux sessions with flat naming (which broke after
    // the hash-based architecture migration).
    const fakeSession: Session = {
      id: "app-7",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/INT-100",
      issueId: "INT-100",
      pr: null,
      workspacePath: "/tmp/worktrees/app-7",
      runtimeHandle: { id: "8474d6f29887-app-7", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };

    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    await program.parseAsync(["node", "test", "spawn", "my-app", "INT-100"]);

    // Must delegate to session manager
    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "INT-100",
    });

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("app-7");
  });

  it("passes issueId to sessionManager.spawn()", async () => {
    const fakeSession: Session = {
      id: "app-1",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/42",
      issueId: "42",
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };

    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    await program.parseAsync(["node", "test", "spawn", "my-app", "42"]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "42",
    });
  });

  it("spawns without issueId when none provided", async () => {
    const fakeSession: Session = {
      id: "app-1",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: null,
      issueId: null,
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };

    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    await program.parseAsync(["node", "test", "spawn", "my-app"]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: undefined,
    });
  });

  it("shows tmux attach command using runtimeHandle.id (hash-based name)", async () => {
    // Regression: tmux sessions use hash-based names (e.g., "8474d6f29887-app-7"),
    // not flat names (e.g., "app-7"). The attach hint must use the runtime handle.
    const fakeSession: Session = {
      id: "app-7",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/fix",
      issueId: null,
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "8474d6f29887-app-7", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };

    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    await program.parseAsync(["node", "test", "spawn", "my-app"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // Must show the hash-based tmux name, not the flat session ID
    expect(output).toContain("8474d6f29887-app-7");
  });

  it("passes --agent flag to sessionManager.spawn()", async () => {
    const fakeSession: Session = {
      id: "app-1",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: null,
      issueId: null,
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };

    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    await program.parseAsync(["node", "test", "spawn", "my-app", "--agent", "codex"]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: undefined,
      agent: "codex",
    });
  });

  it("passes --agent flag with issue ID", async () => {
    const fakeSession: Session = {
      id: "app-1",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/INT-42",
      issueId: "INT-42",
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };

    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    await program.parseAsync(["node", "test", "spawn", "my-app", "INT-42", "--agent", "codex"]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "INT-42",
      agent: "codex",
    });
  });

  it("rejects unknown project ID", async () => {
    await expect(
      program.parseAsync(["node", "test", "spawn", "nonexistent"]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("reports error when spawn fails", async () => {
    mockSessionManager.spawn.mockRejectedValue(new Error("worktree creation failed"));

    await expect(
      program.parseAsync(["node", "test", "spawn", "my-app"]),
    ).rejects.toThrow("process.exit(1)");
  });
});

describe("spawn pre-flight checks", () => {
  it("fails with clear error when tmux is not installed (default runtime)", async () => {
    mockExec.mockRejectedValue(new Error("ENOENT"));

    await expect(
      program.parseAsync(["node", "test", "spawn", "my-app"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).toContain("tmux");
    // Should not attempt to spawn
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("skips tmux check when runtime is not tmux", async () => {
    const fakeSession: Session = {
      id: "app-1",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: null,
      issueId: null,
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "proc-1", runtimeName: "process", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };
    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    // Set runtime to "process"
    (mockConfigRef.current as Record<string, unknown>).defaults = {
      runtime: "process",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    };

    // exec would fail for tmux but should never be called
    mockExec.mockRejectedValue(new Error("ENOENT"));

    await program.parseAsync(["node", "test", "spawn", "my-app"]);

    expect(mockSessionManager.spawn).toHaveBeenCalled();
  });

  it("checks gh auth when tracker is github", async () => {
    const projects = (mockConfigRef.current as Record<string, unknown>).projects as Record<string, Record<string, unknown>>;
    projects["my-app"].tracker = { plugin: "github" };

    // tmux check passes, gh --version passes, gh auth status fails
    mockExec
      .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" }) // tmux -V
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // gh --version
      .mockRejectedValueOnce(new Error("not logged in")); // gh auth status

    await expect(
      program.parseAsync(["node", "test", "spawn", "my-app"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).toContain("not authenticated");
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("skips gh auth check when tracker is not github", async () => {
    const fakeSession: Session = {
      id: "app-1",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: null,
      issueId: null,
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };
    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    const projects = (mockConfigRef.current as Record<string, unknown>).projects as Record<string, Record<string, unknown>>;
    projects["my-app"].tracker = { plugin: "linear" };

    // tmux check passes — gh should never be called
    mockExec.mockResolvedValue({ stdout: "tmux 3.3a", stderr: "" });

    await program.parseAsync(["node", "test", "spawn", "my-app"]);

    // Should only call tmux -V, not gh
    expect(mockExec).toHaveBeenCalledWith("tmux", ["-V"]);
    expect(mockExec).not.toHaveBeenCalledWith("gh", expect.anything());
    expect(mockSessionManager.spawn).toHaveBeenCalled();
  });

  it("distinguishes gh not installed from gh not authenticated", async () => {
    const projects = (mockConfigRef.current as Record<string, unknown>).projects as Record<string, Record<string, unknown>>;
    projects["my-app"].tracker = { plugin: "github" };

    // tmux passes, gh --version fails (not installed)
    mockExec
      .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" }) // tmux -V
      .mockRejectedValueOnce(new Error("ENOENT")); // gh --version fails

    await expect(
      program.parseAsync(["node", "test", "spawn", "my-app"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).toContain("not installed");
    expect(errors).not.toContain("not authenticated");
  });
});
