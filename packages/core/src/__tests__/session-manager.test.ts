import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSessionManager, inferProjectId } from "../session-manager.js";
import { writeMetadata, readMetadata, readMetadataRaw, deleteMetadata } from "../metadata.js";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";
import {
  SessionNotRestorableError,
  WorkspaceMissingError,
  type OrchestratorConfig,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type Workspace,
  type Tracker,
  type SCM,
  type RuntimeHandle,
} from "../types.js";

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockWorkspace: Workspace;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

function makeHandle(id: string): RuntimeHandle {
  return { id, runtimeName: "mock", data: {} };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-session-mgr-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  // Create a temporary config file
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  mockRuntime = {
    name: "mock",
    create: vi.fn().mockResolvedValue(makeHandle("rt-1")),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue(""),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  mockAgent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn().mockReturnValue("mock-agent --start"),
    getEnvironment: vi.fn().mockReturnValue({ AGENT_VAR: "1" }),
    detectActivity: vi.fn().mockReturnValue("active"),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  mockWorkspace = {
    name: "mock-ws",
    create: vi.fn().mockResolvedValue({
      path: "/tmp/mock-ws/app-1",
      branch: "feat/TEST-1",
      sessionId: "app-1",
      projectId: "my-app",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string, _name: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      if (slot === "workspace") return mockWorkspace;
      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn().mockResolvedValue(undefined),
    loadFromConfig: vi.fn().mockResolvedValue(undefined),
  };

  config = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
        tracker: { plugin: "github" },
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: [],
      info: [],
    },
    reactions: {},
    readyThresholdMs: 300_000,
  };

  // Calculate sessions directory
  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  // Clean up hash-based directories in ~/.agent-orchestrator
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "my-app"));
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }

  // Clean up tmpDir
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("spawn", () => {
  it("creates a session with workspace, runtime, and agent", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app" });

    expect(session.id).toBe("app-1");
    expect(session.status).toBe("spawning");
    expect(session.projectId).toBe("my-app");
    expect(session.runtimeHandle).toEqual(makeHandle("rt-1"));

    // Verify workspace was created
    expect(mockWorkspace.create).toHaveBeenCalled();
    // Verify agent launch command was requested
    expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
    // Verify runtime was created
    expect(mockRuntime.create).toHaveBeenCalled();
  });

  it("uses issue ID to derive branch name", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(session.branch).toBe("feat/INT-100");
    expect(session.issueId).toBe("INT-100");
  });

  it("uses tracker.branchName when tracker is available", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({}),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("custom/INT-100-my-feature"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });
    expect(session.branch).toBe("custom/INT-100-my-feature");
  });

  it("increments session numbers correctly", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    // Pre-create some metadata to simulate existing sessions
    writeMetadata(sessionsDir, "app-3", { worktree: "/tmp", branch: "b", status: "working" });
    writeMetadata(sessionsDir, "app-7", { worktree: "/tmp", branch: "b", status: "working" });

    const session = await sm.spawn({ projectId: "my-app" });
    expect(session.id).toBe("app-8");
  });

  it("writes metadata file", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    const meta = readMetadata(sessionsDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("spawning");
    expect(meta!.project).toBe("my-app");
    expect(meta!.issue).toBe("INT-42");
  });

  it("throws for unknown project", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.spawn({ projectId: "nonexistent" })).rejects.toThrow("Unknown project");
  });

  it("throws when runtime plugin is missing", async () => {
    const emptyRegistry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockReturnValue(null),
    };

    const sm = createSessionManager({ config, registry: emptyRegistry });
    await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow("not found");
  });

  it("validates issue exists when issueId provided", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "INT-100",
        title: "Test issue",
        description: "Test description",
        url: "https://linear.app/test/issue/INT-100",
        state: "open",
        labels: [],
      }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue("https://linear.app/test/issue/INT-100"),
      branchName: vi.fn().mockReturnValue("feat/INT-100"),
      generatePrompt: vi.fn().mockResolvedValue("Work on INT-100"),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(mockTracker.getIssue).toHaveBeenCalledWith("INT-100", config.projects["my-app"]);
    expect(session.issueId).toBe("INT-100");
  });

  it("succeeds with ad-hoc issue string when tracker returns IssueNotFoundError", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockRejectedValue(new Error("Issue INT-9999 not found")),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("feat/INT-9999"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    // Ad-hoc issue string should succeed — IssueNotFoundError is gracefully ignored
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-9999" });

    expect(session.issueId).toBe("INT-9999");
    expect(session.branch).toBe("feat/INT-9999");
    // Workspace and runtime should still be created
    expect(mockWorkspace.create).toHaveBeenCalled();
    expect(mockRuntime.create).toHaveBeenCalled();
  });

  it("fails on tracker auth errors", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockRejectedValue(new Error("Unauthorized")),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("feat/INT-100"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    await expect(sm.spawn({ projectId: "my-app", issueId: "INT-100" })).rejects.toThrow(
      "Failed to fetch issue",
    );

    // Should not create workspace or runtime when auth fails
    expect(mockWorkspace.create).not.toHaveBeenCalled();
    expect(mockRuntime.create).not.toHaveBeenCalled();
  });

  it("spawns without issue tracking when no issueId provided", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app" });

    expect(session.issueId).toBeNull();
    // Uses session/{sessionId} to avoid conflicts with default branch
    expect(session.branch).toMatch(/^session\/app-\d+$/);
    expect(session.branch).not.toBe("main");
  });
});

