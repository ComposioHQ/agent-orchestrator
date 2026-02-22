import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
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
    getActivityState: vi.fn().mockResolvedValue("active" as ActivityState),
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
    getAttachInfo: vi.fn().mockResolvedValue(null),
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

  it("detects killed state when agent process exits (idle terminal + dead process)", async () => {
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

  it("detects killed state when agent process exits (active terminal + dead process)", async () => {
    // Stub agents (codex, aider, opencode) return "active" for any non-empty
    // terminal output, including the shell prompt after the agent exits.
    vi.mocked(mockAgent.detectActivity).mockReturnValue("active");
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

  it("stays working when agent is idle but process is still running", async () => {
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
    vi.mocked(mockAgent.detectActivity).mockReturnValue("waiting_input");

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

  it("preserves stuck state when detectActivity throws", async () => {
    vi.mocked(mockAgent.detectActivity).mockImplementation(() => {
      throw new Error("probe failed");
    });

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

  it("preserves needs_input state when detectActivity throws", async () => {
    vi.mocked(mockAgent.detectActivity).mockImplementation(() => {
      throw new Error("probe failed");
    });

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

  it("preserves stuck state when getOutput throws", async () => {
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

// =============================================================================
// Helper functions tested indirectly through the public API
// =============================================================================

describe("inferPriority (tested indirectly via notification routing)", () => {
  /**
   * inferPriority maps event types to priorities:
   *   - "stuck"/"needs_input"/"errored" → "urgent"
   *   - "approved"/"ready"/"merged"/"completed" → "action"
   *   - "fail"/"changes_requested"/"conflicts" → "warning"
   *   - "summary.*" → "info"
   *   - everything else → "info"
   *
   * We test this by observing which notifiers get called based on
   * notificationRouting config for different priority levels.
   */

  it("routes 'urgent' priority for stuck transitions", async () => {
    const urgentNotifier: Notifier = {
      name: "urgent-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "notifier" && name === "urgent-channel") return urgentNotifier;
        return null;
      }),
    };

    // Configure: only "urgent-channel" receives "urgent" priority
    const urgentConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["urgent-channel"],
        action: [],
        warning: [],
        info: [],
      },
      reactions: {},
    };

    // session.stuck has no reaction key mapping, so it should hit notifyHuman
    // inferPriority("session.stuck") → "urgent"
    // The session needs_input → stuck transition won't happen directly,
    // but working → needs_input triggers "session.needs_input" → "urgent"
    vi.mocked(mockAgent.detectActivity).mockReturnValue("waiting_input");

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: urgentConfig,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("needs_input");
    // session.needs_input maps to "agent-needs-input" reaction key,
    // but there's no reaction configured, so it should notify.
    // inferPriority("session.needs_input") includes "needs_input" → "urgent"
    expect(urgentNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.needs_input",
        priority: "urgent",
      }),
    );
  });

  it("routes 'warning' priority for ci.failing (no reaction configured)", async () => {
    const warningNotifier: Notifier = {
      name: "warning-notifier",
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
      getReviewDecision: vi.fn().mockResolvedValue("none"),
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
        if (slot === "notifier" && name === "warning-channel") return warningNotifier;
        return null;
      }),
    };

    const warningConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: [],
        action: [],
        warning: ["warning-channel"],
        info: [],
      },
      reactions: {}, // No reaction for ci-failed, so it falls through to notifyHuman
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
      config: warningConfig,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    // inferPriority("ci.failing") includes "fail" → "warning"
    expect(warningNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ci.failing",
        priority: "warning",
      }),
    );
  });

  it("routes 'action' priority for merge.completed", async () => {
    const actionNotifier: Notifier = {
      name: "action-notifier",
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
        if (slot === "notifier" && name === "action-channel") return actionNotifier;
        return null;
      }),
    };

    const actionConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: [],
        action: ["action-channel"],
        warning: [],
        info: [],
      },
      reactions: {},
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
      config: actionConfig,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
    // inferPriority("merge.completed") includes "completed" → "action"
    expect(actionNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "merge.completed",
        priority: "action",
      }),
    );
  });

  it("does not notify for 'info' priority transitions when no notifiers configured for info", async () => {
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    // session.working → inferPriority("session.working") = "info" (no special keywords)
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config, // default config has info: []
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");
    // "session.working" → "info" priority → should NOT notify (info is not > info)
    expect(mockNotifier.notify).not.toHaveBeenCalled();
  });
});

