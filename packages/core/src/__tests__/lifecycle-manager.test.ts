import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { createSessionManager } from "../session-manager.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  Agent,
  SCM,
  Notifier,
  ActivityState,
  PRInfo,
} from "../types.js";

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockSessionManager: SessionManager;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "spawning",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://github.com/org/repo/pull/42",
    title: "Fix things",
    owner: "org",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-lifecycle-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  // Create a temporary config file
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  mockRuntime = {
    name: "mock",
    create: vi.fn(),
    destroy: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue("$ some terminal output\n"),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  mockAgent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn(),
    getEnvironment: vi.fn(),
    detectActivity: vi.fn().mockReturnValue("active" as ActivityState),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" as ActivityState }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };

  mockSessionManager = {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    claimPR: vi.fn(),
  } as SessionManager;

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

describe("start / stop", () => {
  it("starts and stops the polling loop", () => {
    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    // Should not throw on double start
    lm.start(60_000);
    lm.stop();
    // Should not throw on double stop
    lm.stop();
  });

  it("respawns the orchestrator when open work exists but the orchestrator is dead", async () => {
    vi.mocked(mockSessionManager.list).mockResolvedValue([
      makeSession({ id: "app-1", status: "working" }),
      makeSession({
        id: "app-orchestrator",
        status: "killed",
        branch: "main",
        metadata: { role: "orchestrator" },
      }),
    ]);
    vi.mocked(mockSessionManager.spawnOrchestrator).mockResolvedValue(
      makeSession({
        id: "app-orchestrator",
        status: "working",
        branch: "main",
        metadata: { role: "orchestrator" },
      }),
    );

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      projectId: "my-app",
    });

    lm.start(60_000);

    await vi.waitFor(() => {
      expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledWith({
        projectId: "my-app",
        systemPrompt: expect.stringContaining("# My App Orchestrator"),
        prompt: expect.stringContaining("Do an initial orchestration pass"),
      });
    });

    lm.stop();
  });

  it("does not respawn the orchestrator when there is no open work", async () => {
    vi.mocked(mockSessionManager.list).mockResolvedValue([
      makeSession({
        id: "app-orchestrator",
        status: "killed",
        branch: "main",
        metadata: { role: "orchestrator" },
      }),
    ]);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      projectId: "my-app",
    });

    lm.start(60_000);

    await vi.waitFor(() => {
      expect(mockSessionManager.list).toHaveBeenCalledWith("my-app");
    });
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();

    lm.stop();
  });

  it("treats 'terminated' orchestrators as dead and respawns when open work exists", async () => {
    vi.mocked(mockSessionManager.list).mockResolvedValue([
      makeSession({
        id: "app-orchestrator",
        status: "terminated" as any,
        branch: "main",
        metadata: { role: "orchestrator" },
      }),
      makeSession({ id: "app-1", status: "working", runtimeHandle: undefined }),
    ]);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      projectId: "my-app",
    });

    lm.start(60_000);

    await vi.waitFor(() => {
      expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalled();
    });

    lm.stop();
  });

  it("does not treat 'done' sessions as open work", async () => {
    vi.mocked(mockSessionManager.list).mockResolvedValue([
      makeSession({
        id: "app-orchestrator",
        status: "killed",
        branch: "main",
        metadata: { role: "orchestrator" },
      }),
      makeSession({ id: "app-1", status: "done" as any }),
    ]);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      projectId: "my-app",
    });

    lm.start(60_000);

    await vi.waitFor(() => {
      expect(mockSessionManager.list).toHaveBeenCalledWith("my-app");
    });
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();

    lm.stop();
  });

  it("refreshes sessions after respawning the orchestrator so stale killed metadata is not re-applied", async () => {
    vi.useFakeTimers();
    vi.mocked(mockRuntime.isAlive).mockImplementation(async (handle) => handle.id !== "rt-dead");

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      runtimeHandle: JSON.stringify({ id: "rt-live", runtimeName: "mock", data: {} }),
    });

    const worker = makeSession({ id: "app-1", status: "working", runtimeHandle: undefined });
    const liveOrchestrator = makeSession({
      id: "app-orchestrator",
      status: "working",
      branch: "main",
      runtimeHandle: { id: "rt-live", runtimeName: "mock", data: {} },
      metadata: { role: "orchestrator" },
    });
    const deadOrchestrator = makeSession({
      id: "app-orchestrator",
      status: "killed",
      branch: "main",
      runtimeHandle: { id: "rt-dead", runtimeName: "mock", data: {} },
      metadata: { role: "orchestrator" },
    });
    const respawnedOrchestrator = makeSession({
      id: "app-orchestrator",
      status: "working",
      branch: "main",
      runtimeHandle: { id: "rt-new", runtimeName: "mock", data: {} },
      metadata: { role: "orchestrator" },
    });

    vi.mocked(mockSessionManager.list)
      .mockResolvedValueOnce([worker, liveOrchestrator])
      .mockResolvedValueOnce([worker, deadOrchestrator])
      .mockResolvedValue([worker, respawnedOrchestrator]);
    vi.mocked(mockSessionManager.spawnOrchestrator).mockResolvedValue(respawnedOrchestrator);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      projectId: "my-app",
    });

    lm.start(1_000);
    await vi.waitFor(() => {
      expect(lm.getStates().get("app-orchestrator")).toBe("working");
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledTimes(1);
    });

    expect(readMetadataRaw(sessionsDir, "app-orchestrator")?.["status"]).toBe("working");
    expect(lm.getStates().get("app-orchestrator")).toBe("working");

    lm.stop();
    vi.useRealTimers();
  });
});