describe("list", () => {
  it("lists sessions from metadata", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/w1",
      branch: "feat/a",
      status: "working",
      project: "my-app",
    });
    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/w2",
      branch: "feat/b",
      status: "pr_open",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list();

    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id).sort()).toEqual(["app-1", "app-2"]);
  });

  it("filters by project ID", async () => {
    // In hash-based architecture, each project has its own directory
    // so filtering is implicit. This test verifies list(projectId) only
    // returns sessions from that project's directory.
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list("my-app");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("app-1");
  });

  it("marks dead runtimes as killed", async () => {
    const deadRuntime: Runtime = {
      ...mockRuntime,
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const registryWithDead: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return deadRuntime;
        if (slot === "agent") return mockAgent;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: registryWithDead });
    const sessions = await sm.list();

    expect(sessions[0].status).toBe("killed");
    expect(sessions[0].activity).toBe("exited");
  });

  it("detects activity using agent-native mechanism", async () => {
    const agentWithState: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    };
    const registryWithState: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithState;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({
      config,
      registry: registryWithState,
    });
    const sessions = await sm.list();

    // Verify getActivityState was called
    expect(agentWithState.getActivityState).toHaveBeenCalled();
    // Verify activity state was set
    expect(sessions[0].activity).toBe("active");
  });

  it("keeps existing activity when getActivityState throws", async () => {
    const agentWithError: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockRejectedValue(new Error("detection failed")),
    };
    const registryWithError: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithError;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: registryWithError });
    const sessions = await sm.list();

    // Should keep null (absent) when getActivityState fails
    expect(sessions[0].activity).toBeNull();
  });

  it("keeps existing activity when getActivityState returns null", async () => {
    const agentWithNull: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockResolvedValue(null),
    };
    const registryWithNull: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithNull;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: registryWithNull });
    const sessions = await sm.list();

    // null = "I don't know" — activity stays null (absent)
    expect(agentWithNull.getActivityState).toHaveBeenCalled();
    expect(sessions[0].activity).toBeNull();
  });

  it("updates lastActivityAt when detection timestamp is newer", async () => {
    const newerTimestamp = new Date(Date.now() + 60_000); // 1 minute in the future
    const agentWithTimestamp: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "active", timestamp: newerTimestamp }),
    };
    const registryWithTimestamp: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithTimestamp;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: registryWithTimestamp });
    const sessions = await sm.list();

    expect(sessions[0].activity).toBe("active");
    // lastActivityAt should be updated to the detection timestamp
    expect(sessions[0].lastActivityAt).toEqual(newerTimestamp);
  });

  it("does not downgrade lastActivityAt when detection timestamp is older", async () => {
    const olderTimestamp = new Date(0); // epoch — definitely older than session creation
    const agentWithOldTimestamp: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "active", timestamp: olderTimestamp }),
    };
    const registryWithOldTimestamp: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithOldTimestamp;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: registryWithOldTimestamp });
    const sessions = await sm.list();

    expect(sessions[0].activity).toBe("active");
    // lastActivityAt should NOT be downgraded to the older detection timestamp
    expect(sessions[0].lastActivityAt.getTime()).toBeGreaterThan(olderTimestamp.getTime());
  });
});