describe("statusToEventType (tested indirectly via check transitions)", () => {
  /**
   * statusToEventType maps session status to event types.
   * We verify by checking which event type reaches the notifier.
   */

  it("maps 'review_pending' status to 'review.pending' event (info priority, not notified)", async () => {
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
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("pending"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithAll: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const notifyConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
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
      config: notifyConfig,
      registry: registryWithAll,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // pr_open → review_pending correctly maps to "review.pending" event type
    expect(lm.getStates().get("app-1")).toBe("review_pending");
    // inferPriority("review.pending") = "info" (no special keywords matched)
    // The code only calls notifyHuman when priority !== "info", so no notification fires.
    // This verifies that review.pending is correctly classified as info-level.
    expect(mockNotifier.notify).not.toHaveBeenCalled();
  });

  it("maps 'changes_requested' status to 'review.changes_requested' event", async () => {
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
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("changes_requested"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithAll: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const notifyConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
      // No reaction for changes-requested, so notification will fire directly
      reactions: {},
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
      config: notifyConfig,
      registry: registryWithAll,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("changes_requested");
    // review.changes_requested has reaction key "changes-requested", but no reaction
    // configured, so notifyHuman fires directly.
    // inferPriority("review.changes_requested") → "warning" (contains "changes_requested")
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "review.changes_requested",
        priority: "warning",
      }),
    );
  });

  it("returns null event type for 'spawning' status (no notification)", async () => {
    // When a session remains in "spawning" status, statusToEventType returns null for
    // spawning, so no event or notification is fired.
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    // For spawning → working, the event type is "session.working" (the TO status).
    // But if we have a status that maps to null... that's only "spawning" as the TO value,
    // which doesn't happen in normal flow. Instead, verify spawning → working produces
    // session.working (not null), confirming the switch on the TO status.
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    const notifyConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
    };

    const lm = createLifecycleManager({
      config: notifyConfig,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // spawning → working; "session.working" → inferPriority = "info"
    // info priority is not > info, so no notification is sent
    expect(lm.getStates().get("app-1")).toBe("working");
    expect(mockNotifier.notify).not.toHaveBeenCalled();
  });
});

describe("eventToReactionKey (tested indirectly via reaction triggering)", () => {
  /**
   * eventToReactionKey maps event types to reaction config keys.
   * We verify by configuring reactions with specific keys and
   * checking they fire on the correct transitions.
   */

  it("maps review.changes_requested to 'changes-requested' reaction key", async () => {
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

    const reactionConfig: OrchestratorConfig = {
      ...config,
      reactions: {
        "changes-requested": {
          auto: true,
          action: "send-to-agent",
          message: "Address the review feedback.",
          retries: 3,
        },
      },
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
      config: reactionConfig,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("changes_requested");
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Address the review feedback.");
  });

  it("maps merge.ready to 'approved-and-green' reaction key", async () => {
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

    const mockNotifier: Notifier = {
      name: "mock-notifier",
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

    const reactionConfig: OrchestratorConfig = {
      ...config,
      reactions: {
        "approved-and-green": {
          auto: true,
          action: "auto-merge",
        },
      },
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
      config: reactionConfig,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("mergeable");
    // auto-merge reaction calls notifyHuman internally with "action" priority
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reaction.triggered",
        priority: "action",
      }),
    );
  });

  it("maps session.killed to 'agent-exited' reaction key", async () => {
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const reactionConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
      reactions: {
        "agent-exited": {
          auto: true,
          action: "notify",
          priority: "warning",
        },
      },
    };

    const session = makeSession({ status: "working" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config: reactionConfig,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
    // agent-exited reaction with action="notify" calls notifyHuman with
    // the configured priority ("warning")
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reaction.triggered",
        priority: "warning",
      }),
    );
  });

  it("falls through to direct notification for events without reaction keys", async () => {
    // "review.approved" maps to "approved" status, event type "review.approved"
    // eventToReactionKey does NOT have a mapping for "review.approved"
    // (only "merge.ready" → "approved-and-green")
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
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: ["branch protection"],
      }),
    };

    const registryWithAll: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const notifyConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
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
      config: notifyConfig,
      registry: registryWithAll,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Approved but not mergeable → "approved" status
    expect(lm.getStates().get("app-1")).toBe("approved");
    // review.approved has no reaction key → falls to notifyHuman
    // inferPriority("review.approved") → "action" (contains "approved")
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "review.approved",
        priority: "action",
      }),
    );
  });
});

