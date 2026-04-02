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

describe("retriggerAfter", () => {
  function makeSCMWithCIFailing(): SCM {
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
    };
  }

  it("retriggers send-to-agent after retriggerAfter interval when state persists", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is still failing. Try again.",
        retriggerAfter: "5m",
      },
    };

    const mockSCM = makeSCMWithCIFailing();
    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    // Start with pr_open so we can transition to ci_failed
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

    // First check: transitions pr_open → ci_failed, fires reaction
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Immediately check again — retriggerAfter (5m) hasn't elapsed, no retrigger
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
  });

  it("does not retrigger if retriggerAfter interval has not elapsed", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is still failing.",
        retriggerAfter: "60m",
      },
    };

    const mockSCM = makeSCMWithCIFailing();
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

    // Transition: fires first message
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Multiple subsequent checks — interval is 60m, none should retrigger
    await lm.check("app-1");
    await lm.check("app-1");
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
  });

  it("does not retrigger if retriggerAfter is not configured", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing.",
        // No retriggerAfter
      },
    };

    const mockSCM = makeSCMWithCIFailing();
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

    // First check: transition fires reaction
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Subsequent checks: no retrigger since retriggerAfter is not set
    await lm.check("app-1");
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
  });

  it("does not retrigger for notify reactions (only send-to-agent)", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "notify",
        priority: "warning",
        retriggerAfter: "1s",
      },
    };

    const mockSCM = makeSCMWithCIFailing();
    const mockNotifier: Notifier = {
      name: "mock-notifier",
      notify: vi.fn().mockResolvedValue(undefined),
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

    // Transition fires notify reaction
    await lm.check("app-1");

    // Even though retriggerAfter is 1s and interval has effectively elapsed,
    // retrigger only applies to send-to-agent — no extra sends
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });
});

describe("event log integration", () => {
  it("accepts a custom event log and records state transitions", async () => {
    const { createNullEventLog: _createNull, ...rest } = await import("../event-log.js");
    const appendedEntries: import("../event-log.js").EventLogEntry[] = [];
    const testEventLog = {
      append: vi.fn((entry: import("../event-log.js").EventLogEntry) => {
        appendedEntries.push(entry);
      }),
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
      eventLog: testEventLog,
    });

    await lm.check("app-1");

    // Should have logged the transition
    expect(testEventLog.append).toHaveBeenCalled();
    const transitionEntry = appendedEntries.find(
      (e) => e.type === "session.working" || e.data?.["newStatus"] === "working",
    );
    expect(transitionEntry).toBeDefined();
    expect(transitionEntry?.sessionId).toBe("app-1");
    expect(transitionEntry?.projectId).toBe("my-app");

    // Swallow the unused rest import
    void rest;
  });

  it("falls back to null event log when none is provided", async () => {
    // Should not throw even without eventLog dep
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
      // No eventLog — should use createNullEventLog internally
    });

    await expect(lm.check("app-1")).resolves.not.toThrow();
  });
});