describe("get", () => {
  it("returns session by ID", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      pr: "https://github.com/org/repo/pull/42",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const session = await sm.get("app-1");

    expect(session).not.toBeNull();
    expect(session!.id).toBe("app-1");
    expect(session!.pr).not.toBeNull();
    expect(session!.pr!.number).toBe(42);
    expect(session!.pr!.url).toBe("https://github.com/org/repo/pull/42");
  });

  it("detects activity using agent-native mechanism", async () => {
    const agentWithState: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "idle" }),
    };
    const registryWithState: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithState;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({
      config,
      registry: registryWithState,
    });
    const session = await sm.get("app-1");

    // Verify getActivityState was called
    expect(agentWithState.getActivityState).toHaveBeenCalled();
    // Verify activity state was set
    expect(session!.activity).toBe("idle");
  });

  it("returns null for nonexistent session", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    expect(await sm.get("nonexistent")).toBeNull();
  });
});

describe("kill", () => {
  it("destroys runtime, workspace, and archives metadata", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-1");

    expect(mockRuntime.destroy).toHaveBeenCalledWith(makeHandle("rt-1"));
    expect(mockWorkspace.destroy).toHaveBeenCalledWith("/tmp/ws");
    expect(readMetadata(sessionsDir, "app-1")).toBeNull(); // archived + deleted
  });

  it("throws for nonexistent session", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.kill("nonexistent")).rejects.toThrow("not found");
  });

  it("tolerates runtime destroy failure", async () => {
    const failRuntime: Runtime = {
      ...mockRuntime,
      destroy: vi.fn().mockRejectedValue(new Error("already gone")),
    };
    const registryWithFail: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return failRuntime;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: registryWithFail });
    // Should not throw even though runtime.destroy fails
    await expect(sm.kill("app-1")).resolves.toBeUndefined();
  });
});

describe("cleanup", () => {
  it("kills sessions with merged PRs", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("merged"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/repo/pull/10",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM });
    const result = await sm.cleanup();

    expect(result.killed).toContain("app-1");
    expect(result.skipped).toHaveLength(0);
  });

  it("skips sessions without merged PRs or completed issues", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const result = await sm.cleanup();

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toContain("app-1");
  });

  it("kills sessions with dead runtimes", async () => {
    const deadRuntime: Runtime = {
      ...mockRuntime,
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const registryWithDead: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return deadRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: registryWithDead });
    const result = await sm.cleanup();

    expect(result.killed).toContain("app-1");
  });
});

describe("send", () => {
  it("sends message via runtime.sendMessage", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.send("app-1", "Fix the CI failures");

    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(makeHandle("rt-1"), "Fix the CI failures");
  });

  it("throws for nonexistent session", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.send("nope", "hello")).rejects.toThrow("not found");
  });

  it("falls back to session ID as runtime handle when no runtimeHandle stored", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.send("app-1", "hello");
    // Should use session ID "app-1" as the handle id with default runtime
    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      { id: "app-1", runtimeName: "mock", data: {} },
      "hello",
    );
  });
});

