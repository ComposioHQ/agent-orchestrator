import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Session, type SessionManager, getProjectBaseDir } from "@composio/ao-core";

const { mockExec, mockConfigRef, mockReadPlanBlob, mockSessionManager } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockReadPlanBlob: vi.fn(),
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
    createScheduler: ({ concurrencyCap }: { concurrencyCap: number }) => ({
      getReadyQueue: (graph: { nodes: Record<string, { id: string; dependencies?: string[]; state: string }> }) => {
        const nodes = Object.values(graph.nodes ?? {});
        const activeRunning = nodes.filter((node) => node.state === "running").length;
        const availableSlots = Math.max(0, concurrencyCap - activeRunning);
        const readyQueue = nodes
          .filter((node) => {
            if (node.state !== "ready" && node.state !== "pending") return false;
            const dependencies = Array.isArray(node.dependencies) ? node.dependencies : [];
            return dependencies.every((dependencyId) => graph.nodes[dependencyId]?.state === "complete");
          })
          .slice(0, availableSlots);
        return { readyQueue };
      },
    }),
    loadConfig: () => mockConfigRef.current,
    readPlanBlob: mockReadPlanBlob,
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
import { registerBatchSpawn, registerSpawn } from "../../src/commands/spawn.js";

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
  registerBatchSpawn(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockSessionManager.spawn.mockReset();
  mockSessionManager.list.mockReset();
  mockExec.mockReset();
  mockReadPlanBlob.mockReset();
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

  it("supports plan-task spawning via --plan-session", async () => {
    mockReadPlanBlob.mockReturnValue({
      planId: "workplan",
      planVersion: 1,
      planStatus: "validated",
      planPath: "plans/orch/workplan.v1.json",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      blob: {
        tasks: [{ id: "task-1", issueId: "INT-101", state: "ready" }],
      },
    });

    const fakeSession: Session = {
      id: "app-1",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/INT-101",
      issueId: "INT-101",
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };

    mockSessionManager.spawn.mockResolvedValue(fakeSession);

    await program.parseAsync([
      "node",
      "test",
      "spawn",
      "my-app",
      "task-1",
      "--plan-session",
      "orch-1",
    ]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "INT-101",
      agent: undefined,
    });
  });
});

describe("batch-spawn command", () => {
  it("spawns only scheduler-ready plan tasks and reports blocked reasons", async () => {
    mockSessionManager.list.mockResolvedValue([]);
    mockReadPlanBlob.mockReturnValue({
      planId: "workplan",
      planVersion: 2,
      planStatus: "validated",
      planPath: "plans/orch/workplan.v2.json",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      blob: {
        tasks: [
          { id: "task-1", issueId: "INT-201", state: "ready" },
          { id: "task-2", issueId: "INT-202", state: "pending", dependencies: ["task-1"] },
        ],
      },
    });
    mockSessionManager.spawn.mockResolvedValue({
      id: "app-2",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/INT-201",
      issueId: "INT-201",
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-app-2", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    } satisfies Session);

    await program.parseAsync([
      "node",
      "test",
      "batch-spawn",
      "my-app",
      "task-1",
      "task-2",
      "--plan-session",
      "orch-1",
    ]);

    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "INT-201",
      agent: undefined,
    });

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Scheduling rationale:");
    expect(output).toContain("Skip task-2 — blocked by incomplete dependencies: task-1");
  });

  it("unlocks dependent tasks once predecessor is complete", async () => {
    mockSessionManager.list.mockResolvedValue([]);
    mockSessionManager.spawn.mockResolvedValue({
      id: "app-3",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/INT-302",
      issueId: "INT-302",
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-app-3", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    } satisfies Session);

    mockReadPlanBlob.mockReturnValueOnce({
      planId: "workplan",
      planVersion: 1,
      planStatus: "validated",
      planPath: "plans/orch/workplan.v1.json",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      blob: {
        tasks: [
          { id: "task-1", issueId: "INT-301", state: "pending" },
          { id: "task-2", issueId: "INT-302", state: "pending", dependencies: ["task-1"] },
        ],
      },
    });

    await program.parseAsync([
      "node",
      "test",
      "batch-spawn",
      "my-app",
      "task-2",
      "--plan-session",
      "orch-2",
    ]);

    expect(mockSessionManager.spawn).not.toHaveBeenCalled();

    mockReadPlanBlob.mockReturnValueOnce({
      planId: "workplan",
      planVersion: 2,
      planStatus: "validated",
      planPath: "plans/orch/workplan.v2.json",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      blob: {
        tasks: [
          { id: "task-1", issueId: "INT-301", state: "complete" },
          { id: "task-2", issueId: "INT-302", state: "pending", dependencies: ["task-1"] },
        ],
      },
    });

    await program.parseAsync([
      "node",
      "test",
      "batch-spawn",
      "my-app",
      "task-2",
      "--plan-session",
      "orch-2",
    ]);

    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "INT-302",
      agent: undefined,
    });
  });

  it("retains duplicate detection for manual issue-based batch spawning", async () => {
    mockSessionManager.list.mockResolvedValue([
      {
        id: "existing-1",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: "feat/INT-401",
        issueId: "INT-401",
        pr: null,
        workspacePath: "/tmp/wt",
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      } satisfies Session,
    ]);

    mockSessionManager.spawn.mockResolvedValue({
      id: "app-4",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/INT-402",
      issueId: "INT-402",
      pr: null,
      workspacePath: "/tmp/wt",
      runtimeHandle: { id: "hash-app-4", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    } satisfies Session);

    await program.parseAsync([
      "node",
      "test",
      "batch-spawn",
      "my-app",
      "INT-401",
      "INT-402",
      "INT-402",
    ]);

    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "INT-402",
      agent: undefined,
    });
  });
});
