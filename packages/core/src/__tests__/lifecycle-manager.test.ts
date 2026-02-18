import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { createNullEventLog, createEventLog } from "../event-log.js";
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
  EventLog,
  OrchestratorEvent,
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

describe("event log integration", () => {
  it("logs events to the provided event log on state transition", async () => {
    const loggedEvents: OrchestratorEvent[] = [];
    const eventLog: EventLog = {
      log: (event) => loggedEvents.push(event),
      readRecent: () => [],
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
      eventLog,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");
    expect(loggedEvents.length).toBeGreaterThan(0);
    expect(loggedEvents[0]).toMatchObject({
      type: "session.working",
      sessionId: "app-1",
      projectId: "my-app",
    });
  });

  it("accepts createNullEventLog as a no-op default", async () => {
    const nullLog = createNullEventLog();
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
      eventLog: nullLog,
    });

    // Should not throw
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");
    expect(nullLog.readRecent()).toEqual([]);
  });
});

describe("automated comment detection (bugbot)", () => {
  function makeSCMWithAutomatedComments(
    automatedComments: ReturnType<SCM["getAutomatedComments"]> extends Promise<infer T>
      ? T
      : never,
  ): SCM {
    return {
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
      getAutomatedComments: vi.fn().mockResolvedValue(automatedComments),
      getMergeability: vi.fn(),
    };
  }

  it("triggers bugbot-comments reaction when automated comments appear", async () => {
    const botComment = {
      id: "comment-1",
      botName: "reviewdog",
      body: "Error: unused import",
      path: "src/index.ts",
      line: 5,
      severity: "error" as const,
      createdAt: new Date(),
      url: "https://github.com/org/repo/pull/42#comment-1",
    };

    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        message: "Fix bot comments",
      },
    };

    const mockSCM = makeSCMWithAutomatedComments([botComment]);
    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    // Session in pr_open state — status doesn't change, but automated comments appear
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

    // First check: sets pr_open state
    await lm.check("app-1");
    // Second check: status unchanged (pr_open → pr_open) → automated comments check fires
    await lm.check("app-1");

    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Fix bot comments");
  });

  it("deduplicates automated comments — does not retrigger for same comment set", async () => {
    const botComment = {
      id: "comment-1",
      botName: "reviewdog",
      body: "Error: unused import",
      severity: "error" as const,
      createdAt: new Date(),
      url: "https://github.com/org/repo/pull/42#comment-1",
    };

    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        message: "Fix bot comments",
      },
    };

    const mockSCM = makeSCMWithAutomatedComments([botComment]);
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

    // First check: transitions pr_open → pr_open (status unchanged)
    // Automated comments check NOT called on first encounter (no prior state to compare)
    await lm.check("app-1");
    // Second check: same status → automated check fires, sees comment-1, sends message
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Third check: same comment set → fingerprint matches, no resend
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
  });

  it("retriggers for same comment set when retriggerAfter elapses", async () => {
    const botComment = {
      id: "comment-1",
      botName: "reviewdog",
      body: "Error: unused import",
      severity: "error" as const,
      createdAt: new Date(),
      url: "https://github.com/org/repo/pull/42#comment-1",
    };

    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        message: "Fix bot comments",
        retriggerAfter: "30s",
      },
    };

    const mockSCM = makeSCMWithAutomatedComments([botComment]);
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

    vi.useFakeTimers();
    try {
      const lm = createLifecycleManager({
        config,
        registry: registryWithSCM,
        sessionManager: mockSessionManager,
      });

      // Check 1: sets pr_open state (transition from spawning)
      await lm.check("app-1");
      // Check 2: automated comments check fires — sends message once
      await lm.check("app-1");
      expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

      // Check 3: same fingerprint, but not enough time yet — no retrigger
      await lm.check("app-1");
      expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

      // Advance past retriggerAfter (30s)
      vi.advanceTimersByTime(31_000);

      // Check 4: same fingerprint but retriggerAfter elapsed — retrigger fires
      await lm.check("app-1");
      expect(mockSessionManager.send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears fingerprint on state transition so comments retrigger after agent pushes a fix", async () => {
    const botComment = {
      id: "comment-1",
      botName: "reviewdog",
      body: "Error: unused import",
      severity: "error" as const,
      createdAt: new Date(),
      url: "https://github.com/org/repo/pull/42#comment-1",
    };

    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        message: "Fix bot comments",
        // No retriggerAfter — only fingerprint-change-based retrigger
      },
    };

    const getAutomatedComments = vi.fn().mockResolvedValue([botComment]);
    const getCISummary = vi.fn().mockResolvedValue("passing");

    const mockSCM: SCM = {
      ...makeSCMWithAutomatedComments([botComment]),
      getAutomatedComments,
      getCISummary,
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

    // Check 1: pr_open sets initial state
    await lm.check("app-1");
    // Check 2: automated comment check fires — sends message
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Agent pushes a fix: CI briefly goes to passing then comes back to pr_open.
    // Simulate by having CI return "pending" (causes pr_open → pr_open but through
    // a different evaluation path — actually let's just force a status transition
    // by making CI fail, then pass again).
    getCISummary.mockResolvedValueOnce("failing"); // causes pr_open → ci_failed
    await lm.check("app-1"); // transition to ci_failed (fingerprint cleared)
    getCISummary.mockResolvedValue("passing");
    await lm.check("app-1"); // transition back to pr_open

    // Check: same comment still present, but fingerprint was cleared by transition
    // → should retrigger on next automated comment check
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(2);
  });

  it("clears tracker when comments resolve so escalated flag does not block future comments", async () => {
    // Regression: when comments.length === 0, only the fingerprint was cleared.
    // tracker.escalated persisted, permanently blocking reactions for new bot comments.
    const botComment = {
      id: "comment-1",
      botName: "reviewdog",
      body: "Error: unused import",
      severity: "error" as const,
      createdAt: new Date(),
      url: "https://github.com/org/repo/pull/42#comment-1",
    };

    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        message: "Fix bot comments",
        retries: 1, // allows first send, escalates on second attempt
      },
    };

    const getAutomatedComments = vi.fn().mockResolvedValue([botComment]);
    const mockSCM: SCM = {
      ...makeSCMWithAutomatedComments([botComment]),
      getAutomatedComments,
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

    // Check 1: pr_open sets initial state
    await lm.check("app-1");
    // Check 2: comment appears → send-to-agent, retries:0 → escalates
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Agent fixes the issue — no more comments
    getAutomatedComments.mockResolvedValue([]);
    await lm.check("app-1"); // comments resolved → tracker cleared

    // New bot comment appears (e.g., a different issue) — should react again
    getAutomatedComments.mockResolvedValue([{ ...botComment, id: "comment-2" }]);
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(2); // reacted to new comment
  });

  it("retriggers when new automated comments appear (fingerprint changes)", async () => {
    const firstComment = {
      id: "comment-1",
      botName: "reviewdog",
      body: "Error 1",
      severity: "error" as const,
      createdAt: new Date(),
      url: "https://github.com/org/repo/pull/42#comment-1",
    };
    const secondComment = {
      id: "comment-2",
      botName: "reviewdog",
      body: "Error 2",
      severity: "error" as const,
      createdAt: new Date(),
      url: "https://github.com/org/repo/pull/42#comment-2",
    };

    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        message: "Fix bot comments",
      },
    };

    const getAutomatedComments = vi.fn().mockResolvedValue([firstComment]);

    const mockSCM: SCM = {
      ...makeSCMWithAutomatedComments([firstComment]),
      getAutomatedComments,
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

    // Check 1: transitions to pr_open (initial)
    await lm.check("app-1");
    // Check 2: automated comment check fires with comment-1 → sends message once
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Now a new comment appears
    getAutomatedComments.mockResolvedValue([firstComment, secondComment]);

    // Check 3: fingerprint changes → retrigger
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(2);
  });

  it("does not re-escalate bugbot-comments when tracker.escalated is true", async () => {
    const botComment = {
      id: "comment-1",
      botName: "reviewdog",
      body: "Error: unused import",
      severity: "error" as const,
      createdAt: new Date(),
      url: "https://github.com/org/repo/pull/42#comment-1",
    };

    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        message: "Fix bot comments",
        // retries: 0 → escalate on first attempt
        retries: 0,
        retriggerAfter: "30s",
      },
    };

    const mockSCM = makeSCMWithAutomatedComments([botComment]);
    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier") return mockNotifier;
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

    vi.useFakeTimers();
    try {
      const lm = createLifecycleManager({
        config,
        registry: registryWithSCM,
        sessionManager: mockSessionManager,
      });

      // Check 1: sets pr_open state
      await lm.check("app-1");
      // Check 2: automated comments appear → retries:0 → escalates (1 notification)
      await lm.check("app-1");
      expect(mockNotifier.notify).toHaveBeenCalledTimes(1);

      // Advance past retriggerAfter — without the guard this would re-escalate
      vi.advanceTimersByTime(31_000);

      // Check 3: same fingerprint, timer elapsed, but tracker.escalated → no spam
      await lm.check("app-1");
      expect(mockNotifier.notify).toHaveBeenCalledTimes(1); // still 1

      vi.advanceTimersByTime(31_000);
      await lm.check("app-1");
      expect(mockNotifier.notify).toHaveBeenCalledTimes(1); // still 1
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-escalate bugbot-comments when fingerprint changes after escalation", async () => {
    // Regression: state transitions clear the fingerprint, so re-detected identical
    // comments look "new" and bypass the escalation guard. This test ensures the
    // new/changed fingerprint path also respects tracker.escalated.
    const botComment = {
      id: "comment-1",
      botName: "reviewdog",
      body: "Error: unused import",
      severity: "error" as const,
      createdAt: new Date(),
      url: "https://github.com/org/repo/pull/42#comment-1",
    };

    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        message: "Fix bot comments",
        retries: 0, // escalate on first attempt
      },
    };

    const getCISummary = vi.fn().mockResolvedValue("passing");
    const mockSCM: SCM = {
      ...makeSCMWithAutomatedComments([botComment]),
      getCISummary,
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier") return mockNotifier;
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

    // Check 1: pr_open sets initial state
    await lm.check("app-1");
    // Check 2: automated comments appear → retries:0 → escalates (1 notification)
    await lm.check("app-1");
    expect(mockNotifier.notify).toHaveBeenCalledTimes(1);

    // State transition clears the fingerprint — same bot comment now looks "new"
    getCISummary.mockResolvedValueOnce("failing"); // pr_open → ci_failed
    await lm.check("app-1"); // fingerprint cleared by transition
    getCISummary.mockResolvedValue("passing");
    await lm.check("app-1"); // back to pr_open

    // Check: fingerprint was cleared, comment still present → looks like "new" comment
    // but tracker.escalated is true → should NOT re-escalate
    await lm.check("app-1");
    expect(mockNotifier.notify).toHaveBeenCalledTimes(1); // still 1, no re-escalation
  });

  it("notifies human when bugbot-comments has auto: false and non-notify action", async () => {
    // Regression: auto: false + action: "send-to-agent" was silently dropped.
    // The automated action is skipped (auto: false) but a human notification should
    // still fire — mirrors the transition-based path which always falls through to
    // notifyHuman when the automated action is skipped.
    const botComment = {
      id: "comment-1",
      botName: "reviewdog",
      body: "Error: unused import",
      severity: "error" as const,
      createdAt: new Date(),
      url: "https://github.com/org/repo/pull/42#comment-1",
    };

    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    config.reactions = {
      "bugbot-comments": {
        auto: false, // no automated agent action
        action: "send-to-agent",
        message: "Fix bot comments",
      },
    };

    // Route "warning" to "desktop" so notifyHuman(event, "warning") reaches the mock notifier
    // (the default test config routes "warning" to [] to avoid noise in other tests).
    config.notificationRouting = { ...config.notificationRouting, warning: ["desktop"] };

    const mockSCM = makeSCMWithAutomatedComments([botComment]);
    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier") return mockNotifier;
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

    // Check 1: pr_open sets initial state
    await lm.check("app-1");
    // Check 2: automated comments appear — auto: false so no agent send, but human notified
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled(); // no automated action
    expect(mockNotifier.notify).toHaveBeenCalledTimes(1); // human notified as fallback
  });
});