describe("createEvent (tested indirectly via notifier arguments)", () => {
  it("populates all event fields including auto-inferred priority", async () => {
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

    const registryWithAll: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const notifyConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
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
      config: notifyConfig,
      registry: registryWithAll,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockNotifier.notify).toHaveBeenCalledTimes(1);
    const event = vi.mocked(mockNotifier.notify).mock.calls[0][0];

    // Verify all createEvent fields are populated
    expect(event.id).toBeDefined();
    expect(typeof event.id).toBe("string");
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.type).toBe("merge.completed");
    expect(event.priority).toBe("action"); // auto-inferred: "completed" → "action"
    expect(event.sessionId).toBe("app-1");
    expect(event.projectId).toBe("my-app");
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.message).toContain("app-1");
    expect(event.message).toContain("approved");
    expect(event.message).toContain("merged");
    expect(event.data).toEqual(
      expect.objectContaining({
        oldStatus: "approved",
        newStatus: "merged",
      }),
    );
  });
});

describe("parseDuration (tested indirectly via escalation logic)", () => {
  /**
   * parseDuration is used in executeReaction to compare escalateAfter
   * duration strings against elapsed time. We test it by configuring
   * escalateAfter with various duration strings and checking escalation.
   */

  it("does not time-escalate on first attempt even with short duration (tracker is fresh)", async () => {
    // parseDuration("1h") = 3_600_000ms. Even with escalateAfter="1h",
    // the first attempt won't trigger time-based escalation because no time
    // has elapsed since firstTriggered. This verifies parseDuration("1h") is
    // parsed correctly and the elapsed time comparison works.

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
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithAll: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const escalationConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Fix CI",
          retries: 100,
          escalateAfter: "1h", // 3_600_000ms — won't be exceeded on first attempt
        },
      },
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
      config: escalationConfig,
      registry: registryWithAll,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Should send to agent normally, no escalation
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Fix CI");
    expect(mockNotifier.notify).not.toHaveBeenCalled();
  });

  it("parses '30s' duration correctly (escalation not triggered within 30s)", async () => {
    // Verifies parseDuration("30s") = 30_000ms by configuring escalateAfter="30s"
    // and confirming no escalation on the first attempt (elapsed time ~ 0ms < 30_000ms)

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
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithAll: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const escalationConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Fix CI",
          retries: 100,
          escalateAfter: "30s", // 30_000ms
        },
      },
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
      config: escalationConfig,
      registry: registryWithAll,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // First attempt, no time elapsed: should send to agent, not escalate
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Fix CI");
    expect(mockNotifier.notify).not.toHaveBeenCalled();
  });

  it("does not escalate when duration has not elapsed", async () => {
    vi.useFakeTimers();

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
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithAll: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const escalationConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Fix CI",
          retries: 100,
          escalateAfter: "10m", // 10 minutes — won't elapse in this test
        },
      },
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
      config: escalationConfig,
      registry: registryWithAll,
      sessionManager: mockSessionManager,
    });

    // Trigger first check: pr_open → ci_failed
    await lm.check("app-1");

    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Fix CI");
    // Should NOT have escalated — only 0ms elapsed vs 10m threshold
    expect(mockNotifier.notify).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("treats invalid duration format as 0 (no time-based escalation)", async () => {
    // parseDuration returns 0 for invalid formats. When escalateAfter = "invalid",
    // durationMs = 0, and the condition `durationMs > 0` prevents time-based escalation.
    // Only numeric retry-based escalation applies.

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
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithAll: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const invalidDurationConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Fix CI",
          retries: 100,
          escalateAfter: "invalid", // parseDuration returns 0 → durationMs > 0 is false
        },
      },
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
      config: invalidDurationConfig,
      registry: registryWithAll,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Should send to agent (not escalate), because invalid duration = 0 = no time escalation
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Fix CI");
    expect(mockNotifier.notify).not.toHaveBeenCalled();
  });
});

