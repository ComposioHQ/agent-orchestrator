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
  Tracker,
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

  it("auto-dismisses codex rate-limit prompt and keeps session working", async () => {
    const codexAgent: Agent = {
      ...mockAgent,
      name: "codex",
      detectActivity: vi.fn().mockReturnValue("waiting_input"),
    };
    const registryWithCodex: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return codexAgent;
        return null;
      }),
    };

    vi.mocked(mockRuntime.getOutput).mockResolvedValue(
      [
        "Approaching rate limits",
        "Switch to gpt-5.1-codex-mini for lower credit usage?",
        "Press enter to confirm or esc to go back",
      ].join("\n"),
    );

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
      registry: registryWithCodex,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(session.runtimeHandle, "3\n");
    expect(lm.getStates().get("app-1")).toBe("working");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["codex_rate_limit_prompt_autodismiss_choice"]).toBe("3");
    expect(meta?.["codex_rate_limit_prompt_autodismissed_at"]).toBeTruthy();
  });

  it("marks session stuck and sends stuck-recovery message after threshold", async () => {
    config.projects["my-app"] = {
      ...config.projects["my-app"],
      automation: {
        mode: "local-only",
        queuePickup: {
          enabled: true,
          intervalSec: 60,
          pickupStateName: "Todo",
          requireAoMetaQueued: true,
          maxActiveSessions: 8,
          maxSpawnPerCycle: 4,
        },
        mergeGate: {
          enabled: true,
          method: "squash",
          retryCooldownSec: 300,
          strict: {
            requireVerifyMarker: true,
            requireBrowserMarker: true,
            requireApprovedReviewOrNoRequests: true,
            requireNoUnresolvedThreads: true,
            requirePassingChecks: true,
            requireCompletionDryRun: true,
          },
        },
        completionGate: {
          enabled: true,
          evidencePattern: "AC Evidence:|검증 근거:",
          syncChecklistFromEvidence: false,
        },
        stuckRecovery: {
          enabled: true,
          pattern: "Write tests for @filename",
          thresholdSec: 1,
          cooldownSec: 300,
          message: "Write tests for @filename",
        },
      },
    };

    vi.mocked(mockRuntime.getOutput).mockResolvedValue("› Write tests for @filename");

    const oldDetectedAt = new Date(Date.now() - 5_000).toISOString();
    const session = makeSession({
      status: "working",
      metadata: {
        stuck_recovery_detected_at: oldDetectedAt,
      },
    });
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

    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Write tests for @filename");
    expect(lm.getStates().get("app-1")).toBe("stuck");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["stuck_recovery_last_sent_at"]).toBeTruthy();
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

    // merge.completed -> issue-completed mapping exists, but without a configured
    // issue-completed reaction it still falls back to direct notifyHuman.
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

  it("completes tracker issue on merge when verify marker exists and all checklist items are checked", async () => {
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

    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "PYO-26",
        title: "Acceptance complete",
        description:
          "## Acceptance Criteria\n- [x] feature delivered\n* [x] regression covered\n1. [x] docs updated",
        url: "https://tracker.local/PYO-26",
        state: "in_progress",
        labels: [],
      }),
      isCompleted: vi.fn(),
      issueUrl: vi.fn().mockReturnValue("https://tracker.local/PYO-26"),
      branchName: vi.fn().mockReturnValue("feat/PYO-26"),
      generatePrompt: vi.fn(),
      listComments: vi.fn().mockResolvedValue([
        {
          id: "comment-1",
          body: "AC Evidence: verify pass",
          author: "alice",
        },
      ]),
      updateIssue: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "tracker" && name === "linear") return mockTracker;
        return null;
      }),
    };

    config.reactions = {
      "issue-completed": {
        auto: true,
        action: "complete-tracker-issue",
        priority: "action",
      },
    };
    config.projects["my-app"] = {
      ...config.projects["my-app"],
      tracker: { plugin: "linear", teamId: "team-id" },
    };

    const session = makeSession({
      status: "approved",
      pr: makePR(),
      issueId: "PYO-26",
      metadata: {
        verify_status: "work_verify_pass_full",
        verify_browser_status: "work_verify_browser_pass",
      },
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
      registry: registryWithTracker,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(mockTracker.updateIssue).toHaveBeenCalledTimes(1);
    expect(mockTracker.updateIssue).toHaveBeenCalledWith(
      "PYO-26",
      expect.objectContaining({
        state: "closed",
        comment: expect.stringContaining("work-verify"),
      }),
      config.projects["my-app"],
    );

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["acceptance_total"]).toBe("3");
    expect(meta?.["acceptance_checked"]).toBe("3");
    expect(meta?.["acceptance_unchecked"]).toBe("0");
    expect(meta?.["acceptance_status"]).toBe("passed");
    expect(meta?.["acceptance_checked_at"]).toBeTruthy();
  });

  it("blocks tracker completion and notifies when work-verify full marker is missing", async () => {
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

    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn(),
      isCompleted: vi.fn(),
      issueUrl: vi.fn().mockReturnValue("https://tracker.local/PYO-26"),
      branchName: vi.fn().mockReturnValue("feat/PYO-26"),
      generatePrompt: vi.fn(),
      updateIssue: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "tracker" && name === "linear") return mockTracker;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    config.reactions = {
      "issue-completed": {
        auto: true,
        action: "complete-tracker-issue",
        priority: "action",
      },
    };
    config.projects["my-app"] = {
      ...config.projects["my-app"],
      tracker: { plugin: "linear", teamId: "team-id" },
    };

    const session = makeSession({
      status: "approved",
      pr: makePR(),
      issueId: "PYO-26",
      metadata: {},
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
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(mockTracker.updateIssue).not.toHaveBeenCalled();
    expect(mockNotifier.notify).toHaveBeenCalledTimes(1);
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reaction.triggered",
        priority: "action",
      }),
    );
  });

  it("blocks tracker completion when work-verify browser verification marker is missing", async () => {
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

    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn(),
      isCompleted: vi.fn(),
      issueUrl: vi.fn().mockReturnValue("https://tracker.local/PYO-26"),
      branchName: vi.fn().mockReturnValue("feat/PYO-26"),
      generatePrompt: vi.fn(),
      updateIssue: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "tracker" && name === "linear") return mockTracker;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    config.reactions = {
      "issue-completed": {
        auto: true,
        action: "complete-tracker-issue",
        priority: "action",
      },
    };
    config.projects["my-app"] = {
      ...config.projects["my-app"],
      tracker: { plugin: "linear", teamId: "team-id" },
    };

    const session = makeSession({
      status: "approved",
      pr: makePR(),
      issueId: "PYO-26",
      metadata: { verify_status: "work_verify_pass_full" },
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
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(mockTracker.updateIssue).not.toHaveBeenCalled();
    expect(mockNotifier.notify).toHaveBeenCalledTimes(1);
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reaction.triggered",
        data: expect.objectContaining({
          browserVerifyKey: "verify_browser_status",
        }),
      }),
    );
  });

  it("auto-checks unchecked checklist items before closing linear issue", async () => {
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

    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "PYO-29",
        title: "Needs checkbox sync",
        description:
          "## Acceptance Criteria\n- [ ] checklist a\n* [x] checklist b\n1. [ ] checklist c\n```md\n- [ ] fenced should be ignored\n```",
        url: "https://tracker.local/PYO-29",
        state: "in_progress",
        labels: [],
      }),
      isCompleted: vi.fn(),
      issueUrl: vi.fn().mockReturnValue("https://tracker.local/PYO-29"),
      branchName: vi.fn().mockReturnValue("feat/PYO-29"),
      generatePrompt: vi.fn(),
      listComments: vi.fn().mockResolvedValue([
        {
          id: "comment-1",
          body: "검증 근거: 수동 브라우저 검증 완료",
          author: "alice",
        },
      ]),
      updateIssue: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "tracker" && name === "linear") return mockTracker;
        return null;
      }),
    };

    config.reactions = {
      "issue-completed": {
        auto: true,
        action: "complete-tracker-issue",
        priority: "action",
      },
    };
    config.projects["my-app"] = {
      ...config.projects["my-app"],
      tracker: { plugin: "linear", teamId: "team-id" },
      automation: {
        mode: "local-only",
        queuePickup: {
          enabled: true,
          intervalSec: 60,
          pickupStateName: "In Progress",
          requireAoMetaQueued: true,
          maxActiveSessions: 8,
          maxSpawnPerCycle: 4,
        },
        mergeGate: {
          enabled: true,
          method: "squash",
          retryCooldownSec: 300,
          strict: {
            requireVerifyMarker: true,
            requireBrowserMarker: true,
            requireApprovedReviewOrNoRequests: true,
            requireNoUnresolvedThreads: true,
            requirePassingChecks: true,
            requireCompletionDryRun: true,
          },
        },
        completionGate: {
          enabled: true,
          evidencePattern: "AC Evidence:|검증 근거:",
          syncChecklistFromEvidence: true,
        },
        stuckRecovery: {
          enabled: true,
          pattern: "Write tests for @filename",
          thresholdSec: 600,
          cooldownSec: 300,
          message: "Write tests for @filename",
        },
      },
    };

    const session = makeSession({
      status: "approved",
      pr: makePR(),
      issueId: "PYO-29",
      metadata: {
        verify_status: "work_verify_pass_full",
        verify_browser_status: "work_verify_browser_pass",
      },
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
      registry: registryWithTracker,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockTracker.updateIssue).toHaveBeenCalledTimes(2);
    expect(mockTracker.updateIssue).toHaveBeenNthCalledWith(
      1,
      "PYO-29",
      expect.objectContaining({
        description: expect.stringContaining("- [x] checklist a"),
        comment: expect.stringContaining("Automatically checked"),
      }),
      config.projects["my-app"],
    );
    expect(mockTracker.updateIssue).toHaveBeenNthCalledWith(
      2,
      "PYO-29",
      expect.objectContaining({
        state: "closed",
      }),
      config.projects["my-app"],
    );

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["acceptance_total"]).toBe("3");
    expect(meta?.["acceptance_checked"]).toBe("3");
    expect(meta?.["acceptance_unchecked"]).toBe("0");
    expect(meta?.["acceptance_status"]).toBe("auto_checked");
    expect(meta?.["acceptance_checked_at"]).toBeTruthy();
  });

  it("blocks tracker completion when checklist checkboxes do not exist", async () => {
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

    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "PYO-30",
        title: "No checklist",
        description: "No task list here.",
        url: "https://tracker.local/PYO-30",
        state: "in_progress",
        labels: [],
      }),
      isCompleted: vi.fn(),
      issueUrl: vi.fn().mockReturnValue("https://tracker.local/PYO-30"),
      branchName: vi.fn().mockReturnValue("feat/PYO-30"),
      generatePrompt: vi.fn(),
      updateIssue: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "tracker" && name === "linear") return mockTracker;
        if (slot === "notifier" && name === "desktop") return mockNotifier;
        return null;
      }),
    };

    config.reactions = {
      "issue-completed": {
        auto: true,
        action: "complete-tracker-issue",
        priority: "action",
      },
    };
    config.projects["my-app"] = {
      ...config.projects["my-app"],
      tracker: { plugin: "linear", teamId: "team-id" },
    };

    const session = makeSession({
      status: "approved",
      pr: makePR(),
      issueId: "PYO-30",
      metadata: {
        verify_status: "work_verify_pass_full",
        verify_browser_status: "work_verify_browser_pass",
      },
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
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(mockTracker.updateIssue).not.toHaveBeenCalled();
    expect(mockNotifier.notify).toHaveBeenCalledTimes(1);
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reaction.triggered",
      }),
    );

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["acceptance_total"]).toBe("0");
    expect(meta?.["acceptance_checked"]).toBe("0");
    expect(meta?.["acceptance_unchecked"]).toBe("0");
    expect(meta?.["acceptance_status"]).toBe("blocked_no_checkboxes");
  });

  it("updates tracker progress on pr.created and review transitions with stage-aware metadata", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviews: vi.fn(),
      getReviewDecision: vi
        .fn()
        .mockResolvedValueOnce("none")
        .mockResolvedValueOnce("pending"),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn(),
      isCompleted: vi.fn(),
      issueUrl: vi.fn().mockReturnValue("https://tracker.local/PYO-27"),
      branchName: vi.fn().mockReturnValue("feat/PYO-27"),
      generatePrompt: vi.fn(),
      updateIssue: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        if (slot === "tracker" && name === "linear") return mockTracker;
        return null;
      }),
    };

    config.reactions = {
      "issue-progress-pr-opened": {
        auto: true,
        action: "update-tracker-progress",
        cooldown: "5m",
      },
      "issue-progress-review-updated": {
        auto: true,
        action: "update-tracker-progress",
        cooldown: "5m",
      },
    };
    config.projects["my-app"] = {
      ...config.projects["my-app"],
      tracker: { plugin: "linear", teamId: "team-id" },
    };

    const session = makeSession({
      status: "working",
      issueId: "PYO-27",
      pr: makePR(),
      metadata: { verify_status: "work_verify_pass_full" },
    });
    vi.mocked(mockRuntime.getOutput).mockResolvedValue(
      [
        "개발 요약:",
        "- 에너미 선택 전환 시 패널 상태 동기화 안정화",
        "",
        "개발 구현:",
        "- tests/editor/PalettePanel.test.ts 회귀 케이스 보강",
        "",
        "검증:",
        "- npm test 통과",
      ].join("\n"),
    );
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      issue: "PYO-27",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithTracker,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    await lm.check("app-1");

    expect(mockTracker.updateIssue).toHaveBeenCalledTimes(2);
    expect(mockTracker.updateIssue).toHaveBeenNthCalledWith(
      1,
      "PYO-27",
      expect.objectContaining({
        state: "in_progress",
        comment: expect.stringMatching(
          /PR is now open\.[\s\S]*GitHub PR page:[\s\S]*Development summary:[\s\S]*Implementation details:/,
        ),
      }),
      config.projects["my-app"],
    );
    const updateIssueMock = vi.mocked(mockTracker.updateIssue!);
    const firstCall = updateIssueMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error("Expected first tracker update call");
    const firstUpdatePayload = firstCall[1];
    expect(firstUpdatePayload).toBeDefined();
    if (!firstUpdatePayload) throw new Error("Expected tracker update payload");
    const firstComment = firstUpdatePayload.comment;
    expect(firstComment).toBeDefined();
    if (!firstComment) throw new Error("Expected tracker progress comment on first update call");
    expect(firstComment).toContain("Development summary: 에너미 선택 전환 시 패널 상태 동기화 안정화");
    expect(firstComment).toContain(
      "Implementation details: tests/editor/PalettePanel.test.ts 회귀 케이스 보강",
    );
    expect(mockTracker.updateIssue).toHaveBeenNthCalledWith(
      2,
      "PYO-27",
      expect.objectContaining({
        state: "in_progress",
        workflowStateName: "In Review",
        comment: expect.stringContaining("review pending"),
      }),
      config.projects["my-app"],
    );

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["progress_stage"]).toBe("review_updated");
    expect(meta?.["progress_updated_at"]).toBeTruthy();
  });

  it("suppresses repeated review-stage updates inside cooldown and resumes after cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const mockSCM: SCM = {
        name: "mock-scm",
        detectPR: vi.fn(),
        getPRState: vi.fn().mockResolvedValue("open"),
        mergePR: vi.fn(),
        closePR: vi.fn(),
        getCIChecks: vi.fn(),
        getCISummary: vi.fn().mockResolvedValue("passing"),
        getReviews: vi.fn(),
        getReviewDecision: vi
          .fn()
          .mockResolvedValueOnce("pending")
          .mockResolvedValueOnce("approved")
          .mockResolvedValueOnce("approved"),
        getPendingComments: vi.fn(),
        getAutomatedComments: vi.fn(),
        getMergeability: vi
          .fn()
          .mockResolvedValueOnce({ mergeable: false })
          .mockResolvedValueOnce({ mergeable: true }),
      };

      const mockTracker: Tracker = {
        name: "mock-tracker",
        getIssue: vi.fn(),
        isCompleted: vi.fn(),
        issueUrl: vi.fn().mockReturnValue("https://tracker.local/PYO-28"),
        branchName: vi.fn().mockReturnValue("feat/PYO-28"),
        generatePrompt: vi.fn(),
        updateIssue: vi.fn().mockResolvedValue(undefined),
      };

      const registryWithTracker: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string, name: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return mockAgent;
          if (slot === "scm") return mockSCM;
          if (slot === "tracker" && name === "linear") return mockTracker;
          return null;
        }),
      };

      config.reactions = {
        "issue-progress-review-updated": {
          auto: true,
          action: "update-tracker-progress",
          cooldown: "5m",
        },
      };
      config.projects["my-app"] = {
        ...config.projects["my-app"],
        tracker: { plugin: "linear", teamId: "team-id" },
      };

      const session = makeSession({
        status: "pr_open",
        issueId: "PYO-28",
        pr: makePR(),
        metadata: {},
      });
      vi.mocked(mockSessionManager.get).mockResolvedValue(session);

      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp",
        branch: "main",
        status: "pr_open",
        project: "my-app",
        issue: "PYO-28",
      });

      const lm = createLifecycleManager({
        config,
        registry: registryWithTracker,
        sessionManager: mockSessionManager,
      });

      await lm.check("app-1");
      expect(mockTracker.updateIssue).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
      await lm.check("app-1");
      expect(mockTracker.updateIssue).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-01-01T00:07:00.000Z"));
      await lm.check("app-1");
      expect(mockTracker.updateIssue).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches workflow target state immediately on changes_requested", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    try {
      const mockSCM: SCM = {
        name: "mock-scm",
        detectPR: vi.fn(),
        getPRState: vi.fn().mockResolvedValue("open"),
        mergePR: vi.fn(),
        closePR: vi.fn(),
        getCIChecks: vi.fn(),
        getCISummary: vi.fn().mockResolvedValue("passing"),
        getReviews: vi.fn(),
        getReviewDecision: vi
          .fn()
          .mockResolvedValueOnce("pending")
          .mockResolvedValueOnce("changes_requested")
          .mockResolvedValueOnce("pending"),
        getPendingComments: vi.fn(),
        getAutomatedComments: vi.fn(),
        getMergeability: vi.fn(),
      };

      const mockTracker: Tracker = {
        name: "mock-tracker",
        getIssue: vi.fn(),
        isCompleted: vi.fn(),
        issueUrl: vi.fn().mockReturnValue("https://tracker.local/PYO-29"),
        branchName: vi.fn().mockReturnValue("feat/PYO-29"),
        generatePrompt: vi.fn(),
        updateIssue: vi.fn().mockResolvedValue(undefined),
      };

      const registryWithTracker: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string, name: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return mockAgent;
          if (slot === "scm") return mockSCM;
          if (slot === "tracker" && name === "linear") return mockTracker;
          return null;
        }),
      };

      config.reactions = {
        "issue-progress-review-updated": {
          auto: true,
          action: "update-tracker-progress",
          cooldown: "5m",
        },
      };
      config.projects["my-app"] = {
        ...config.projects["my-app"],
        tracker: { plugin: "linear", teamId: "team-id" },
      };

      const session = makeSession({
        status: "pr_open",
        issueId: "PYO-29",
        pr: makePR(),
        metadata: { verify_status: "work_verify_pass_full" },
      });
      vi.mocked(mockSessionManager.get).mockResolvedValue(session);

      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp",
        branch: "main",
        status: "pr_open",
        project: "my-app",
        issue: "PYO-29",
      });

      const lm = createLifecycleManager({
        config,
        registry: registryWithTracker,
        sessionManager: mockSessionManager,
      });

      await lm.check("app-1");
      expect(mockTracker.updateIssue).toHaveBeenNthCalledWith(
        1,
        "PYO-29",
        expect.objectContaining({
          state: "in_progress",
          workflowStateName: "In Review",
        }),
        config.projects["my-app"],
      );

      vi.setSystemTime(new Date("2026-01-02T00:01:00.000Z"));
      await lm.check("app-1");
      expect(mockTracker.updateIssue).toHaveBeenNthCalledWith(
        2,
        "PYO-29",
        expect.objectContaining({
          state: "in_progress",
          workflowStateName: "In Progress",
        }),
        config.projects["my-app"],
      );

      vi.setSystemTime(new Date("2026-01-02T00:02:00.000Z"));
      await lm.check("app-1");
      expect(mockTracker.updateIssue).toHaveBeenNthCalledWith(
        3,
        "PYO-29",
        expect.objectContaining({
          state: "in_progress",
          workflowStateName: "In Review",
        }),
        config.projects["my-app"],
      );
      expect(mockTracker.updateIssue).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
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