describe("spawnOrchestrator", () => {
  it("creates orchestrator session with correct ID", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.id).toBe("app-orchestrator");
    expect(session.status).toBe("working");
    expect(session.projectId).toBe("my-app");
    expect(session.branch).toBe("main");
    expect(session.issueId).toBeNull();
    expect(session.workspacePath).toBe(join(tmpDir, "my-app"));
  });

  it("writes metadata with proper fields", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawnOrchestrator({ projectId: "my-app" });

    const meta = readMetadata(sessionsDir, "app-orchestrator");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("working");
    expect(meta!.project).toBe("my-app");
    expect(meta!.worktree).toBe(join(tmpDir, "my-app"));
    expect(meta!.branch).toBe("main");
    expect(meta!.tmuxName).toBeDefined();
    expect(meta!.runtimeHandle).toBeDefined();
  });

  it("skips workspace creation", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(mockWorkspace.create).not.toHaveBeenCalled();
  });

  it("calls agent.setupWorkspaceHooks on project path", async () => {
    const agentWithHooks: Agent = {
      ...mockAgent,
      setupWorkspaceHooks: vi.fn().mockResolvedValue(undefined),
    };
    const registryWithHooks: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithHooks;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    const sm = createSessionManager({ config, registry: registryWithHooks });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(agentWithHooks.setupWorkspaceHooks).toHaveBeenCalledWith(
      join(tmpDir, "my-app"),
      expect.objectContaining({ dataDir: sessionsDir }),
    );
  });

  it("calls runtime.create with proper config", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(mockRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: join(tmpDir, "my-app"),
        launchCommand: "mock-agent --start",
      }),
    );
  });

  it("writes system prompt to file and passes systemPromptFile to agent", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawnOrchestrator({
      projectId: "my-app",
      systemPrompt: "You are the orchestrator.",
    });

    // Should pass systemPromptFile (not inline systemPrompt) to avoid tmux truncation
    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "app-orchestrator",
        systemPromptFile: expect.stringContaining("orchestrator-prompt.md"),
      }),
    );

    // Verify the file was actually written
    const callArgs = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
    const promptFile = callArgs.systemPromptFile!;
    expect(existsSync(promptFile)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(promptFile, "utf-8")).toBe("You are the orchestrator.");
  });

  it("throws for unknown project", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    await expect(sm.spawnOrchestrator({ projectId: "nonexistent" })).rejects.toThrow(
      "Unknown project",
    );
  });

  it("throws when runtime plugin is missing", async () => {
    const emptyRegistry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockReturnValue(null),
    };

    const sm = createSessionManager({ config, registry: emptyRegistry });

    await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow("not found");
  });

  it("returns session with runtimeHandle", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.runtimeHandle).toEqual(makeHandle("rt-1"));
  });
});