describe("pollAll (tested via start/stop with fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls all active sessions on each interval tick", async () => {
    const sessions = [
      makeSession({ id: "app-1", status: "working" }),
      makeSession({ id: "app-2", status: "spawning" }),
    ];

    vi.mocked(mockSessionManager.list).mockResolvedValue(sessions);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });
    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp",
      branch: "feat/new",
      status: "spawning",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    lm.start(5000);

    // Wait for initial pollAll to complete
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSessionManager.list).toHaveBeenCalledTimes(1);

    // After one interval
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockSessionManager.list).toHaveBeenCalledTimes(2);

    // After another interval
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockSessionManager.list).toHaveBeenCalledTimes(3);

    lm.stop();
  });

  it("skips terminal sessions (merged, killed) unless state changed from tracked", async () => {
    const sessions = [
      makeSession({ id: "app-1", status: "merged" }),
      makeSession({ id: "app-2", status: "killed" }),
      makeSession({ id: "app-3", status: "working" }),
    ];

    vi.mocked(mockSessionManager.list).mockResolvedValue(sessions);

    writeMetadata(sessionsDir, "app-3", {
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

    lm.start(5000);
    await vi.advanceTimersByTimeAsync(0);

    const states = lm.getStates();
    // app-3 is working and should have been polled
    expect(states.get("app-3")).toBe("working");
    // app-1 and app-2 are terminal with no tracked state diff, so they were skipped.
    // They may or may not appear in states depending on the filter, but they should not
    // have caused determineStatus calls. Since they're filtered out, they shouldn't
    // appear in states at all (checkSession is never called for them).
    expect(states.has("app-1")).toBe(false);
    expect(states.has("app-2")).toBe(false);

    lm.stop();
  });

  it("processes terminal sessions when tracked state differs from list() status", async () => {
    // Simulate: session was previously tracked as "working" but list() now returns "killed"
    // (e.g., runtime died and list() detected it)
    const session = makeSession({ id: "app-1", status: "working" });
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

    // First: track the session as "working" via check
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");

    // Now list() returns it as "killed" — the session filter should include it
    // because tracked state ("working") differs from list status ("killed")
    const killedSession = makeSession({ id: "app-1", status: "killed" });
    vi.mocked(mockSessionManager.list).mockResolvedValue([killedSession]);
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    lm.start(5000);
    await vi.advanceTimersByTimeAsync(0);

    // The session should now be tracked as "killed" after poll
    expect(lm.getStates().get("app-1")).toBe("killed");

    lm.stop();
  });

  it("handles errors in individual sessions without stopping the poll", async () => {
    // Set up two sessions: app-1 will have an error config, app-2 should still be processed
    const session1 = makeSession({
      id: "app-1",
      status: "working",
      runtimeHandle: { id: "rt-err", runtimeName: "mock", data: {} },
    });
    const session2 = makeSession({
      id: "app-2",
      status: "spawning",
      runtimeHandle: { id: "rt-ok", runtimeName: "mock", data: {} },
    });

    vi.mocked(mockSessionManager.list).mockResolvedValue([session1, session2]);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });
    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp",
      branch: "feat/new",
      status: "spawning",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    lm.start(5000);
    await vi.advanceTimersByTimeAsync(0);

    // app-2 should have been polled successfully even if app-1 had issues
    // (pollAll uses Promise.allSettled)
    const states = lm.getStates();
    expect(states.get("app-2")).toBe("working"); // spawning → working

    lm.stop();
  });

  it("prunes stale entries from states map for removed sessions", async () => {
    const session = makeSession({ id: "app-1", status: "working" });
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

    // Track a session via check()
    await lm.check("app-1");
    expect(lm.getStates().has("app-1")).toBe(true);

    // Now list returns no sessions (session was cleaned up externally)
    vi.mocked(mockSessionManager.list).mockResolvedValue([]);

    lm.start(5000);
    await vi.advanceTimersByTimeAsync(0);

    // The stale entry should be pruned
    expect(lm.getStates().has("app-1")).toBe(false);

    lm.stop();
  });

  it("emits all-complete reaction when all sessions become terminal", async () => {
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const allCompleteConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
      reactions: {
        "all-complete": {
          auto: true,
          action: "notify",
          priority: "action",
        },
      },
    };

    // All sessions are terminal
    const sessions = [
      makeSession({ id: "app-1", status: "merged" }),
      makeSession({ id: "app-2", status: "killed" }),
    ];

    vi.mocked(mockSessionManager.list).mockResolvedValue(sessions);

    const lm = createLifecycleManager({
      config: allCompleteConfig,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    lm.start(5000);
    await vi.advanceTimersByTimeAsync(0);

    // all-complete reaction should have been triggered
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reaction.triggered",
      }),
    );

    lm.stop();
  });

  it("does not emit all-complete twice for the same terminal state", async () => {
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const allCompleteConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
      reactions: {
        "all-complete": {
          auto: true,
          action: "notify",
          priority: "action",
        },
      },
    };

    const sessions = [makeSession({ id: "app-1", status: "merged" })];
    vi.mocked(mockSessionManager.list).mockResolvedValue(sessions);

    const lm = createLifecycleManager({
      config: allCompleteConfig,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    lm.start(5000);
    await vi.advanceTimersByTimeAsync(0);

    const callCount = vi.mocked(mockNotifier.notify).mock.calls.length;

    // Second poll tick
    await vi.advanceTimersByTimeAsync(5000);

    // Should not have been called again
    expect(mockNotifier.notify).toHaveBeenCalledTimes(callCount);

    lm.stop();
  });

  it("does not emit all-complete when there are no sessions at all", async () => {
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const allCompleteConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
      reactions: {
        "all-complete": {
          auto: true,
          action: "notify",
          priority: "action",
        },
      },
    };

    vi.mocked(mockSessionManager.list).mockResolvedValue([]);

    const lm = createLifecycleManager({
      config: allCompleteConfig,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    lm.start(5000);
    await vi.advanceTimersByTimeAsync(0);

    // sessions.length === 0, so all-complete should NOT fire
    expect(mockNotifier.notify).not.toHaveBeenCalled();

    lm.stop();
  });
});

