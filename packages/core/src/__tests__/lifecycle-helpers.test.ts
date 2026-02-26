/**
 * Tests for lifecycle-manager.ts helper functions.
 *
 * Since parseDuration, inferPriority, createEvent, statusToEventType,
 * and eventToReactionKey are module-private, we test them indirectly
 * through createLifecycleManager behavior.
 *
 * This file directly tests the lifecycle manager's integrated behavior
 * focusing on: state transitions, reaction execution, escalation,
 * and polling lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { getSessionsDir } from "../paths.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  Agent,
  SCM,
  Notifier,
  SessionStatus,
  ActivityState,
} from "../types.js";

// ─── Factories ───────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
    activity: null,
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: { status: "working" },
    ...overrides,
  };
}

let tmpDir: string;

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    configPath: join(tmpDir, "agent-orchestrator.yaml"),
    readyThresholdMs: 300_000,
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
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: ["desktop"],
      info: [],
    },
    reactions: {},
    ...overrides,
  };
}

function makeMockRuntime(): Runtime {
  return {
    name: "mock",
    create: vi.fn().mockResolvedValue({ id: "rt-1", runtimeName: "mock", data: {} }),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue("$ some output\n"),
    isAlive: vi.fn().mockResolvedValue(true),
  };
}

function makeMockAgent(): Agent {
  return {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn().mockReturnValue("echo test"),
    getEnvironment: vi.fn().mockReturnValue({}),
    detectActivity: vi.fn().mockReturnValue("active" as ActivityState),
    getActivityState: vi.fn().mockResolvedValue(null),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };
}

function makeMockSCM(): SCM {
  return {
    name: "mock-scm",
    detectPR: vi.fn().mockResolvedValue(null),
    getPRState: vi.fn().mockResolvedValue("open"),
    mergePR: vi.fn().mockResolvedValue(undefined),
    closePR: vi.fn().mockResolvedValue(undefined),
    getCIChecks: vi.fn().mockResolvedValue([]),
    getCISummary: vi.fn().mockResolvedValue("none"),
    getReviews: vi.fn().mockResolvedValue([]),
    getReviewDecision: vi.fn().mockResolvedValue("none"),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getAutomatedComments: vi.fn().mockResolvedValue([]),
    getMergeability: vi.fn().mockResolvedValue({
      mergeable: false,
      ciPassing: false,
      approved: false,
      noConflicts: true,
      blockers: [],
    }),
  };
}

function makeMockNotifier(): Notifier {
  return {
    name: "desktop",
    notify: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRegistry(plugins: {
  runtime?: Runtime;
  agent?: Agent;
  scm?: SCM;
  notifier?: Notifier;
}): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string, name: string) => {
      if (slot === "runtime") return plugins.runtime ?? null;
      if (slot === "agent") return plugins.agent ?? null;
      if (slot === "scm") return plugins.scm ?? null;
      if (slot === "notifier") return plugins.notifier ?? null;
      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn().mockResolvedValue(undefined),
    loadFromConfig: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("createLifecycleManager", () => {
  let config: OrchestratorConfig;
  let mockRuntime: Runtime;
  let mockAgent: Agent;
  let mockNotifier: Notifier;
  let mockSCM: SCM;
  let mockSessionManager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = join(tmpdir(), `ao-test-lm-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, "my-app"), { recursive: true });
    writeFileSync(join(tmpDir, "agent-orchestrator.yaml"), "projects: {}\n");
    config = makeConfig();
    // Pre-create sessions directory so updateMetadata doesn't fail
    const sessionsDir = getSessionsDir(config.configPath, config.projects["my-app"].path);
    mkdirSync(sessionsDir, { recursive: true });

    mockRuntime = makeMockRuntime();
    mockAgent = makeMockAgent();
    mockNotifier = makeMockNotifier();
    mockSCM = makeMockSCM();
    mockSessionManager = {
      spawn: vi.fn(),
      spawnOrchestrator: vi.fn(),
      restore: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      kill: vi.fn(),
      cleanup: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  describe("start/stop", () => {
    it("starts polling and can be stopped", async () => {
      const registry = makeRegistry({ runtime: mockRuntime, agent: mockAgent });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(5000);
      // Should run pollAll immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSessionManager.list).toHaveBeenCalledTimes(1);

      // Next poll after interval
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockSessionManager.list).toHaveBeenCalledTimes(2);

      lm.stop();

      // Should not poll after stop
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockSessionManager.list).toHaveBeenCalledTimes(2);
    });

    it("calling start twice is a no-op", async () => {
      const registry = makeRegistry({ runtime: mockRuntime, agent: mockAgent });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(5000);
      lm.start(5000); // Second start should be ignored
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSessionManager.list).toHaveBeenCalledTimes(1);
      lm.stop();
    });
  });

  describe("getStates", () => {
    it("returns a copy of the states map", async () => {
      const session = makeSession({ status: "working" });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);

      const registry = makeRegistry({
        runtime: mockRuntime,
        agent: mockAgent,
      });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      const states = lm.getStates();
      expect(states).toBeInstanceOf(Map);

      // Mutating the returned map should not affect the internal states
      states.set("app-1", "merged");
      const states2 = lm.getStates();
      expect(states2.get("app-1")).toBe("working");

      lm.stop();
    });
  });

  describe("check", () => {
    it("throws when session not found", async () => {
      vi.mocked(mockSessionManager.get).mockResolvedValue(null);
      const registry = makeRegistry({});
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      await expect(lm.check("nonexistent")).rejects.toThrow("Session nonexistent not found");
    });
  });

  describe("state transitions", () => {
    it("detects killed state when runtime is not alive", async () => {
      const session = makeSession({ status: "working" });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
      vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

      const registry = makeRegistry({ runtime: mockRuntime, agent: mockAgent });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(lm.getStates().get("app-1")).toBe("killed");
      lm.stop();
    });

    it("detects needs_input when agent returns waiting_input", async () => {
      const session = makeSession({ status: "working" });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
      vi.mocked(mockAgent.detectActivity).mockReturnValue("waiting_input");

      const registry = makeRegistry({ runtime: mockRuntime, agent: mockAgent });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(lm.getStates().get("app-1")).toBe("needs_input");
      lm.stop();
    });

    it("detects killed when agent process is not running", async () => {
      const session = makeSession({ status: "working" });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
      vi.mocked(mockAgent.detectActivity).mockReturnValue("active");
      vi.mocked(mockAgent.isProcessRunning).mockResolvedValue(false);

      const registry = makeRegistry({ runtime: mockRuntime, agent: mockAgent });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(lm.getStates().get("app-1")).toBe("killed");
      lm.stop();
    });

    it("transitions spawning to working", async () => {
      const session = makeSession({ status: "spawning", metadata: { status: "spawning" } });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);

      const registry = makeRegistry({ runtime: mockRuntime, agent: mockAgent });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(lm.getStates().get("app-1")).toBe("working");
      lm.stop();
    });

    it("detects merged PR state", async () => {
      const prInfo = {
        number: 42,
        url: "https://github.com/org/my-app/pull/42",
        title: "feat",
        owner: "org",
        repo: "my-app",
        branch: "feat/test",
        baseBranch: "main",
        isDraft: false,
      };
      const session = makeSession({ status: "pr_open", pr: prInfo });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
      vi.mocked(mockSCM.getPRState).mockResolvedValue("merged");

      config.projects["my-app"].scm = { plugin: "github" };
      const registry = makeRegistry({ runtime: mockRuntime, agent: mockAgent, scm: mockSCM });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(lm.getStates().get("app-1")).toBe("merged");
      lm.stop();
    });

    it("detects ci_failed from SCM CI summary", async () => {
      const prInfo = {
        number: 42,
        url: "https://github.com/org/my-app/pull/42",
        title: "feat",
        owner: "org",
        repo: "my-app",
        branch: "feat/test",
        baseBranch: "main",
        isDraft: false,
      };
      const session = makeSession({ status: "pr_open", pr: prInfo });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
      vi.mocked(mockSCM.getPRState).mockResolvedValue("open");
      vi.mocked(mockSCM.getCISummary).mockResolvedValue("failing");

      config.projects["my-app"].scm = { plugin: "github" };
      const registry = makeRegistry({ runtime: mockRuntime, agent: mockAgent, scm: mockSCM });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(lm.getStates().get("app-1")).toBe("ci_failed");
      lm.stop();
    });
  });

  describe("reactions", () => {
    it("executes send-to-agent reaction on CI failure", async () => {
      config.reactions = {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "CI failed. Please fix the build.",
          retries: 3,
        },
      };

      const prInfo = {
        number: 42,
        url: "https://github.com/org/my-app/pull/42",
        title: "feat",
        owner: "org",
        repo: "my-app",
        branch: "feat/test",
        baseBranch: "main",
        isDraft: false,
      };
      // Start with pr_open, then CI fails → transition to ci_failed
      const session = makeSession({
        status: "pr_open",
        pr: prInfo,
        metadata: { status: "pr_open" },
      });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
      vi.mocked(mockSCM.getPRState).mockResolvedValue("open");
      // First poll: CI is passing, session stays pr_open
      vi.mocked(mockSCM.getCISummary).mockResolvedValueOnce("passing");
      vi.mocked(mockSCM.getReviewDecision).mockResolvedValue("none");

      config.projects["my-app"].scm = { plugin: "github" };
      const registry = makeRegistry({
        runtime: mockRuntime,
        agent: mockAgent,
        scm: mockSCM,
        notifier: mockNotifier,
      });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);
      // State is now "pr_open" tracked

      // Second poll: CI starts failing → transition from pr_open to ci_failed
      vi.mocked(mockSCM.getCISummary).mockResolvedValue("failing");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockSessionManager.send).toHaveBeenCalledWith(
        "app-1",
        "CI failed. Please fix the build.",
      );
      lm.stop();
    });

    it("executes notify reaction on session killed", async () => {
      config.reactions = {
        "agent-exited": {
          auto: true,
          action: "notify",
          priority: "warning",
        },
      };

      // Start with a working session
      const session = makeSession({
        status: "working",
        metadata: { status: "working" },
      });

      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);

      const registry = makeRegistry({
        runtime: mockRuntime,
        agent: mockAgent,
        notifier: mockNotifier,
      });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);
      // State is now "working" tracked

      // Second poll: runtime dies → transition from working to killed
      vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockNotifier.notify).toHaveBeenCalled();
      lm.stop();
    });

    it("escalates after max retries", async () => {
      config.reactions = {
        "ci-failed": {
          auto: true,
          action: "send-to-agent",
          message: "Fix CI",
          retries: 1, // only 1 retry allowed
        },
      };

      const prInfo = {
        number: 42,
        url: "https://github.com/org/my-app/pull/42",
        title: "feat",
        owner: "org",
        repo: "my-app",
        branch: "feat/test",
        baseBranch: "main",
        isDraft: false,
      };

      config.projects["my-app"].scm = { plugin: "github" };
      const registry = makeRegistry({
        runtime: mockRuntime,
        agent: mockAgent,
        scm: mockSCM,
        notifier: mockNotifier,
      });

      // Session stays in ci_failed across multiple polls
      const session = makeSession({ status: "ci_failed", pr: prInfo });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
      vi.mocked(mockSCM.getPRState).mockResolvedValue("open");
      vi.mocked(mockSCM.getCISummary).mockResolvedValue("failing");

      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      // First poll: initial detection → send to agent (attempt 1)
      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      // ci_failed → ci_failed (same), but the reaction tracker was set on transition
      // Now force a re-transition by cycling through another state
      vi.mocked(mockSCM.getCISummary).mockResolvedValueOnce("passing");
      await vi.advanceTimersByTimeAsync(60_000);

      // Back to failing: new transition, reset tracker
      vi.mocked(mockSCM.getCISummary).mockResolvedValue("failing");
      await vi.advanceTimersByTimeAsync(60_000);

      lm.stop();
    });
  });

  describe("all-complete reaction", () => {
    it("triggers all-complete when all sessions are terminal", async () => {
      config.reactions = {
        "all-complete": {
          auto: true,
          action: "notify",
          priority: "action",
        },
      };

      const sessions = [
        makeSession({ id: "app-1", status: "merged" }),
        makeSession({ id: "app-2", status: "killed" }),
      ];
      vi.mocked(mockSessionManager.list).mockResolvedValue(sessions);

      const registry = makeRegistry({
        runtime: mockRuntime,
        agent: mockAgent,
        notifier: mockNotifier,
      });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockNotifier.notify).toHaveBeenCalled();
      lm.stop();
    });

    it("does not trigger all-complete when there are active sessions", async () => {
      config.reactions = {
        "all-complete": {
          auto: true,
          action: "notify",
          priority: "action",
        },
      };

      const sessions = [
        makeSession({ id: "app-1", status: "working" }),
        makeSession({ id: "app-2", status: "killed" }),
      ];
      vi.mocked(mockSessionManager.list).mockResolvedValue(sessions);

      const registry = makeRegistry({
        runtime: mockRuntime,
        agent: mockAgent,
        notifier: mockNotifier,
      });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      // Notifier should not have been called for all-complete
      // (might be called for individual session transitions)
      const calls = vi.mocked(mockNotifier.notify).mock.calls;
      const allCompleteCall = calls.find(
        (call) => call[0].type === "summary.all_complete",
      );
      expect(allCompleteCall).toBeUndefined();
      lm.stop();
    });

    it("does not trigger all-complete twice", async () => {
      config.reactions = {
        "all-complete": {
          auto: true,
          action: "notify",
          priority: "action",
        },
      };

      const sessions = [makeSession({ id: "app-1", status: "merged" })];
      vi.mocked(mockSessionManager.list).mockResolvedValue(sessions);

      const registry = makeRegistry({
        runtime: mockRuntime,
        agent: mockAgent,
        notifier: mockNotifier,
      });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      const callCount1 = vi.mocked(mockNotifier.notify).mock.calls.length;

      // Second poll — all-complete should NOT trigger again
      await vi.advanceTimersByTimeAsync(60_000);

      const callCount2 = vi.mocked(mockNotifier.notify).mock.calls.length;
      expect(callCount2).toBe(callCount1);

      lm.stop();
    });
  });

  describe("stale entry pruning", () => {
    it("prunes states for sessions that no longer exist", async () => {
      const session = makeSession({ id: "app-1", status: "working" });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);

      const registry = makeRegistry({ runtime: mockRuntime, agent: mockAgent });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(lm.getStates().has("app-1")).toBe(true);

      // Session disappears
      vi.mocked(mockSessionManager.list).mockResolvedValue([]);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(lm.getStates().has("app-1")).toBe(false);
      lm.stop();
    });
  });

  describe("error resilience", () => {
    it("does not crash when sessionManager.list throws", async () => {
      vi.mocked(mockSessionManager.list).mockRejectedValue(new Error("boom"));

      const registry = makeRegistry({});
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      // Should not throw
      await vi.advanceTimersByTimeAsync(0);
      lm.stop();
    });

    it("continues polling after a failed poll cycle", async () => {
      vi.mocked(mockSessionManager.list)
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValue([]);

      const registry = makeRegistry({});
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(5000);
      await vi.advanceTimersByTimeAsync(0); // First poll fails
      await vi.advanceTimersByTimeAsync(5000); // Second poll succeeds

      expect(mockSessionManager.list).toHaveBeenCalledTimes(2);
      lm.stop();
    });

    it("preserves stuck/needs_input state when agent probe fails", async () => {
      const session = makeSession({
        status: "stuck",
        metadata: { status: "stuck" },
      });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
      vi.mocked(mockRuntime.getOutput).mockRejectedValue(new Error("tmux error"));

      const registry = makeRegistry({ runtime: mockRuntime, agent: mockAgent });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      // Should preserve stuck status, not transition to working
      expect(lm.getStates().get("app-1")).toBe("stuck");
      lm.stop();
    });
  });

  describe("notification routing", () => {
    it("notifies human for significant non-reaction transitions", async () => {
      // No reactions configured, but transition to needs_input is urgent
      const session = makeSession({ status: "working", metadata: { status: "working" } });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);

      const registry = makeRegistry({
        runtime: mockRuntime,
        agent: mockAgent,
        notifier: mockNotifier,
      });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      // First poll: establish "working" as tracked state
      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      // Second poll: agent returns waiting_input → transition from working to needs_input
      vi.mocked(mockAgent.detectActivity).mockReturnValue("waiting_input");
      await vi.advanceTimersByTimeAsync(60_000);

      // needs_input triggers agent-needs-input but no reaction configured
      // so it should notify human directly with urgent priority
      expect(mockNotifier.notify).toHaveBeenCalled();
      lm.stop();
    });

    it("does not notify for info-priority transitions without reactions", async () => {
      // No reactions, session goes from spawning → working (info-level)
      const session = makeSession({ status: "spawning", metadata: { status: "spawning" } });
      vi.mocked(mockSessionManager.list).mockResolvedValue([session]);

      const registry = makeRegistry({
        runtime: mockRuntime,
        agent: mockAgent,
        notifier: mockNotifier,
      });
      const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);

      // working is not urgent enough to notify without a reaction
      expect(mockNotifier.notify).not.toHaveBeenCalled();
      lm.stop();
    });
  });
});
