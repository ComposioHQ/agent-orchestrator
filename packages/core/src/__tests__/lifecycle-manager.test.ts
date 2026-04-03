import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { createSessionManager } from "../session-manager.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Agent,
  ActivityState,
  SessionStatus,
} from "../types.js";
import {
  createTestEnvironment,
  createMockPlugins,
  createMockRegistry,
  createMockSessionManager,
  createMockSCM,
  createMockNotifier,
  makeSession,
  makePR,
  type TestEnvironment,
  type MockPlugins,
} from "./test-utils.js";

let env: TestEnvironment;
let plugins: MockPlugins;
let mockRegistry: PluginRegistry;
let mockSessionManager: SessionManager;
let config: OrchestratorConfig;

beforeEach(() => {
  env = createTestEnvironment();
  plugins = createMockPlugins();
  mockRegistry = createMockRegistry({ runtime: plugins.runtime, agent: plugins.agent });
  mockSessionManager = createMockSessionManager();
  config = env.config;
});

afterEach(() => {
  env.cleanup();
});

/** Helper: write standard session metadata and return a lifecycle manager */
function setupCheck(
  sessionId: string,
  opts: {
    session: ReturnType<typeof makeSession>;
    metaOverrides?: Record<string, unknown>;
    registry?: PluginRegistry;
    configOverride?: OrchestratorConfig;
  },
) {
  vi.mocked(mockSessionManager.get).mockResolvedValue(opts.session);

  writeMetadata(env.sessionsDir, sessionId, {
    worktree: "/tmp",
    branch: opts.session.branch ?? "main",
    status: opts.session.status,
    project: "my-app",
    ...opts.metaOverrides,
  });

  return createLifecycleManager({
    config: opts.configOverride ?? config,
    registry: opts.registry ?? mockRegistry,
    sessionManager: mockSessionManager,
  });
}

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
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "spawning" }),
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta!["status"]).toBe("working");
  });

  it("uses worker-specific agent fallback when metadata does not persist an agent", async () => {
    const codexAgent: Agent = {
      ...plugins.agent,
      name: "codex",
      processName: "codex",
      getActivityState: vi.fn().mockResolvedValue({ state: "active" as ActivityState }),
    };

    const registryWithMultipleAgents: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") {
          if (name === "codex") return codexAgent;
          if (name === "mock-agent") return plugins.agent;
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
          worker: { agent: "codex" },
        },
      },
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working", metadata: {} }),
      registry: registryWithMultipleAgents,
      configOverride: configWithWorkerAgent,
    });

    await lm.check("app-1");

    expect(codexAgent.getActivityState).toHaveBeenCalled();
    expect(plugins.agent.getActivityState).not.toHaveBeenCalled();
  });

  it("detects killed state when runtime is dead", async () => {
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("detects killed state when getActivityState returns exited", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({ state: "exited" });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("detects killed via terminal fallback when getActivityState returns null", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.agent.detectActivity).mockReturnValue("idle");
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("stays working when agent is idle but process is still running (fallback path)", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.agent.detectActivity).mockReturnValue("idle");
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(true);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("detects needs_input from agent", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({ state: "waiting_input" });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("detects needs_input for codex from terminal output even when getActivityState returns idle", async () => {
    const codexAgent: Agent = {
      ...plugins.agent,
      name: "codex",
      processName: "codex",
      getActivityState: vi.fn().mockResolvedValue({
        state: "idle" as ActivityState,
        timestamp: new Date(),
      }),
      detectActivity: vi.fn().mockReturnValue("waiting_input" as ActivityState),
    };

    const runtimeWithApprovalPrompt = {
      ...plugins.runtime,
      getOutput: vi.fn().mockResolvedValue("Approval required\n(y)es / (n)o\n"),
    };

    const registryWithCodex: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return runtimeWithApprovalPrompt;
        if (slot === "agent") {
          if (name === "codex") return codexAgent;
          if (name === "mock-agent") return plugins.agent;
        }
        return null;
      }),
    };

    const configWithCodexWorker: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          worker: { agent: "codex" },
        },
      },
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working", metadata: { agent: "codex" } }),
      metaOverrides: { agent: "codex" },
      registry: registryWithCodex,
      configOverride: configWithCodexWorker,
    });

    await lm.check("app-1");

    expect(codexAgent.getActivityState).toHaveBeenCalled();
    expect(runtimeWithApprovalPrompt.getOutput).toHaveBeenCalled();
    expect(codexAgent.detectActivity).toHaveBeenCalledWith("Approval required\n(y)es / (n)o\n");
    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("transitions to stuck when idle exceeds agent-stuck threshold (OpenCode-style activity)", async () => {
    config.reactions = {
      "agent-stuck": { auto: true, action: "notify", threshold: "1m" },
    };

    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working", metadata: { agent: "mock-agent" } }),
      metaOverrides: { agent: "mock-agent" },
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("uses global agent-stuck threshold when project override omits threshold", async () => {
    config.reactions = {
      "agent-stuck": { auto: true, action: "notify", threshold: "1m" },
    };
    config.projects["my-app"] = {
      ...config.projects["my-app"],
      reactions: { "agent-stuck": { auto: true, action: "notify" } },
    };

    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working", metadata: { agent: "mock-agent" } }),
      metaOverrides: { agent: "mock-agent" },
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("still auto-detects PR before marking idle sessions as stuck", async () => {
    config.reactions = {
      "agent-stuck": { auto: true, action: "notify", threshold: "1m" },
    };

    const mockSCM = createMockSCM({
      detectPR: vi.fn().mockResolvedValue(makePR()),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      }),
    });

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "working",
        branch: "feat/test",
        pr: null,
        metadata: { agent: "mock-agent" },
      }),
      metaOverrides: { branch: "feat/test", agent: "mock-agent" },
      registry,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).toHaveBeenCalledOnce();
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["pr"]).toBe(makePR().url);
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("preserves stuck state when getActivityState throws", async () => {
    vi.mocked(plugins.agent.getActivityState).mockRejectedValue(new Error("probe failed"));

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "stuck" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("preserves needs_input state when getActivityState throws", async () => {
    vi.mocked(plugins.agent.getActivityState).mockRejectedValue(new Error("probe failed"));

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "needs_input" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("preserves stuck state when getActivityState returns null and getOutput throws", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.runtime.getOutput).mockRejectedValue(new Error("tmux error"));

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "stuck" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("still marks a session as stuck when native idle detection succeeds but getOutput throws", async () => {
    config.reactions = {
      "agent-stuck": { auto: true, action: "notify", threshold: "1m" },
    };

    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });
    vi.mocked(plugins.runtime.getOutput).mockRejectedValue(new Error("tmux error"));

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("detects PR states from SCM", async () => {
    const mockSCM = createMockSCM({ getCISummary: vi.fn().mockResolvedValue("failing") });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("ci_failed");
  });

  it("skips PR auto-detection when metadata disables it", async () => {
    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(makePR()) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    writeMetadata(env.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "working",
      project: "my-app",
      prAutoDetect: "off",
    });

    const realSessionManager = createSessionManager({ config, registry });
    const session = await realSessionManager.get("app-1");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("skips PR auto-detection for orchestrator sessions", async () => {
    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(makePR()) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    writeMetadata(env.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "master",
      status: "working",
      project: "my-app",
      role: "orchestrator",
    });

    const realSessionManager = createSessionManager({ config, registry });
    const session = await realSessionManager.get("app-1");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("skips PR auto-detection for orchestrator sessions identified by ID suffix (fallback)", async () => {
    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(makePR()) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    writeMetadata(env.sessionsDir, "app-orchestrator", {
      worktree: "/tmp",
      branch: "master",
      status: "working",
      project: "my-app",
    });

    const realSessionManager = createSessionManager({ config, registry });
    const session = await realSessionManager.get("app-orchestrator");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-orchestrator");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-orchestrator")).toBe("working");
  });

  it("detects merged PR", async () => {
    const mockSCM = createMockSCM({ getPRState: vi.fn().mockResolvedValue("merged") });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "approved", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("merged");
  });

  it("detects mergeable when approved + CI green", async () => {
    const mockSCM = createMockSCM({
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
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
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
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

    const mockSCM = createMockSCM({ getCISummary: vi.fn().mockResolvedValue("failing") });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "CI is failing. Fix it.");
  });

  it("does not trigger reaction when auto=false", async () => {
    config.reactions = {
      "ci-failed": { auto: false, action: "send-to-agent", message: "CI is failing." },
    };

    const mockSCM = createMockSCM({ getCISummary: vi.fn().mockResolvedValue("failing") });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("suppresses immediate notification when send-to-agent reaction handles the event", async () => {
    const notifier = createMockNotifier();
    const mockSCM = createMockSCM({
      getCISummary: vi.fn().mockResolvedValue("failing"),
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

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

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
      configOverride: configWithReaction,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Fix CI");
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("dispatches unresolved review comments even when reviewDecision stays unchanged", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Handle review comments.",
      },
    };

    const mockSCM = createMockSCM({
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
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Handle review comments.");

    vi.mocked(mockSessionManager.send).mockClear();
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
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

    const mockSCM = createMockSCM({
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
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
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

    const mockSCM = createMockSCM({
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
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
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

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastAutomatedReviewDispatchHash"]).toBe("bot-1");
  });

  it("dispatches CI failure details with check names and URLs on subsequent polls", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing. Fix it.",
        retries: 3,
        escalateAfter: 3,
      },
    };

    const mockSCM = createMockSCM({
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getCIChecks: vi.fn().mockResolvedValue([
        {
          name: "lint",
          status: "failed",
          url: "https://github.com/org/repo/actions/runs/123",
          conclusion: "FAILURE",
        },
        {
          name: "test",
          status: "passed",
          url: "https://github.com/org/repo/actions/runs/124",
          conclusion: "SUCCESS",
        },
        {
          name: "typecheck",
          status: "failed",
          url: "https://github.com/org/repo/actions/runs/125",
          conclusion: "FAILURE",
        },
      ]),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // First check: transition to ci_failed — sends the reaction message
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "CI is failing. Fix it.");

    vi.mocked(mockSessionManager.send).mockClear();

    // Second check: still ci_failed, same failures — dispatches detailed CI info
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    const sentMessage = vi.mocked(mockSessionManager.send).mock.calls[0]![1];
    expect(sentMessage).toContain("lint");
    expect(sentMessage).toContain("typecheck");
    expect(sentMessage).toContain("https://github.com/org/repo/actions/runs/123");
    expect(sentMessage).toContain("https://github.com/org/repo/actions/runs/125");
    // Should NOT include the passing check
    expect(sentMessage).not.toContain("runs/124");
  });

  it("does not re-dispatch CI failure details when failure set is unchanged", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing.",
        retries: 3,
        escalateAfter: 3,
      },
    };

    const mockSCM = createMockSCM({
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getCIChecks: vi.fn().mockResolvedValue([
        { name: "lint", status: "failed", conclusion: "FAILURE" },
      ]),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // First check: transition reaction
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    vi.mocked(mockSessionManager.send).mockClear();

    // Second check: dispatches CI details
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    vi.mocked(mockSessionManager.send).mockClear();

    // Third check: same failures — should NOT dispatch again
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastCIFailureDispatchHash"]).toBeTruthy();
  });

  it("re-dispatches CI failure details when a new check fails", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing.",
        retries: 5,
        escalateAfter: 5,
      },
    };

    const getCIChecksMock = vi.fn().mockResolvedValue([
      { name: "lint", status: "failed", conclusion: "FAILURE" },
    ]);
    const mockSCM = createMockSCM({
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getCIChecks: getCIChecksMock,
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // First check: transition + second poll to dispatch details
    await lm.check("app-1");
    vi.mocked(mockSessionManager.send).mockClear();
    await lm.check("app-1");
    vi.mocked(mockSessionManager.send).mockClear();

    // Third check: same failures — no dispatch
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    // Now a different check fails too
    getCIChecksMock.mockResolvedValue([
      { name: "lint", status: "failed", conclusion: "FAILURE" },
      { name: "test", status: "failed", conclusion: "FAILURE" },
    ]);

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    const sentMessage = vi.mocked(mockSessionManager.send).mock.calls[0]![1];
    expect(sentMessage).toContain("lint");
    expect(sentMessage).toContain("test");
  });

  it("clears CI failure tracking when PR is merged", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing.",
      },
    };

    const mockSCM = createMockSCM({
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getCIChecks: vi.fn().mockResolvedValue([
        { name: "lint", status: "failed", conclusion: "FAILURE" },
      ]),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");

    // Now PR is merged
    vi.mocked(mockSCM.getCISummary).mockResolvedValue("passing");
    vi.mocked(mockSCM.getPRState).mockResolvedValue("merged");

    await lm.check("app-1");

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastCIFailureFingerprint"]).toBeFalsy();
    expect(metadata?.["lastCIFailureDispatchHash"]).toBeFalsy();
  });

  it("clears CI failure tracking when CI recovers to passing", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing.",
      },
    };

    const getCISummaryMock = vi.fn().mockResolvedValue("failing");
    const getCIChecksMock = vi.fn().mockResolvedValue([
      { name: "lint", status: "failed", conclusion: "FAILURE" },
    ]);
    const mockSCM = createMockSCM({
      getCISummary: getCISummaryMock,
      getCIChecks: getCIChecksMock,
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // First: transition to ci_failed, then dispatch details
    await lm.check("app-1");
    await lm.check("app-1");

    // Verify tracking was set
    let metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastCIFailureDispatchHash"]).toBeTruthy();

    // CI recovers
    getCISummaryMock.mockResolvedValue("passing");
    getCIChecksMock.mockResolvedValue([]);
    await lm.check("app-1");

    metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastCIFailureFingerprint"]).toBeFalsy();
    expect(metadata?.["lastCIFailureDispatchHash"]).toBeFalsy();
  });

  it("uses notify action for CI failure details when configured", async () => {
    const notifier = createMockNotifier();

    const configWithNotify = {
      ...config,
      reactions: {
        "ci-failed": {
          auto: true,
          action: "notify" as const,
          retries: 3,
          escalateAfter: 3,
        },
      },
      notificationRouting: {
        ...config.notificationRouting,
        warning: ["desktop"],
        info: ["desktop"],
      },
    };

    const mockSCM = createMockSCM({
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getCIChecks: vi.fn().mockResolvedValue([
        { name: "lint", status: "failed", conclusion: "FAILURE" },
      ]),
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
      configOverride: configWithNotify,
    });

    // First check: transition — notifier called for reaction
    await lm.check("app-1");
    expect(notifier.notify).toHaveBeenCalled();

    vi.mocked(notifier.notify).mockClear();

    // Second check: CI detail dispatch via notify action
    await lm.check("app-1");
    expect(notifier.notify).toHaveBeenCalled();
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("uses notify action for merge conflicts when configured", async () => {
    const notifier = createMockNotifier();

    const configWithNotify = {
      ...config,
      reactions: {
        "merge-conflicts": {
          auto: true,
          action: "notify" as const,
        },
      },
      notificationRouting: {
        ...config.notificationRouting,
        warning: ["desktop"],
        info: ["desktop"],
      },
    };

    const mockSCM = createMockSCM({
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: false,
        blockers: ["Merge conflicts"],
      }),
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
      configOverride: configWithNotify,
    });

    await lm.check("app-1");
    expect(notifier.notify).toHaveBeenCalled();
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("dispatches merge conflict notification when PR has conflicts", async () => {
    config.reactions = {
      "merge-conflicts": {
        auto: true,
        action: "send-to-agent",
        message: "Your branch has merge conflicts. Rebase and resolve them.",
      },
    };

    const mockSCM = createMockSCM({
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: false,
        blockers: ["Merge conflicts"],
      }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-1",
      "Your branch has merge conflicts. Rebase and resolve them.",
    );
  });

  it("does not re-dispatch merge conflict notification when already dispatched", async () => {
    config.reactions = {
      "merge-conflicts": {
        auto: true,
        action: "send-to-agent",
        message: "Resolve merge conflicts.",
      },
    };

    const mockSCM = createMockSCM({
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: false,
        blockers: ["Merge conflicts"],
      }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    vi.mocked(mockSessionManager.send).mockClear();

    // Second check — same conflicts, should not re-send
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("re-dispatches merge conflict notification after conflicts are resolved and recur", async () => {
    config.reactions = {
      "merge-conflicts": {
        auto: true,
        action: "send-to-agent",
        message: "Resolve merge conflicts.",
      },
    };

    const getMergeabilityMock = vi.fn().mockResolvedValue({
      mergeable: false,
      ciPassing: true,
      approved: false,
      noConflicts: false,
      blockers: ["Merge conflicts"],
    });
    const mockSCM = createMockSCM({
      getMergeability: getMergeabilityMock,
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // First: conflicts detected, notification sent
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    vi.mocked(mockSessionManager.send).mockClear();

    // Second: conflicts resolved
    getMergeabilityMock.mockResolvedValue({
      mergeable: true,
      ciPassing: true,
      approved: false,
      noConflicts: true,
      blockers: [],
    });
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastMergeConflictDispatched"]).toBeFalsy();

    // Third: conflicts recur — should re-dispatch
    getMergeabilityMock.mockResolvedValue({
      mergeable: false,
      ciPassing: true,
      approved: false,
      noConflicts: false,
      blockers: ["Merge conflicts"],
    });
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
  });

  it("clears merge conflict tracking when PR is merged", async () => {
    config.reactions = {
      "merge-conflicts": {
        auto: true,
        action: "send-to-agent",
        message: "Resolve merge conflicts.",
      },
    };

    const mockSCM = createMockSCM({
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: false,
        blockers: ["Merge conflicts"],
      }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");

    // Now PR is merged
    vi.mocked(mockSCM.getPRState).mockResolvedValue("merged");

    await lm.check("app-1");

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastMergeConflictDispatched"]).toBeFalsy();
  });

  it("notifies humans on significant transitions without reaction config", async () => {
    const notifier = createMockNotifier();
    const mockSCM = createMockSCM({ getPRState: vi.fn().mockResolvedValue("merged") });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "approved", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(notifier.notify).toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "merge.completed" }),
    );
  });
});

describe("pollAll terminal status accounting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats all TERMINAL_STATUSES as inactive for all-complete", async () => {
    const notifier = createMockNotifier();
    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    // All sessions in various terminal states — should count as inactive
    const terminalSessions = [
      makeSession({ id: "s-1", status: "killed" as SessionStatus }),
      makeSession({ id: "s-2", status: "merged" as SessionStatus }),
      makeSession({ id: "s-3", status: "done" as SessionStatus }),
      makeSession({ id: "s-4", status: "errored" as SessionStatus }),
      makeSession({ id: "s-5", status: "terminated" as SessionStatus }),
      makeSession({ id: "s-6", status: "cleanup" as SessionStatus }),
    ];

    vi.mocked(mockSessionManager.list).mockResolvedValue(terminalSessions);

    // Route info-priority notifications to desktop so we can observe them
    config.notificationRouting.info = ["desktop"];
    config.reactions = {
      "all-complete": { auto: true, action: "notify" },
    };

    const lm = createLifecycleManager({
      config,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    // Let the immediate pollAll() run
    await vi.advanceTimersByTimeAsync(0);

    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "reaction.triggered" }),
    );

    lm.stop();
  });

  it("does not fire all-complete when a session is in non-terminal status like done is missing", async () => {
    const notifier = createMockNotifier();
    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    // Mix of terminal and active sessions
    const sessions = [
      makeSession({ id: "s-1", status: "killed" as SessionStatus }),
      makeSession({ id: "s-2", status: "working" as SessionStatus }),
    ];

    vi.mocked(mockSessionManager.list).mockResolvedValue(sessions);

    config.reactions = {
      "all-complete": { auto: true, action: "notify" },
    };

    const lm = createLifecycleManager({
      config,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    await vi.advanceTimersByTimeAsync(0);

    // all-complete should NOT have fired — "working" is still active
    const allCompleteNotifications = vi.mocked(notifier.notify).mock.calls.filter(
      (call: unknown[]) => {
        const event = call[0] as Record<string, unknown> | undefined;
        const data = event?.data as Record<string, unknown> | undefined;
        return event?.type === "reaction.triggered" && data?.reactionKey === "all-complete";
      },
    );
    expect(allCompleteNotifications).toHaveLength(0);

    lm.stop();
  });

  it("skips polling sessions in terminal statuses like done or errored", async () => {
    // Sessions in "done" / "errored" should not be polled
    const sessions = [
      makeSession({ id: "s-done", status: "done" as SessionStatus }),
      makeSession({ id: "s-errored", status: "errored" as SessionStatus }),
    ];

    vi.mocked(mockSessionManager.list).mockResolvedValue(sessions);

    // If these sessions were polled, determineStatus would call runtime.isAlive.
    // Reset call count and verify it's not called.
    vi.mocked(plugins.runtime.isAlive).mockClear();

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    await vi.advanceTimersByTimeAsync(0);

    // Terminal sessions should not be polled — runtime.isAlive should not be called
    expect(plugins.runtime.isAlive).not.toHaveBeenCalled();

    lm.stop();
  });
});

describe("getStates", () => {
  it("returns copy of states map", async () => {
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "spawning" }),
    });

    await lm.check("app-1");

    const states = lm.getStates();
    expect(states.get("app-1")).toBe("working");

    // Modifying returned map shouldn't affect internal state
    states.set("app-1", "killed");
    expect(lm.getStates().get("app-1")).toBe("working");
  });
});
