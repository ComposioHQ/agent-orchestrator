import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Session, type SessionManager, getProjectBaseDir } from "@aoagents/ao-core";

const { mockExec, mockConfigRef, mockSessionManager, mockGetRunning } = vi.hoisted(
  () => ({
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
      claimPR: vi.fn(),
    },
    mockGetRunning: vi.fn(),
  }),
);

vi.mock("../../src/lib/shell.js", () => ({
  tmux: vi.fn(),
  exec: mockExec,
  execSilent: vi.fn(),
  git: vi.fn(),
  gh: vi.fn(),
  getTmuxSessions: vi.fn().mockResolvedValue([]),
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

const mockSpinner = {
  start: vi.fn().mockReturnThis(),
  stop: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  text: "",
};
vi.mock("ora", () => ({
  default: () => mockSpinner,
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

vi.mock("../../src/lib/running-state.js", () => ({
  getRunning: () => mockGetRunning(),
}));

vi.mock("../../src/lib/metadata.js", () => ({
  findSessionForIssue: vi.fn().mockResolvedValue(null),
  writeMetadata: vi.fn(),
}));

let tmpDir: string;
let configPath: string;
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
const STORAGE_KEY = "111111111113";

import { Command } from "commander";
import { registerSpawn, registerBatchSpawn } from "../../src/commands/spawn.js";

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
        storageKey: STORAGE_KEY,
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

  mockSpinner.start.mockClear().mockReturnThis();
  mockSpinner.stop.mockClear().mockReturnThis();
  mockSpinner.succeed.mockClear().mockReturnThis();
  mockSpinner.fail.mockClear().mockReturnThis();
  mockSessionManager.spawn.mockReset();
  mockSessionManager.claimPR.mockReset();
  mockExec.mockReset();
  mockGetRunning.mockReset();
  mockGetRunning.mockResolvedValue({ pid: 1234, port: 3000, startedAt: "", projects: ["my-app"] });
});

afterEach(() => {
  cwdSpy?.mockRestore();
  cwdSpy = undefined;
  const projectBaseDir = getProjectBaseDir(STORAGE_KEY);
  if (projectBaseDir) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("spawn command", () => {
  it("delegates to sessionManager.spawn() with auto-detected project", async () => {
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

    // Single arg = issue; project is auto-detected (only one project in config)
    await program.parseAsync(["node", "test", "spawn", "INT-100"]);

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

    await program.parseAsync(["node", "test", "spawn", "42"]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "42",
    });
  });

  it("auto-detects the project from a nested cwd in multi-project configs", async () => {
    (mockConfigRef.current as Record<string, unknown>).projects = {
      frontend: {
        name: "Frontend",
        repo: "org/frontend",
        path: join(tmpDir, "frontend"),
        defaultBranch: "main",
        sessionPrefix: "fe",
      },
      backend: {
        name: "Backend",
        repo: "org/backend",
        path: join(tmpDir, "backend"),
        defaultBranch: "main",
        sessionPrefix: "be",
      },
    };

    const backendSubdir = join(tmpDir, "backend", "packages", "api");
    mkdirSync(backendSubdir, { recursive: true });
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(backendSubdir);

    const fakeSession: Session = {
      id: "be-1",
      projectId: "backend",
      status: "spawning",
      activity: null,
      branch: "feat/INT-42",
      issueId: "INT-42",
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-be-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };

    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    await program.parseAsync(["node", "test", "spawn", "INT-42"]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "backend",
      issueId: "INT-42",
    });
  });

  it("routes a <projectId>/<issue> identifier to the prefixed project", async () => {
    // Multi-project config where AO is running for the default project
    // but the issue belongs to a different project.
    (mockConfigRef.current as Record<string, unknown>).projects = {
      "agent-orchestrator": {
        name: "Agent Orchestrator",
        repo: "org/agent-orchestrator",
        path: join(tmpDir, "agent-orchestrator"),
        defaultBranch: "main",
        sessionPrefix: "ao",
      },
      "x402-identity": {
        name: "x402 Identity",
        repo: "harsh-batheja/x402-identity",
        path: join(tmpDir, "x402-identity"),
        defaultBranch: "main",
        sessionPrefix: "xid",
      },
    };
    mkdirSync(join(tmpDir, "agent-orchestrator"), { recursive: true });
    mkdirSync(join(tmpDir, "x402-identity"), { recursive: true });

    // The cwd shouldn't change the result — prefix takes priority.
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(join(tmpDir, "agent-orchestrator"));
    mockGetRunning.mockResolvedValue({
      pid: 1234,
      port: 3000,
      startedAt: "",
      projects: ["agent-orchestrator"],
    });

    const fakeSession: Session = {
      id: "xid-1",
      projectId: "x402-identity",
      status: "spawning",
      activity: null,
      branch: "feat/issue-1",
      issueId: "1",
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-xid-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };
    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    await program.parseAsync(["node", "test", "spawn", "x402-identity/1"]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "x402-identity",
      issueId: "1",
    });
  });

  it("routes via sessionPrefix when that matches instead of project id", async () => {
    (mockConfigRef.current as Record<string, unknown>).projects = {
      "agent-orchestrator": {
        name: "Agent Orchestrator",
        repo: "org/agent-orchestrator",
        path: join(tmpDir, "agent-orchestrator"),
        defaultBranch: "main",
        sessionPrefix: "ao",
      },
      "x402-identity": {
        name: "x402 Identity",
        repo: "harsh-batheja/x402-identity",
        path: join(tmpDir, "x402-identity"),
        defaultBranch: "main",
        sessionPrefix: "xid",
      },
    };
    mkdirSync(join(tmpDir, "agent-orchestrator"), { recursive: true });
    mkdirSync(join(tmpDir, "x402-identity"), { recursive: true });
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(join(tmpDir, "agent-orchestrator"));
    mockGetRunning.mockResolvedValue({
      pid: 1234,
      port: 3000,
      startedAt: "",
      projects: ["agent-orchestrator"],
    });

    const fakeSession: Session = {
      id: "xid-2",
      projectId: "x402-identity",
      status: "spawning",
      activity: null,
      branch: "feat/issue-7",
      issueId: "7",
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-xid-2", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };
    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    await program.parseAsync(["node", "test", "spawn", "xid/7"]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "x402-identity",
      issueId: "7",
    });
  });

  it("leaves the issueId untouched when the prefix is not a configured project", async () => {
    const fakeSession: Session = {
      id: "app-1",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/some-org-42",
      issueId: "some-org/42",
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };
    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    await program.parseAsync(["node", "test", "spawn", "some-org/42"]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "some-org/42",
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

    // No args: project auto-detected, no issue
    await program.parseAsync(["node", "test", "spawn"]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: undefined,
    });
  });

  it("shows dashboard URL instead of raw tmux attach", async () => {
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

    await program.parseAsync(["node", "test", "spawn"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("http://localhost:3000/projects/my-app/sessions/app-7");
    expect(output).not.toContain("tmux attach");
    expect(output).not.toContain("8474d6f29887-app-7");
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

    await program.parseAsync(["node", "test", "spawn", "--agent", "codex"]);

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

    await program.parseAsync(["node", "test", "spawn", "INT-42", "--agent", "codex"]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "INT-42",
      agent: "codex",
    });
  });

  it("shows a single optional issue positional in help", () => {
    const spawnCommand = program.commands.find((command) => command.name() === "spawn");
    const help = spawnCommand?.helpInformation() ?? "";

    expect(help).toContain("Usage:  spawn [options] [issue]");
    expect(help).not.toContain("[first]");
    expect(help).not.toContain("[second]");
  });

  it("rejects more than one positional arg with replacement usage", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      program.parseAsync(["node", "test", "spawn", "my-app", "INT-100"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).toContain("accepts at most 1 argument, but 2 were provided");
    expect(errors).toContain("Use:");
    expect(errors).toContain("ao spawn [issue]");
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("reports error when spawn fails", async () => {
    mockSessionManager.spawn.mockRejectedValue(new Error("worktree creation failed"));

    await expect(program.parseAsync(["node", "test", "spawn"])).rejects.toThrow(
      "process.exit(1)",
    );
  });

  it("claims a PR for the spawned session when --claim-pr is provided", async () => {
    const fakeSession: Session = {
      id: "app-1",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/new-session",
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
    mockSessionManager.claimPR.mockResolvedValue({
      sessionId: "app-1",
      projectId: "my-app",
      pr: {
        number: 123,
        url: "https://github.com/org/repo/pull/123",
        title: "Existing PR",
        owner: "org",
        repo: "repo",
        branch: "feat/claimed-pr",
        baseBranch: "main",
        isDraft: false,
      },
      branchChanged: true,
      githubAssigned: false,
      takenOverFrom: [],
    });

    await program.parseAsync(["node", "test", "spawn", "--claim-pr", "123"]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: undefined,
      agent: undefined,
    });
    expect(mockSessionManager.claimPR).toHaveBeenCalledWith("app-1", "123", {
      assignOnGithub: undefined,
    });

    const succeedMsg = String(mockSpinner.succeed.mock.calls[0]?.[0] ?? "");
    expect(succeedMsg).toContain("https://github.com/org/repo/pull/123");
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("http://localhost:3000/projects/my-app/sessions/app-1");
  });

  it("passes GitHub assignment flag through to claimPR", async () => {
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
    mockSessionManager.claimPR.mockResolvedValue({
      sessionId: "app-1",
      projectId: "my-app",
      pr: {
        number: 123,
        url: "https://github.com/org/repo/pull/123",
        title: "Existing PR",
        owner: "org",
        repo: "repo",
        branch: "feat/claimed-pr",
        baseBranch: "main",
        isDraft: false,
      },
      branchChanged: true,
      githubAssigned: true,
      takenOverFrom: ["app-9"],
    });

    await program.parseAsync([
      "node",
      "test",
      "spawn",
      "--claim-pr",
      "123",
      "--assign-on-github",
    ]);

    expect(mockSessionManager.claimPR).toHaveBeenCalledWith("app-1", "123", {
      assignOnGithub: true,
    });
  });

  it("rejects --assign-on-github without --claim-pr", async () => {
    await expect(
      program.parseAsync(["node", "test", "spawn", "--assign-on-github"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(errors).toContain("--assign-on-github requires --claim-pr");
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    expect(mockSessionManager.claimPR).not.toHaveBeenCalled();
  });

  it("reports claim failures after creating the session", async () => {
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
    mockSessionManager.claimPR.mockRejectedValue(new Error("already tracked by app-9"));

    await expect(
      program.parseAsync(["node", "test", "spawn", "--claim-pr", "123"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(errors).toContain(
      "Session app-1 was created, but failed to claim PR 123: already tracked by app-9",
    );
  });
});

describe("spawn pre-flight checks", () => {
  it("fails with clear error when tmux is not installed (default runtime)", async () => {
    mockExec.mockRejectedValue(new Error("ENOENT"));

    await expect(program.parseAsync(["node", "test", "spawn"])).rejects.toThrow(
      "process.exit(1)",
    );

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(errors).toContain("tmux");
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

    await program.parseAsync(["node", "test", "spawn"]);

    expect(mockSessionManager.spawn).toHaveBeenCalled();
  });

  it("checks gh auth when tracker is github", async () => {
    const projects = (mockConfigRef.current as Record<string, unknown>).projects as Record<
      string,
      Record<string, unknown>
    >;
    projects["my-app"].tracker = { plugin: "github" };

    // tmux check passes, gh --version passes, gh auth status fails
    mockExec
      .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" }) // tmux -V
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // gh --version
      .mockRejectedValueOnce(new Error("not logged in")); // gh auth status

    await expect(program.parseAsync(["node", "test", "spawn"])).rejects.toThrow(
      "process.exit(1)",
    );

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(errors).toContain("not authenticated");
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("checks gh auth when --claim-pr targets a github SCM project", async () => {
    const projects = (mockConfigRef.current as Record<string, unknown>).projects as Record<
      string,
      Record<string, unknown>
    >;
    projects["my-app"].tracker = { plugin: "linear" };
    projects["my-app"].scm = { plugin: "github" };

    mockExec
      .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" })
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" })
      .mockRejectedValueOnce(new Error("not logged in"));

    await expect(
      program.parseAsync(["node", "test", "spawn", "--claim-pr", "123"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(errors).toContain("not authenticated");
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("handles tracker+scm github preflight when claiming during spawn", async () => {
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
    mockSessionManager.claimPR.mockResolvedValue({
      sessionId: "app-1",
      projectId: "my-app",
      pr: {
        number: 123,
        url: "https://github.com/org/repo/pull/123",
        title: "Existing PR",
        owner: "org",
        repo: "repo",
        branch: "feat/claimed-pr",
        baseBranch: "main",
        isDraft: false,
      },
      branchChanged: true,
      githubAssigned: false,
      takenOverFrom: [],
    });

    const projects = (mockConfigRef.current as Record<string, unknown>).projects as Record<
      string,
      Record<string, unknown>
    >;
    projects["my-app"].tracker = { plugin: "github" };
    projects["my-app"].scm = { plugin: "github" };

    mockExec
      .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" })
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" })
      .mockResolvedValueOnce({ stdout: "Logged in", stderr: "" });

    await program.parseAsync(["node", "test", "spawn", "--claim-pr", "123"]);

    expect(mockExec).toHaveBeenCalledWith("tmux", ["-V"]);
    const ghCalls = mockExec.mock.calls.filter(([command]) => command === "gh");
    expect(ghCalls).toHaveLength(2);
    expect(mockSessionManager.spawn).toHaveBeenCalled();
    expect(mockSessionManager.claimPR).toHaveBeenCalledWith("app-1", "123", {
      assignOnGithub: undefined,
    });
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

    const projects = (mockConfigRef.current as Record<string, unknown>).projects as Record<
      string,
      Record<string, unknown>
    >;
    projects["my-app"].tracker = { plugin: "linear" };

    // tmux check passes — gh should never be called
    mockExec.mockResolvedValue({ stdout: "tmux 3.3a", stderr: "" });

    await program.parseAsync(["node", "test", "spawn"]);

    // Should only call tmux -V, not gh
    expect(mockExec).toHaveBeenCalledWith("tmux", ["-V"]);
    expect(mockExec).not.toHaveBeenCalledWith("gh", expect.anything());
    expect(mockSessionManager.spawn).toHaveBeenCalled();
  });

  it("distinguishes gh not installed from gh not authenticated", async () => {
    const projects = (mockConfigRef.current as Record<string, unknown>).projects as Record<
      string,
      Record<string, unknown>
    >;
    projects["my-app"].tracker = { plugin: "github" };

    // tmux passes, gh --version fails (not installed)
    mockExec
      .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" }) // tmux -V
      .mockRejectedValueOnce(new Error("ENOENT")); // gh --version fails

    await expect(program.parseAsync(["node", "test", "spawn"])).rejects.toThrow(
      "process.exit(1)",
    );

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(errors).toContain("not installed");
    expect(errors).not.toContain("not authenticated");
  });
});

describe("batch-spawn command", () => {
  function setupBatch(): Command {
    const cmd = new Command();
    cmd.exitOverride();
    registerBatchSpawn(cmd);
    return cmd;
  }

  function makeFakeSession(overrides: Partial<Session> & Pick<Session, "id" | "projectId">): Session {
    return {
      status: "spawning",
      activity: null,
      branch: null,
      issueId: null,
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: `hash-${overrides.id}`, runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
      ...overrides,
    } as Session;
  }

  beforeEach(() => {
    mockSessionManager.list.mockResolvedValue([]);
  });

  it("groups cross-project issues and routes each to the correct project", async () => {
    (mockConfigRef.current as Record<string, unknown>).projects = {
      "agent-orchestrator": {
        name: "Agent Orchestrator",
        repo: "org/agent-orchestrator",
        path: join(tmpDir, "agent-orchestrator"),
        defaultBranch: "main",
        sessionPrefix: "ao",
      },
      "x402-identity": {
        name: "x402 Identity",
        repo: "harsh-batheja/x402-identity",
        path: join(tmpDir, "x402-identity"),
        defaultBranch: "main",
        sessionPrefix: "xid",
      },
    };
    mkdirSync(join(tmpDir, "agent-orchestrator"), { recursive: true });
    mkdirSync(join(tmpDir, "x402-identity"), { recursive: true });
    mockGetRunning.mockResolvedValue({
      pid: 1234,
      port: 3000,
      startedAt: "",
      projects: ["agent-orchestrator", "x402-identity"],
    });

    mockSessionManager.spawn
      .mockResolvedValueOnce(makeFakeSession({ id: "ao-1", projectId: "agent-orchestrator" }))
      .mockResolvedValueOnce(makeFakeSession({ id: "xid-1", projectId: "x402-identity" }));

    const program = setupBatch();
    await program.parseAsync([
      "node",
      "test",
      "batch-spawn",
      "agent-orchestrator/10",
      "x402-identity/20",
    ]);

    const spawnCalls = mockSessionManager.spawn.mock.calls.map((call) => call[0]);
    expect(spawnCalls).toEqual(
      expect.arrayContaining([
        { projectId: "agent-orchestrator", issueId: "10" },
        { projectId: "x402-identity", issueId: "20" },
      ]),
    );
    expect(mockSessionManager.list).toHaveBeenCalledWith("agent-orchestrator");
    expect(mockSessionManager.list).toHaveBeenCalledWith("x402-identity");
    // Exactly one list() per project group — locks the grouping contract so a
    // regression that lists every project for every issue is caught.
    expect(mockSessionManager.list).toHaveBeenCalledTimes(2);
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(2);
  });

  it("skips a prefixed issue that already has an active session in the target project", async () => {
    (mockConfigRef.current as Record<string, unknown>).projects = {
      "agent-orchestrator": {
        name: "Agent Orchestrator",
        repo: "org/agent-orchestrator",
        path: join(tmpDir, "agent-orchestrator"),
        defaultBranch: "main",
        sessionPrefix: "ao",
      },
      "x402-identity": {
        name: "x402 Identity",
        repo: "harsh-batheja/x402-identity",
        path: join(tmpDir, "x402-identity"),
        defaultBranch: "main",
        sessionPrefix: "xid",
      },
    };
    mkdirSync(join(tmpDir, "agent-orchestrator"), { recursive: true });
    mkdirSync(join(tmpDir, "x402-identity"), { recursive: true });

    // Pre-existing active session in x402-identity for issue 20
    mockSessionManager.list.mockImplementation(async (pid: string) => {
      if (pid === "x402-identity") {
        return [
          makeFakeSession({
            id: "xid-9",
            projectId: "x402-identity",
            status: "working",
            issueId: "20",
          }),
        ];
      }
      return [];
    });

    mockSessionManager.spawn.mockResolvedValueOnce(
      makeFakeSession({ id: "ao-2", projectId: "agent-orchestrator" }),
    );

    const program = setupBatch();
    await program.parseAsync([
      "node",
      "test",
      "batch-spawn",
      "agent-orchestrator/10",
      "x402-identity/20",
    ]);

    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "agent-orchestrator",
      issueId: "10",
    });
  });
});