describe("restore", () => {
  it("restores a killed session with existing workspace", async () => {
    // Create a workspace directory that exists
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      issue: "TEST-1",
      pr: "https://github.com/org/my-app/pull/10",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const restored = await sm.restore("app-1");

    expect(restored.id).toBe("app-1");
    expect(restored.status).toBe("spawning");
    expect(restored.activity).toBe("active");
    expect(restored.workspacePath).toBe(wsPath);
    expect(restored.branch).toBe("feat/TEST-1");
    expect(restored.runtimeHandle).toEqual(makeHandle("rt-1"));
    expect(restored.restoredAt).toBeInstanceOf(Date);

    // Verify old runtime was destroyed before creating new one
    expect(mockRuntime.destroy).toHaveBeenCalledWith(makeHandle("rt-old"));
    expect(mockRuntime.create).toHaveBeenCalled();
    // Verify metadata was updated (not rewritten)
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["status"]).toBe("spawning");
    expect(meta!["restoredAt"]).toBeDefined();
    // Verify original fields are preserved
    expect(meta!["issue"]).toBe("TEST-1");
    expect(meta!["pr"]).toBe("https://github.com/org/my-app/pull/10");
    expect(meta!["createdAt"]).toBe("2025-01-01T00:00:00.000Z");
  });

  it("continues restore even if old runtime destroy fails", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    // Make destroy throw — should not block restore
    const failingRuntime = {
      ...mockRuntime,
      destroy: vi.fn().mockRejectedValue(new Error("session not found")),
      create: vi.fn().mockResolvedValue(makeHandle("rt-new")),
    };

    const registryWithFailingDestroy: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return failingRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManager({ config, registry: registryWithFailingDestroy });
    const restored = await sm.restore("app-1");

    expect(restored.status).toBe("spawning");
    expect(failingRuntime.destroy).toHaveBeenCalled();
    expect(failingRuntime.create).toHaveBeenCalled();
  });

  it("recreates workspace when missing and plugin supports restore", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    // DO NOT create the directory — it's missing

    const mockWorkspaceWithRestore: Workspace = {
      ...mockWorkspace,
      exists: vi.fn().mockResolvedValue(false),
      restore: vi.fn().mockResolvedValue({
        path: wsPath,
        branch: "feat/TEST-1",
        sessionId: "app-1",
        projectId: "my-app",
      }),
    };

    const registryWithRestore: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspaceWithRestore;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "terminated",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManager({ config, registry: registryWithRestore });
    const restored = await sm.restore("app-1");

    expect(restored.id).toBe("app-1");
    expect(mockWorkspaceWithRestore.restore).toHaveBeenCalled();
    expect(mockRuntime.create).toHaveBeenCalled();
  });

  it("throws SessionNotRestorableError for merged sessions", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "merged",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.restore("app-1")).rejects.toThrow(SessionNotRestorableError);
  });

  it("throws SessionNotRestorableError for working sessions", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.restore("app-1")).rejects.toThrow(SessionNotRestorableError);
  });

  it("throws WorkspaceMissingError when workspace gone and no restore method", async () => {
    const wsPath = join(tmpDir, "nonexistent-ws");

    const mockWorkspaceNoRestore: Workspace = {
      ...mockWorkspace,
      exists: vi.fn().mockResolvedValue(false),
      // No restore method
    };

    const registryNoRestore: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspaceNoRestore;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManager({ config, registry: registryNoRestore });
    await expect(sm.restore("app-1")).rejects.toThrow(WorkspaceMissingError);
  });

  it("restores a session from archive when active metadata is deleted", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    // Create metadata, then delete it (which archives it)
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      issue: "TEST-1",
      pr: "https://github.com/org/my-app/pull/10",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    // Archive it (deleteMetadata with archive=true is the default)
    deleteMetadata(sessionsDir, "app-1");

    // Verify active metadata is gone
    expect(readMetadataRaw(sessionsDir, "app-1")).toBeNull();

    // Restore should find it in archive
    const sm = createSessionManager({ config, registry: mockRegistry });
    const restored = await sm.restore("app-1");

    expect(restored.id).toBe("app-1");
    expect(restored.status).toBe("spawning");
    expect(restored.branch).toBe("feat/TEST-1");
    expect(restored.workspacePath).toBe(wsPath);

    // Verify active metadata was recreated
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!["issue"]).toBe("TEST-1");
    expect(meta!["pr"]).toBe("https://github.com/org/my-app/pull/10");
  });

  it("restores from archive with multiple archived versions (picks latest)", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    // Manually create two archive entries with different timestamps
    const archiveDir = join(sessionsDir, "archive");
    mkdirSync(archiveDir, { recursive: true });

    // Older archive — has stale branch
    writeFileSync(
      join(archiveDir, "app-1_2025-01-01T00-00-00-000Z"),
      "worktree=" + wsPath + "\nbranch=old-branch\nstatus=killed\nproject=my-app\n",
    );

    // Newer archive — has correct branch
    writeFileSync(
      join(archiveDir, "app-1_2025-06-15T12-00-00-000Z"),
      "worktree=" +
        wsPath +
        "\nbranch=feat/latest\nstatus=killed\nproject=my-app\n" +
        "runtimeHandle=" +
        JSON.stringify(makeHandle("rt-old")) +
        "\n",
    );

    const sm = createSessionManager({ config, registry: mockRegistry });
    const restored = await sm.restore("app-1");

    expect(restored.branch).toBe("feat/latest");
  });

  it("throws for nonexistent session (not in active or archive)", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.restore("nonexistent")).rejects.toThrow("not found");
  });

  it("uses getRestoreCommand when available", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    const mockAgentWithRestore: Agent = {
      ...mockAgent,
      getRestoreCommand: vi.fn().mockResolvedValue("claude --resume abc123"),
    };

    const registryWithAgentRestore: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgentWithRestore;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "errored",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManager({ config, registry: registryWithAgentRestore });
    await sm.restore("app-1");

    expect(mockAgentWithRestore.getRestoreCommand).toHaveBeenCalled();
    // Verify runtime.create was called with the restore command
    const createCall = (mockRuntime.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.launchCommand).toBe("claude --resume abc123");
  });

  it("falls back to getLaunchCommand when getRestoreCommand returns null", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    const mockAgentWithNullRestore: Agent = {
      ...mockAgent,
      getRestoreCommand: vi.fn().mockResolvedValue(null),
    };

    const registryWithNullRestore: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgentWithNullRestore;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManager({ config, registry: registryWithNullRestore });
    await sm.restore("app-1");

    expect(mockAgentWithNullRestore.getRestoreCommand).toHaveBeenCalled();
    expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
    const createCall = (mockRuntime.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.launchCommand).toBe("mock-agent --start");
  });

  it("preserves original createdAt/issue/PR metadata", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    const originalCreatedAt = "2024-06-15T10:00:00.000Z";
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-42",
      status: "killed",
      project: "my-app",
      issue: "TEST-42",
      pr: "https://github.com/org/my-app/pull/99",
      summary: "Implementing feature X",
      createdAt: originalCreatedAt,
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.restore("app-1");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["createdAt"]).toBe(originalCreatedAt);
    expect(meta!["issue"]).toBe("TEST-42");
    expect(meta!["pr"]).toBe("https://github.com/org/my-app/pull/99");
    expect(meta!["summary"]).toBe("Implementing feature X");
    expect(meta!["branch"]).toBe("feat/TEST-42");
  });
});