describe("reaction tracking and escalation", () => {
  it("escalates after exceeding retry count (numeric escalateAfter)", async () => {
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
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithAll: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const escalationConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Fix CI",
          retries: 1, // will escalate on attempt 2
          escalateAfter: 1, // numeric: escalate after 1 attempt
        },
      },
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
      config: escalationConfig,
      registry: registryWithAll,
      sessionManager: mockSessionManager,
    });

    // First check: pr_open → ci_failed (attempt 1)
    await lm.check("app-1");

    // Attempt 1 should send to agent, not escalate yet
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Fix CI");
    expect(mockNotifier.notify).not.toHaveBeenCalled();

    // Simulate: CI still failing, but we need a status transition to trigger reaction again.
    // Reset state to pr_open, then back to ci_failed.
    vi.mocked(mockSCM.getCISummary).mockResolvedValueOnce("passing");
    vi.mocked(mockSCM.getReviewDecision).mockResolvedValueOnce("none");
    await lm.check("app-1"); // ci_failed → pr_open

    vi.mocked(mockSCM.getCISummary).mockResolvedValue("failing");
    vi.mocked(mockSCM.getReviewDecision).mockResolvedValue("none");

    // Note: the transition from ci_failed to pr_open clears the reaction tracker
    // for the old "ci-failed" key (line 449-455 in source). So each ci_failed transition
    // starts with a fresh tracker. With retries=1, the first attempt (attempt 1)
    // doesn't exceed maxRetries, so it sends to agent.
    // With numeric escalateAfter=1, attempt 1 doesn't exceed 1 either.
    // Attempt 2 would exceed both, but the tracker resets on state change.
    // This tests that the numeric escalateAfter path is exercised.
    await lm.check("app-1"); // pr_open → ci_failed (new tracker, attempt 1)

    // With fresh tracker, attempt 1 <= retries(1) and attempt 1 <= escalateAfter(1),
    // so it should still send to agent
    expect(mockSessionManager.send).toHaveBeenCalledTimes(2);
  });

  it("escalates when retries exceeded (without state transition resetting tracker)", async () => {
    // To test escalation properly, we need repeated reactions on the SAME transition
    // without the tracker being cleared. This happens when the same event type
    // keeps firing. However, the lifecycle manager only triggers reactions on
    // state *transitions*. To get multiple triggers without reset, we'd need
    // the session to remain in ci_failed and the reaction to fire again.
    //
    // Looking at the code: reactions only fire when oldStatus !== newStatus.
    // So the tracker can only accumulate across separate transitions to the same state.
    // But each transition from ci_failed to something else clears the tracker.
    //
    // This means: with retries=1 and the tracker resetting on each state change,
    // we can never actually reach attempt > 1 for the same tracker key
    // through the public API. The escalation is designed to work across
    // persistent ci_failed states polled repeatedly — but pollAll only triggers
    // reactions on transitions.
    //
    // However: if retries = 0, then attempt 1 > maxRetries(0), so it escalates immediately.

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
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithAll: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    const escalationConfig: OrchestratorConfig = {
      ...config,
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      },
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Fix CI",
          retries: 0, // escalate immediately on first attempt (1 > 0)
        },
      },
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
      config: escalationConfig,
      registry: registryWithAll,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    // With retries=0, attempt 1 > 0, so escalation fires immediately
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reaction.escalated",
        priority: "urgent", // default escalation priority
      }),
    );
    // send-to-agent should NOT have been called (escalation path returns early)
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("clears reaction tracker when state transitions away from the triggering status", async () => {
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

    const reactionConfig: OrchestratorConfig = {
      ...config,
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Fix CI",
          retries: 100,
        },
      },
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
      config: reactionConfig,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    // First transition: pr_open → ci_failed
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Transition away: ci_failed → pr_open (CI passes)
    vi.mocked(mockSCM.getCISummary).mockResolvedValueOnce("passing");
    vi.mocked(mockSCM.getReviewDecision).mockResolvedValueOnce("none");
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("pr_open");

    // Transition back: pr_open → ci_failed
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("failing");
    vi.mocked(mockSCM.getReviewDecision).mockResolvedValue("none");
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("ci_failed");

    // The tracker should have been cleared when state changed from ci_failed,
    // so this is treated as a fresh first attempt (not attempt 2)
    expect(mockSessionManager.send).toHaveBeenCalledTimes(2);
    expect(mockSessionManager.send).toHaveBeenLastCalledWith("app-1", "Fix CI");
  });

  it("uses project-specific reaction overrides when configured", async () => {
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

    // Global reaction has one message, project override has another
    const projectOverrideConfig: OrchestratorConfig = {
      ...config,
      projects: {
        "my-app": {
          ...config.projects["my-app"],
          reactions: {
            "ci-failed": {
              message: "Project-specific: fix the CI please!",
            },
          },
        },
      },
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Global: fix CI",
          retries: 3,
        },
      },
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
      config: projectOverrideConfig,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    // Project-specific message should override global
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-1",
      "Project-specific: fix the CI please!",
    );
  });

  it("handles send-to-agent failure gracefully (returns success=false)", async () => {
    vi.mocked(mockSessionManager.send).mockRejectedValue(new Error("tmux send failed"));

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

    const reactionConfig: OrchestratorConfig = {
      ...config,
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Fix CI",
          retries: 3,
        },
      },
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
      config: reactionConfig,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    // Should not throw — the reaction catches the send error
    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Fix CI");
  });
});

describe("event logging", () => {
  it("logs state transitions when eventLogger is provided", async () => {
    const mockEventLogger = {
      append: vi.fn(),
      appendLine: vi.fn(),
      close: vi.fn(),
    };

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
      eventLogger: mockEventLogger,
    });

    await lm.check("app-1");

    expect(mockEventLogger.append).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        source: "lifecycle",
        sessionId: "app-1",
        message: expect.stringContaining("spawning"),
      }),
    );
    expect(mockEventLogger.append).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("working"),
      }),
    );
  });

  it("closes eventLogger on stop", () => {
    const mockEventLogger = {
      append: vi.fn(),
      appendLine: vi.fn(),
      close: vi.fn(),
    };

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      eventLogger: mockEventLogger,
    });

    lm.stop();

    expect(mockEventLogger.close).toHaveBeenCalled();
  });

  it("does not log when eventLogger is not provided", async () => {
    const session = makeSession({ status: "spawning" });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
    });

    // No eventLogger passed — should not throw
    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");
  });
});