describe("persistent retrigger (retriggerAfter)", () => {
  it("retriggers send-to-agent when session stays in same bad state past retriggerAfter", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI still failing. Try again.",
        retries: 3,
        // 30 seconds — will be fast-forwarded via fake timers
        retriggerAfter: "30s",
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
      getPendingComments: vi.fn().mockResolvedValue([]),
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

    // Start in pr_open so first check transitions to ci_failed
    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    vi.useFakeTimers();
    try {
      const lm = createLifecycleManager({
        config,
        registry: registryWithSCM,
        sessionManager: mockSessionManager,
      });

      // Check 1: pr_open → ci_failed (state transition) → initial reaction fires
      await lm.check("app-1");
      expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

      // Advance time past retriggerAfter (30s)
      vi.advanceTimersByTime(31_000);

      // Check 2: ci_failed → ci_failed (no transition) → retrigger fires
      await lm.check("app-1");
      expect(mockSessionManager.send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retrigger when retriggerAfter is not configured", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI failing.",
        retries: 3,
        // No retriggerAfter
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
      getPendingComments: vi.fn().mockResolvedValue([]),
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

    // Check 1: transition → initial reaction fires
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Check 2: same state, no retriggerAfter → no extra send
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Check 3: still no retrigger
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
  });
});

describe("event log ordering — transition event before reaction events", () => {
  it("logs the transition event before the reaction.triggered event", async () => {
    const loggedEventTypes: string[] = [];
    const eventLog: EventLog = {
      log: (event) => loggedEventTypes.push(event.type),
      readRecent: () => [],
    };

    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing. Fix it.",
        retries: 1,
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
      getPendingComments: vi.fn().mockResolvedValue([]),
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
      eventLog,
    });

    // Transition from pr_open → ci_failed triggers both ci.failing and reaction.triggered
    await lm.check("app-1");

    const ciFailingIdx = loggedEventTypes.indexOf("ci.failing");
    const reactionTriggeredIdx = loggedEventTypes.indexOf("reaction.triggered");

    expect(ciFailingIdx).toBeGreaterThanOrEqual(0);
    expect(reactionTriggeredIdx).toBeGreaterThanOrEqual(0);
    // The root-cause transition event must appear before the reaction effect
    expect(ciFailingIdx).toBeLessThan(reactionTriggeredIdx);
  });
});

