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

function writeCompleteEvidence(workspacePath: string, sessionId = "app-1"): string {
  const evidenceDir = join(workspacePath, ".ao", "evidence", sessionId);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, "command-log.json"),
    JSON.stringify({
      schemaVersion: "1",
      complete: true,
      entries: [{ command: "pnpm --filter @composio/ao-core test", exitCode: 0 }],
    }),
  );
  writeFileSync(
    join(evidenceDir, "tests-run.json"),
    JSON.stringify({
      schemaVersion: "1",
      complete: true,
      tests: [{ command: "pnpm --filter @composio/ao-core test", status: "passed" }],
    }),
  );
  writeFileSync(
    join(evidenceDir, "changed-paths.json"),
    JSON.stringify({
      schemaVersion: "1",
      complete: true,
      paths: ["packages/core/src/evidence.ts"],
    }),
  );
  writeFileSync(
    join(evidenceDir, "known-risks.json"),
    JSON.stringify({
      schemaVersion: "1",
      complete: true,
      risks: [{ risk: "None" }],
    }),
  );
  return evidenceDir;
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

  it("detects done state from complete worker evidence artifacts", async () => {
    const workspacePath = join(tmpDir, "ws");
    const evidenceDir = writeCompleteEvidence(workspacePath);

    const session = makeSession({ status: "working", workspacePath, pr: null });
    session.metadata = {
      evidenceSchemaVersion: "1",
      evidenceDir,
      evidenceCommandLog: join(evidenceDir, "command-log.json"),
      evidenceTestsRun: join(evidenceDir, "tests-run.json"),
      evidenceChangedPaths: join(evidenceDir, "changed-paths.json"),
      evidenceKnownRisks: join(evidenceDir, "known-risks.json"),
    };
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: workspacePath,
      branch: "main",
      status: "working",
      project: "my-app",
      evidenceSchemaVersion: "1",
      evidenceDir,
      evidenceCommandLog: join(evidenceDir, "command-log.json"),
      evidenceTestsRun: join(evidenceDir, "tests-run.json"),
      evidenceChangedPaths: join(evidenceDir, "changed-paths.json"),
      evidenceKnownRisks: join(evidenceDir, "known-risks.json"),
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("done");
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["status"]).toBe("done");
  });

  it("auto-spawns verifier after complete worker evidence", async () => {
    config.defaults.verifier = { runtime: "mock", agent: "mock-agent" };
    config.projects["my-app"].verifier = { runtime: "mock", agent: "mock-agent" };

    const workspacePath = join(tmpDir, "ws-verifier");
    const evidenceDir = writeCompleteEvidence(workspacePath);
    const worker = makeSession({ status: "working", workspacePath, pr: null });
    worker.metadata = {
      evidenceSchemaVersion: "1",
      evidenceDir,
      evidenceCommandLog: join(evidenceDir, "command-log.json"),
      evidenceTestsRun: join(evidenceDir, "tests-run.json"),
      evidenceChangedPaths: join(evidenceDir, "changed-paths.json"),
      evidenceKnownRisks: join(evidenceDir, "known-risks.json"),
    };

    const verifierSession = makeSession({
      id: "app-2",
      status: "spawning",
      workspacePath,
      issueId: worker.issueId,
      branch: worker.branch,
      metadata: {},
    });

    vi.mocked(mockSessionManager.get).mockResolvedValue(worker);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(verifierSession);

    writeMetadata(sessionsDir, "app-1", {
      worktree: workspacePath,
      branch: "main",
      status: "working",
      project: "my-app",
      evidenceSchemaVersion: "1",
      evidenceDir,
      evidenceCommandLog: join(evidenceDir, "command-log.json"),
      evidenceTestsRun: join(evidenceDir, "tests-run.json"),
      evidenceChangedPaths: join(evidenceDir, "changed-paths.json"),
      evidenceKnownRisks: join(evidenceDir, "known-risks.json"),
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("verifier_pending");
    expect(mockSessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "my-app",
        runtime: "mock",
        agent: "mock-agent",
      }),
    );

    const workerMeta = readMetadataRaw(sessionsDir, "app-1");
    expect(workerMeta!["verifierSessionId"]).toBe("app-2");
    expect(workerMeta!["verifierStatus"]).toBe("pending");

    const verifierMeta = readMetadataRaw(sessionsDir, "app-2");
    expect(verifierMeta!["role"]).toBe("verifier");
    expect(verifierMeta!["verifierFor"]).toBe("app-1");
  });

  it("marks worker pr_ready only after verifier pass", async () => {
    config.defaults.verifier = { runtime: "mock", agent: "mock-agent" };
    config.projects["my-app"].verifier = { runtime: "mock", agent: "mock-agent" };

    const workspacePath = join(tmpDir, "ws-pass");
    const evidenceDir = writeCompleteEvidence(workspacePath);

    const worker = makeSession({ status: "verifier_pending", workspacePath, pr: null });
    worker.metadata = {
      verifierSessionId: "app-2",
      verifierStatus: "pending",
      evidenceSchemaVersion: "1",
      evidenceDir,
      evidenceCommandLog: join(evidenceDir, "command-log.json"),
      evidenceTestsRun: join(evidenceDir, "tests-run.json"),
      evidenceChangedPaths: join(evidenceDir, "changed-paths.json"),
      evidenceKnownRisks: join(evidenceDir, "known-risks.json"),
    };

    const verifier = makeSession({
      id: "app-2",
      status: "done",
      workspacePath,
      metadata: {
        role: "verifier",
        verifierFor: "app-1",
        verifierVerdict: "passed",
      },
    });

    vi.mocked(mockSessionManager.get).mockImplementation(async (sessionId: string) => {
      if (sessionId === "app-1") return worker;
      if (sessionId === "app-2") return verifier;
      return null;
    });

    writeMetadata(sessionsDir, "app-1", {
      worktree: workspacePath,
      branch: "main",
      status: "verifier_pending",
      project: "my-app",
      verifierSessionId: "app-2",
      verifierStatus: "pending",
      evidenceSchemaVersion: "1",
      evidenceDir,
      evidenceCommandLog: join(evidenceDir, "command-log.json"),
      evidenceTestsRun: join(evidenceDir, "tests-run.json"),
      evidenceChangedPaths: join(evidenceDir, "changed-paths.json"),
      evidenceKnownRisks: join(evidenceDir, "known-risks.json"),
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("pr_ready");
    const workerMeta = readMetadataRaw(sessionsDir, "app-1");
    expect(workerMeta!["verifierStatus"]).toBe("passed");
  });

  it("routes verifier failure feedback back to worker", async () => {
    config.defaults.verifier = { runtime: "mock", agent: "mock-agent" };
    config.projects["my-app"].verifier = { runtime: "mock", agent: "mock-agent" };

    const workspacePath = join(tmpDir, "ws-fail");
    const evidenceDir = writeCompleteEvidence(workspacePath);
    const worker = makeSession({ status: "verifier_pending", workspacePath, pr: null });
    worker.metadata = {
      verifierSessionId: "app-2",
      verifierStatus: "pending",
      evidenceSchemaVersion: "1",
      evidenceDir,
      evidenceCommandLog: join(evidenceDir, "command-log.json"),
      evidenceTestsRun: join(evidenceDir, "tests-run.json"),
      evidenceChangedPaths: join(evidenceDir, "changed-paths.json"),
      evidenceKnownRisks: join(evidenceDir, "known-risks.json"),
    };

    const verifier = makeSession({
      id: "app-2",
      status: "done",
      workspacePath,
      metadata: {
        role: "verifier",
        verifierFor: "app-1",
        verifierVerdict: "failed",
        verifierFeedback: "Fix flaky tests in packages/core/src/lifecycle-manager.ts",
      },
    });

    vi.mocked(mockSessionManager.get).mockImplementation(async (sessionId: string) => {
      if (sessionId === "app-1") return worker;
      if (sessionId === "app-2") return verifier;
      return null;
    });

    writeMetadata(sessionsDir, "app-1", {
      worktree: workspacePath,
      branch: "main",
      status: "verifier_pending",
      project: "my-app",
      verifierSessionId: "app-2",
      verifierStatus: "pending",
      evidenceSchemaVersion: "1",
      evidenceDir,
      evidenceCommandLog: join(evidenceDir, "command-log.json"),
      evidenceTestsRun: join(evidenceDir, "tests-run.json"),
      evidenceChangedPaths: join(evidenceDir, "changed-paths.json"),
      evidenceKnownRisks: join(evidenceDir, "known-risks.json"),
    });

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("verifier_failed");
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-1",
      expect.stringContaining("Fix flaky tests"),
    );

    const workerMeta = readMetadataRaw(sessionsDir, "app-1");
    expect(workerMeta!["verifierStatus"]).toBe("failed");
    expect(workerMeta!["verifierSessionId"]).toBeUndefined();
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

  it("blocks mergeable transition until verifier passes", async () => {
    config.defaults.verifier = { runtime: "mock", agent: "mock-agent" };
    config.projects["my-app"].verifier = { runtime: "mock", agent: "mock-agent" };

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
    session.metadata = { verifierStatus: "pending" };
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
      verifierStatus: "pending",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithSCM,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("approved");
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

  it("sends context-rich reaction message for CI failures", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing. Fix it.",
      },
    };

    vi.mocked(mockRuntime.getOutput).mockResolvedValue(
      Array.from({ length: 10 }, (_, idx) => `line-${idx} ${"x".repeat(60)}`).join("\n"),
    );

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("open"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn().mockResolvedValue([
        { name: "build", status: "failed", url: "https://example.com/checks/1" },
      ]),
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn().mockResolvedValue("none"),
      getPendingComments: vi.fn().mockResolvedValue([
        {
          id: "c1",
          author: "reviewer",
          body: "Please add a test for this edge case.",
          path: "src/file.ts",
          line: 10,
          isResolved: false,
          createdAt: new Date(),
          url: "https://example.com/review/1",
        },
      ]),
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

    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    const sentMessage = vi.mocked(mockSessionManager.send).mock.calls[0]?.[1];
    expect(sentMessage).toContain("CI failed for PR #42");
    expect(sentMessage).toContain("Failing checks");
    expect(sentMessage).toContain("Top unresolved review comments");
    expect(sentMessage).toContain("Recommended fix order");
    expect(sentMessage).toContain("...(truncated)");
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

  it("retries send-to-agent on subsequent polls when status is unchanged", async () => {
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

    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "Retry CI fix",
        escalationPolicy: {
          retryCounts: { worker: 5, verifier: 5, orchestrator: 5 },
        },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send)
      .mockRejectedValueOnce(new Error("tmux send failed"))
      .mockResolvedValueOnce(undefined);

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

    expect(mockSessionManager.send).toHaveBeenCalledTimes(2);
    expect(mockSessionManager.send).toHaveBeenLastCalledWith("app-1", "Retry CI fix");
  });

  it("escalates deterministically across worker→verifier→orchestrator→human and persists history", async () => {
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

    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "Fix CI now",
        escalationPolicy: {
          retryCounts: { worker: 0, verifier: 0, orchestrator: 0 },
        },
      },
    };

    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);
    vi.mocked(mockSessionManager.send).mockRejectedValue(new Error("send failed"));

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
    });

    const lm = createLifecycleManager({
      config,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");
    await lm.check("app-1");
    await lm.check("app-1");
    await lm.check("app-1"); // Should not notify repeatedly once level=human

    expect(mockNotifier.notify).toHaveBeenCalledTimes(1);
    expect(mockNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "reaction.escalated" }),
    );

    const raw = readMetadataRaw(sessionsDir, "app-1");
    const stateMap = JSON.parse(raw?.["escalationState"] ?? "{}") as Record<string, unknown>;
    const ciFailedState = stateMap["ci-failed"] as {
      level: string;
      history: Array<{ from: string; to: string; reason: string }>;
    };

    expect(ciFailedState.level).toBe("human");
    expect(ciFailedState.history).toHaveLength(3);
    expect(ciFailedState.history[0]).toMatchObject({
      from: "worker",
      to: "verifier",
      reason: "retry_count",
    });
    expect(ciFailedState.history[1]).toMatchObject({
      from: "verifier",
      to: "orchestrator",
      reason: "retry_count",
    });
    expect(ciFailedState.history[2]).toMatchObject({
      from: "orchestrator",
      to: "human",
      reason: "retry_count",
    });
  });

  it("supports time-threshold escalation policies", async () => {
    vi.useFakeTimers();
    try {
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

      config.reactions = {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Fix CI now",
          escalationPolicy: {
            retryCounts: { worker: 99, verifier: 99, orchestrator: 99 },
            timeThresholds: { worker: "1s" },
          },
        },
      };

      const session = makeSession({ status: "pr_open", pr: makePR() });
      vi.mocked(mockSessionManager.get).mockResolvedValue(session);
      vi.mocked(mockSessionManager.send).mockRejectedValue(new Error("send failed"));

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
      vi.setSystemTime(new Date(Date.now() + 1500));
      await lm.check("app-1");

      const raw = readMetadataRaw(sessionsDir, "app-1");
      const stateMap = JSON.parse(raw?.["escalationState"] ?? "{}") as Record<string, unknown>;
      const ciFailedState = stateMap["ci-failed"] as {
        level: string;
        history: Array<{ reason: string }>;
      };

      expect(ciFailedState.level).toBe("verifier");
      expect(ciFailedState.history[0]).toMatchObject({ reason: "time_threshold" });
    } finally {
      vi.useRealTimers();
    }
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