describe("check (single session)", () => {
  it("detects transition from spawning to working", async () => {
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    // Write metadata so updateMetadata works
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");

    // Metadata should be updated
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["status"]).toBe("working");
  });

  it("uses worker-specific agent fallback when metadata does not persist an agent", async () => {
    const codexAgent: Agent = {
      ...mockAgent,
      name: "codex",
      processName: "codex",
      getActivityState: vi.fn().mockResolvedValue({ state: "active" as ActivityState }),
    };
    const registryWithMultipleAgents: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") {
          if (name === "codex") return codexAgent;
          if (name === "mock-agent") return mockAgent;
        }
        return null;
      }),
    };
    const configWithWorkerAgent: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agent: "mock-agent",
          worker: {
            agent: "codex",
          },
        },
      },
    };
    const session = makeSession({ status: "working", metadata: {} });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: configWithWorkerAgent,
      registry: registryWithMultipleAgents,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(codexAgent.getActivityState).toHaveBeenCalled();
    expect(mockAgent.getActivityState).not.toHaveBeenCalled();
  });

  it("detects killed state when runtime is dead", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("detects killed state when getActivityState returns exited", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "exited" });

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("detects killed via terminal fallback when getActivityState returns null", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue(null);
    vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");
    vi.mocked(mockAgent.isProcessRunning).mockResolvedValue(false);

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("stays working when agent is idle but process is still running (fallback path)", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue(null);
    vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");
    vi.mocked(mockAgent.isProcessRunning).mockResolvedValue(true);

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("detects needs_input from agent", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "waiting_input" });

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("transitions to stuck when idle exceeds agent-stuck threshold (OpenCode-style activity)", async () => {
    config.reactions = {
      "agent-stuck": {
        auto: true,
        action: "notify",
        threshold: "1m",
      },
    };

    vi.mocked(mockAgent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });

    const session = makeSession({ status: "working", metadata: { agent: "opencode" } });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("uses global agent-stuck threshold when project override omits threshold", async () => {
    config.reactions = {
      "agent-stuck": {
        auto: true,
        action: "notify",
        threshold: "1m",
      },
    };
    config.projects["my-app"] = {
      ...config.projects["my-app"],
      reactions: {
        "agent-stuck": {
          auto: true,
          action: "notify",
        },
      },
    };

    vi.mocked(mockAgent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });

    const session = makeSession({ status: "working", metadata: { agent: "opencode" } });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("still auto-detects PR before marking idle sessions as stuck", async () => {
    config.reactions = {
      "agent-stuck": {
        auto: true,
        action: "notify",
        threshold: "1m",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn().mockResolvedValue(makePR()),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    vi.mocked(mockAgent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });

    const session = makeSession({
      status: "working",
      branch: "feat/test",
      pr: null,
      metadata: { agent: "opencode" },
    });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "working",
      project: "my-app",
      agent: "opencode",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).toHaveBeenCalledOnce();
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["pr"]).toBe(makePR().url);
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("preserves stuck state when getActivityState throws", async () => {
    vi.mocked(mockAgent.getActivityState).mockRejectedValue(new Error("probe failed"));

    const session = makeSession({ status: "stuck" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "stuck",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Should preserve "stuck" — NOT coerce to "working"
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("preserves needs_input state when getActivityState throws", async () => {
    vi.mocked(mockAgent.getActivityState).mockRejectedValue(new Error("probe failed"));

    const session = makeSession({ status: "needs_input" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "needs_input",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Should preserve "needs_input" — NOT coerce to "working"
    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("preserves stuck state when getActivityState returns null and getOutput throws", async () => {
    vi.mocked(mockAgent.getActivityState).mockResolvedValue(null);
    vi.mocked(mockRuntime.getOutput).mockRejectedValue(new Error("tmux error"));

    const session = makeSession({ status: "stuck" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "stuck",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // getOutput failure should hit the catch block and preserve "stuck"
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("detects PR states from SCM", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("ci_failed");
  });

  it("skips PR auto-detection when metadata disables it", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn().mockResolvedValue(makePR()),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "working",
      project: "my-app",
      prAutoDetect: "off",
    });

    const realSessionManager = createSessionManager({
      config,
      registry: registryWithSCM,
    });
    const session = await realSessionManager.get("app-1");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("skips PR auto-detection for orchestrator sessions", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn().mockResolvedValue(makePR()),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "master",
      status: "working",
      project: "my-app",
      role: "orchestrator",
    });

    const realSessionManager = createSessionManager({
      config,
      registry: registryWithSCM,
    });
    const session = await realSessionManager.get("app-1");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("skips PR auto-detection for orchestrator sessions identified by ID suffix (fallback)", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn().mockResolvedValue(makePR()),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    // Session has no role metadata but ID ends with "-orchestrator"
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: "/tmp",
      branch: "master",
      status: "working",
      project: "my-app",
    });

    const realSessionManager = createSessionManager({
      config,
      registry: registryWithSCM,
    });
    const session = await realSessionManager.get("app-orchestrator");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-orchestrator");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-orchestrator")).toBe("working");
  });

  it("detects merged PR", async () => {
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
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "approved", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "approved",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
  });

  it("destroys the runtime using the session handle runtime name on terminal transitions", async () => {
    const tmuxRuntime: Runtime = {
      ...mockRuntime,
      name: "tmux",
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const dockerRuntime: Runtime = {
      ...mockRuntime,
      name: "docker",
      destroy: vi.fn().mockResolvedValue(undefined),
    };
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

    config.defaults.runtime = "docker";
    config.projects["my-app"] = {
      ...config.projects["my-app"],
      runtime: "docker",
    };

    const registryWithRuntimeMismatch: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime" && name === "tmux") return tmuxRuntime;
        if (slot === "runtime" && name === "docker") return dockerRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({
      status: "approved",
      pr: makePR(),
      runtimeHandle: { id: "tmux-app-1", runtimeName: "tmux", data: {} },
    });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "approved",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithRuntimeMismatch,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(tmuxRuntime.destroy).toHaveBeenCalledWith(session.runtimeHandle);
    expect(dockerRuntime.destroy).not.toHaveBeenCalled();
  });

  it("detects mergeable when approved + CI green", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("mergeable");
  });

  it("auto-merge reaction uses direct session lookup instead of listing all sessions", async () => {
    config.reactions = {
      "approved-and-green": {
        auto: true,
        action: "auto-merge",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn().mockResolvedValue(undefined),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const mockNotifier: Notifier = {
      name: "desktop",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const session = makeSession({ status: "approved", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.list).mockRejectedValue(
      new Error("auto-merge should not list all sessions"),
    );

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "approved",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("mergeable");
    expect(mockSCM.mergePR).toHaveBeenCalledWith(session.pr, "squash");
    expect(mockSessionManager.list).not.toHaveBeenCalled();
    expect(mockSessionManager.get).toHaveBeenCalledTimes(2);
  });

  it("auto-merges steady-state mergeable sessions after lifecycle restart", async () => {
    config.reactions = {
      "approved-and-green": {
        auto: true,
        action: "auto-merge",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn().mockResolvedValue(undefined),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    };

    const mockNotifier: Notifier = {
      name: "desktop",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const session = makeSession({ status: "mergeable", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "mergeable",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("mergeable");
    expect(mockSCM.mergePR).toHaveBeenCalledWith(session.pr, "squash");
  });

  it("throws for nonexistent session", async () => {
    vi.mocked(mockSessionManager.get).mockResolvedValue(null);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await expect(lm.check("nonexistent")).rejects.toThrow("not found");
  });

  it("does not change state when status is unchanged", async () => {
    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");

    // Second check — status remains working, no transition
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");
  });
});

describe("reactions", () => {
  it("triggers send-to-agent reaction on CI failure", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing. Fix it.",
        retries: 2,
        escalateAfter: 2,
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "CI is failing. Fix it.");
  });

  it("does not trigger reaction when auto=false", async () => {
    config.reactions = {
      "ci-failed": {
        auto: false,
        action: "send-to-agent",
        message: "CI is failing.",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });
  it("suppresses immediate notification when send-to-agent reaction handles the event", async () => {
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    // Session transitions from pr_open → ci_failed, which maps to ci-failed reaction
    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    // Configure send-to-agent reaction for ci-failed with retries
    const configWithReaction = {
      ...config,
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent" as const,
          message: "Fix CI",
          retries: 3,
          escalateAfter: 3,
        },
      },
    };

    const lm = createLifecycleManager({
      config: configWithReaction,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    // send-to-agent reaction should have been executed
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Fix CI");
    // Notifier should NOT have been called — the reaction is handling it
    expect(mockNotifier.notify).not.toHaveBeenCalled();
  });

  it("retries a failed ci_failed send-to-agent reaction on subsequent polls", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("failing"),
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
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const pr = makePR();
    const session = makeSession({ status: "pr_open", pr });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send)
      .mockRejectedValueOnce(new Error("delivery failed"))
      .mockResolvedValueOnce(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
      pr: pr.url,
    });

    const configWithReaction = {
      ...config,
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent" as const,
          message: "Fix CI",
          retries: 3,
          escalateAfter: 3,
        },
      },
    };

    const lm = createLifecycleManager({
      config: configWithReaction,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    session.status = "ci_failed";
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "ci_failed",
      project: "my-app",
      pr: pr.url,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(2);
    expect(mockSessionManager.send).toHaveBeenLastCalledWith("app-1", "Fix CI");
  });

  it("dispatches unresolved review comments even when reviewDecision stays unchanged", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Handle review comments.",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn().mockResolvedValue([
        {
          id: "c1",
          author: "reviewer",
          body: "Please rename this helper",
          path: "src/app.ts",
          line: 12,
          isResolved: false,
          createdAt: new Date(),
          url: "https://example.com/comment/1",
        },
      ]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Handle review comments.");

    vi.mocked(mockSessionManager.send).mockClear();
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    const metadata = readMetadataRaw(sessionsDir, "app-1");
    expect(metadata?.["lastPendingReviewDispatchHash"]).toBe("c1");
  });

  it("does not double-send when changes_requested transition already triggered the reaction", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Handle requested changes.",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("changes_requested"),
      getPendingComments: vi.fn().mockResolvedValue([
        {
          id: "c1",
          author: "reviewer",
          body: "Please add validation",
          path: "src/route.ts",
          line: 44,
          isResolved: false,
          createdAt: new Date(),
          url: "https://example.com/comment/2",
        },
      ]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    await lm.check("app-1");

    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Handle requested changes.");
  });

  it("dispatches automated review comments only once for an unchanged backlog", async () => {
    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        message: "Handle automated review findings.",
      },
    };

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn().mockResolvedValue([
        {
          id: "bot-1",
          botName: "cursor[bot]",
          body: "Potential issue detected",
          path: "src/worker.ts",
          line: 9,
          severity: "warning",
          createdAt: new Date(),
          url: "https://example.com/comment/3",
        },
      ]),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-1",
      "Handle automated review findings.",
    );

    vi.mocked(mockSessionManager.send).mockClear();
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    const metadata = readMetadataRaw(sessionsDir, "app-1");
    expect(metadata?.["lastAutomatedReviewDispatchHash"]).toBe("bot-1");
  });

  it("notifies humans on significant transitions without reaction config", async () => {
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

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

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    // merge.completed has "action" priority but NO reaction key mapping,
    // so it must reach notifyHuman directly
    const session = makeSession({ status: "approved", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "approved",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(mockNotifier.notify).toHaveBeenCalled();
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "merge.completed" }),
    );
  });
});

describe("getStates", () => {
  it("returns copy of states map", async () => {
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    const states = lm.getStates();
    expect(states.get("app-1")).toBe("working");

    // Modifying returned map shouldn't affect internal state
    states.set("app-1", "killed");
    expect(lm.getStates().get("app-1")).toBe("working");
  });
});