describe("retrigger escalation guard", () => {
  it("does not re-escalate on every retrigger cycle after escalation threshold", async () => {
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
    };

    const mockRegistryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "notifier") return mockNotifier;
        if (slot === "scm") {
          return {
            name: "mock-scm",
            detectPR: vi.fn(),
            getPRState: vi.fn().mockResolvedValue("open"),
            mergePR: vi.fn(),
            closePR: vi.fn(),
            getCIChecks: vi.fn(),
            getCISummary: vi.fn().mockResolvedValue("failing"),
            getReviews: vi.fn(),
            getReviewDecision: vi.fn().mockResolvedValue("none"),
            getPendingComments: vi.fn().mockResolvedValue([]),
            getAutomatedComments: vi.fn().mockResolvedValue([]),
            getMergeability: vi.fn(),
          } satisfies SCM;
        }
        return null;
      }),
    };

    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI failing — fix it.",
        // retries: 0 → escalate on the very first attempt
        retries: 0,
        retriggerAfter: "30s",
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

    vi.useFakeTimers();
    try {
      const lm = createLifecycleManager({
        config,
        registry: mockRegistryWithNotifier,
        sessionManager: mockSessionManager,
      });

      // Check 1: pr_open → ci_failed; retries: 0 → escalates immediately (1 notification)
      await lm.check("app-1");
      expect(mockNotifier.notify).toHaveBeenCalledTimes(1);

      // Advance past retriggerAfter — without the guard this would re-escalate
      vi.advanceTimersByTime(31_000);

      // Check 2: ci_failed → ci_failed; tracker.escalated = true → retrigger skipped
      await lm.check("app-1");
      expect(mockNotifier.notify).toHaveBeenCalledTimes(1); // still 1, no spam

      // Check 3: still no extra notification
      vi.advanceTimersByTime(31_000);
      await lm.check("app-1");
      expect(mockNotifier.notify).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("event-log readRecent validation", () => {
  it("skips entries that do not match OrchestratorEvent schema", () => {
    const logPath = join(tmpDir, "test-events.jsonl");
    // Write a mix of valid and invalid entries
    writeFileSync(
      logPath,
      [
        // Valid entry
        JSON.stringify({
          id: "evt-1",
          type: "ci.failing",
          sessionId: "app-1",
          projectId: "my-app",
          timestamp: new Date().toISOString(),
          message: "CI failing",
          priority: "warning",
          data: {},
        }),
        // Invalid — missing required fields
        JSON.stringify({ foo: "bar" }),
        // Invalid — timestamp not a string
        JSON.stringify({
          id: "evt-3",
          type: "ci.failing",
          sessionId: "app-1",
          projectId: "my-app",
          timestamp: 12345,
          message: "bad",
        }),
        // Truncated / non-JSON
        "not-json{",
        // Another valid entry
        JSON.stringify({
          id: "evt-5",
          type: "session.working",
          sessionId: "app-1",
          projectId: "my-app",
          timestamp: new Date().toISOString(),
          message: "working",
          priority: "info",
          data: {},
        }),
      ].join("\n") + "\n",
    );

    const log = createEventLog(logPath);
    const events = log.readRecent();

    // Only the two valid entries should be returned
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("ci.failing");
    expect(events[1].type).toBe("session.working");
    // Timestamps should be Date objects
    expect(events[0].timestamp).toBeInstanceOf(Date);
    expect(events[1].timestamp).toBeInstanceOf(Date);
  });
});