describe("PluginRegistry.loadBuiltins importFn", () => {
  it("should use provided importFn instead of built-in import", async () => {
    const { createPluginRegistry: createReg } = await import("../plugin-registry.js");
    const registry = createReg();
    const importedPackages: string[] = [];

    const fakeImportFn = async (pkg: string): Promise<unknown> => {
      importedPackages.push(pkg);
      // Return a valid plugin module for runtime-tmux
      if (pkg === "@composio/ao-plugin-runtime-tmux") {
        return {
          manifest: { name: "tmux", slot: "runtime", description: "test", version: "0.0.0" },
          create: () => ({ name: "tmux" }),
        };
      }
      // Throw for everything else to simulate not-installed
      throw new Error(`Module not found: ${pkg}`);
    };

    await registry.loadBuiltins(undefined, fakeImportFn);

    // importFn should have been called for all builtin plugins
    expect(importedPackages.length).toBeGreaterThan(0);
    expect(importedPackages).toContain("@composio/ao-plugin-runtime-tmux");

    // The tmux plugin should be registered
    const tmux = registry.get("runtime", "tmux");
    expect(tmux).not.toBeNull();
  });

  it("should pass importFn through loadFromConfig to loadBuiltins", async () => {
    const { createPluginRegistry: createReg } = await import("../plugin-registry.js");
    const registry = createReg();
    const importedPackages: string[] = [];

    const fakeImportFn = async (pkg: string): Promise<unknown> => {
      importedPackages.push(pkg);
      throw new Error(`Not found: ${pkg}`);
    };

    await registry.loadFromConfig(config, fakeImportFn);

    // Should have attempted to import builtin plugins via the provided importFn
    expect(importedPackages.length).toBeGreaterThan(0);
    expect(importedPackages).toContain("@composio/ao-plugin-runtime-tmux");
  });
});

describe("inferProjectId", () => {
  it("matches session ID prefix to project sessionPrefix", () => {
    const projects = {
      "my-app": { ...config.projects["my-app"], sessionPrefix: "app" },
      integrator: {
        ...config.projects["my-app"],
        name: "Integrator",
        sessionPrefix: "int",
        path: "/tmp/integrator",
      },
    };
    expect(inferProjectId("app-1", projects)).toBe("my-app");
    expect(inferProjectId("int-42", projects)).toBe("integrator");
    expect(inferProjectId("app-100", projects)).toBe("my-app");
  });

  it("falls back to single project when prefix doesn't match", () => {
    const projects = {
      "my-app": { ...config.projects["my-app"], sessionPrefix: "app" },
    };
    expect(inferProjectId("unknown-5", projects)).toBe("my-app");
  });

  it("returns empty string when no match and multiple projects", () => {
    const projects = {
      "my-app": { ...config.projects["my-app"], sessionPrefix: "app" },
      integrator: {
        ...config.projects["my-app"],
        name: "Integrator",
        sessionPrefix: "int",
        path: "/tmp/integrator",
      },
    };
    expect(inferProjectId("unknown-5", projects)).toBe("");
  });

  it("returns empty string for empty projects config", () => {
    expect(inferProjectId("app-1", {})).toBe("");
  });

  it("uses list to infer projectId for legacy sessions without project field", async () => {
    // Write a session without project field (legacy metadata)
    writeMetadata(sessionsDir, "app-5", {
      worktree: "/tmp",
      branch: "feat/legacy",
      status: "working",
      // no project field
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list();

    const legacySession = sessions.find((s) => s.id === "app-5");
    expect(legacySession).toBeDefined();
    // Should infer "my-app" because "app" prefix matches
    expect(legacySession!.projectId).toBe("my-app");
  });
});
