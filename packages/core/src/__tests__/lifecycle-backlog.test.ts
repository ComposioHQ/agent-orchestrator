import { describe, it, expect, vi } from "vitest";
import {
  createBacklogDispatchers,
  formatCIFailureMessage,
} from "../lifecycle-backlog.js";
import { createReactionEngine } from "../reaction-engine.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  OpenCodeSessionManager,
  ReactionConfig,
  Session,
  SCM,
  CICheck,
  ReviewComment,
  OrchestratorEvent,
  EventPriority,
} from "../types.js";
import type { PREnrichmentCache } from "../pr-enrichment-cache.js";
import {
  createMockSCM,
  createMockSessionManager,
  makePR,
  makeSession,
} from "./test-utils.js";

function makeOpenPRSession(overrides: Partial<Session> = {}): Session {
  const session = makeSession({ pr: makePR(), ...overrides });
  session.lifecycle.pr.state = "open";
  session.lifecycle.pr.reason = "in_progress";
  session.lifecycle.pr.number = session.pr!.number;
  session.lifecycle.pr.url = session.pr!.url;
  return session;
}

function makeConfig(reactions: Record<string, ReactionConfig> = {}): OrchestratorConfig {
  return {
    configPath: "/tmp/ao.yaml",
    port: 3000,
    power: { preventIdleSleep: false },
    defaults: { runtime: "mock", agent: "mock-agent", workspace: "mock-ws", notifiers: [] },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/tmp/my-app",
        storageKey: "111111111111",
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions,
    readyThresholdMs: 300_000,
  };
}

function makeRegistry(scm: SCM): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => (slot === "scm" ? scm : null)),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };
}

function makeCache(
  overrides: Partial<PREnrichmentCache> = {},
): PREnrichmentCache {
  return {
    get: vi.fn().mockReturnValue(undefined),
    populate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function reviewComment(id: string): ReviewComment {
  return {
    id,
    author: "reviewer",
    body: "please fix",
    isResolved: false,
    createdAt: new Date(),
    url: `https://example.com/${id}`,
  };
}

interface Harness {
  dispatchers: ReturnType<typeof createBacklogDispatchers>;
  updates: Array<{ session: Session; updates: Record<string, string> }>;
  notified: Array<{ event: OrchestratorEvent; priority: EventPriority }>;
  sessionManager: OpenCodeSessionManager;
}

function makeHarness(opts: {
  scm: SCM;
  reactions?: Record<string, ReactionConfig>;
  cache?: PREnrichmentCache;
}): Harness {
  const config = makeConfig(opts.reactions);
  const registry = makeRegistry(opts.scm);
  const sessionManager = createMockSessionManager();
  const updates: Harness["updates"] = [];
  const notified: Harness["notified"] = [];
  const notifyHuman = async (event: OrchestratorEvent, priority: EventPriority) => {
    notified.push({ event, priority });
  };
  const reactionEngine = createReactionEngine({
    config,
    sessionManager,
    notifyHuman,
  });
  const dispatchers = createBacklogDispatchers({
    config,
    registry,
    sessionManager,
    reactionEngine,
    prEnrichmentCache: opts.cache ?? makeCache(),
    updateSessionMetadata: (session, u) => {
      updates.push({ session, updates: u as Record<string, string> });
      // Emulate persistence so throttle/fingerprint checks see latest values
      Object.assign(session.metadata, u);
    },
    notifyHuman,
  });
  return { dispatchers, updates, notified, sessionManager };
}

describe("formatCIFailureMessage", () => {
  it("renders each failed check as a bullet with status and link", () => {
    const checks: CICheck[] = [
      { name: "unit", status: "failed", conclusion: "FAILURE", url: "https://ci/1" },
      { name: "lint", status: "failed" },
    ];
    const msg = formatCIFailureMessage(checks);
    expect(msg).toContain("- **unit**: FAILURE — https://ci/1");
    expect(msg).toContain("- **lint**: failed");
    expect(msg.startsWith("CI checks are failing")).toBe(true);
  });
});

describe("maybeDispatchReviewBacklog", () => {
  it("dispatches review comments via send-to-agent when fingerprint changes", async () => {
    const scm = createMockSCM({
      getPendingComments: vi.fn().mockResolvedValue([reviewComment("c-1")]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
    });
    const { dispatchers, sessionManager, updates } = makeHarness({
      scm,
      reactions: {
        "changes-requested": {
          auto: true,
          action: "send-to-agent",
          message: "Address review comments",
        },
      },
    });
    const session = makeOpenPRSession({ status: "changes_requested" });

    // Subsequent poll after the initial transition — backlog dispatch fires
    // when comments arrive while already in changes_requested.
    await dispatchers.maybeDispatchReviewBacklog(
      session,
      "changes_requested",
      "changes_requested",
    );

    expect(sessionManager.send).toHaveBeenCalledWith(session.id, "Address review comments");
    const flat = Object.assign({}, ...updates.map((u) => u.updates));
    expect(flat.lastPendingReviewDispatchHash).toBeTruthy();
  });

  it("does not dispatch a second time when fingerprint is unchanged", async () => {
    const scm = createMockSCM({
      getPendingComments: vi.fn().mockResolvedValue([reviewComment("c-1")]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
    });
    const { dispatchers, sessionManager } = makeHarness({
      scm,
      reactions: {
        "changes-requested": {
          auto: true,
          action: "send-to-agent",
          message: "m",
        },
      },
    });
    const session = makeOpenPRSession({ status: "changes_requested" });

    await dispatchers.maybeDispatchReviewBacklog(
      session,
      "changes_requested",
      "changes_requested",
    );
    expect(sessionManager.send).toHaveBeenCalledTimes(1);

    // Second poll: same comments -> throttle + matching fingerprint skip
    (scm.getPendingComments as ReturnType<typeof vi.fn>).mockClear();
    await dispatchers.maybeDispatchReviewBacklog(
      session,
      "changes_requested",
      "changes_requested",
    );
    expect(sessionManager.send).toHaveBeenCalledTimes(1);
  });

  it("clears trackers and metadata when PR is no longer open", async () => {
    const scm = createMockSCM();
    const { dispatchers, updates } = makeHarness({ scm });
    const session = makeSession({
      pr: makePR(),
      status: "merged",
      metadata: {
        lastPendingReviewFingerprint: "abc",
        lastPendingReviewDispatchHash: "abc",
      },
    });

    await dispatchers.maybeDispatchReviewBacklog(session, "approved", "merged");

    expect(scm.getPendingComments).not.toHaveBeenCalled();
    const flat = Object.assign({}, ...updates.map((u) => u.updates));
    expect(flat.lastPendingReviewFingerprint).toBe("");
    expect(flat.lastPendingReviewDispatchHash).toBe("");
  });
});

describe("maybeDispatchCIFailureDetails", () => {
  it("uses cached CI checks from the enrichment cache when available", async () => {
    const checks: CICheck[] = [{ name: "unit", status: "failed", url: "https://ci/1" }];
    const cache = makeCache({
      get: vi.fn().mockReturnValue({
        state: "open",
        ciStatus: "failing",
        reviewDecision: "none",
        mergeable: false,
        ciChecks: checks,
      }),
    });
    const scm = createMockSCM();
    const { dispatchers, sessionManager } = makeHarness({
      scm,
      cache,
      reactions: {
        "ci-failed": { auto: true, action: "send-to-agent", message: "ignored" },
      },
    });
    const session = makeOpenPRSession({ status: "ci_failed" });

    await dispatchers.maybeDispatchCIFailureDetails(session, "pr_open", "ci_failed");

    expect(scm.getCIChecks).not.toHaveBeenCalled();
    expect(sessionManager.send).toHaveBeenCalledTimes(1);
    const [, message] = (sessionManager.send as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(message).toContain("unit");
  });

  it("falls back to scm.getCIChecks when the cache is empty", async () => {
    const checks: CICheck[] = [{ name: "lint", status: "failed" }];
    const scm = createMockSCM({ getCIChecks: vi.fn().mockResolvedValue(checks) });
    const { dispatchers, sessionManager } = makeHarness({
      scm,
      reactions: {
        "ci-failed": { auto: true, action: "send-to-agent", message: "m" },
      },
    });
    const session = makeOpenPRSession({ status: "ci_failed" });

    await dispatchers.maybeDispatchCIFailureDetails(session, "pr_open", "ci_failed");

    expect(scm.getCIChecks).toHaveBeenCalledTimes(1);
    expect(sessionManager.send).toHaveBeenCalled();
  });

  it("clears CI tracking when status is no longer ci_failed", async () => {
    const scm = createMockSCM();
    const { dispatchers, updates } = makeHarness({ scm });
    const session = makeSession({
      pr: makePR(),
      status: "approved",
      metadata: {
        lastCIFailureFingerprint: "abc",
        lastCIFailureDispatchHash: "abc",
      },
    });

    await dispatchers.maybeDispatchCIFailureDetails(session, "ci_failed", "approved");

    expect(scm.getCIChecks).not.toHaveBeenCalled();
    const flat = Object.assign({}, ...updates.map((u) => u.updates));
    expect(flat.lastCIFailureFingerprint).toBe("");
  });
});

describe("maybeDispatchMergeConflicts", () => {
  it("sends a conflict message once, then dedupes on the next poll", async () => {
    const cache = makeCache({
      get: vi.fn().mockReturnValue({
        state: "open",
        ciStatus: "passing",
        reviewDecision: "none",
        mergeable: false,
        hasConflicts: true,
      }),
    });
    const scm = createMockSCM();
    const { dispatchers, sessionManager } = makeHarness({
      scm,
      cache,
      reactions: {
        "merge-conflicts": { auto: true, action: "send-to-agent", message: "rebase please" },
      },
    });
    const session = makeOpenPRSession({ status: "ci_failed" });

    await dispatchers.maybeDispatchMergeConflicts(session, "ci_failed");
    expect(sessionManager.send).toHaveBeenCalledTimes(1);

    await dispatchers.maybeDispatchMergeConflicts(session, "ci_failed");
    expect(sessionManager.send).toHaveBeenCalledTimes(1);
  });

  it("falls back to scm.getMergeability when cache is empty", async () => {
    const scm = createMockSCM({
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: true,
        noConflicts: false,
        blockers: [],
      }),
    });
    const { dispatchers, sessionManager } = makeHarness({
      scm,
      reactions: {
        "merge-conflicts": { auto: true, action: "send-to-agent", message: "rebase" },
      },
    });
    const session = makeOpenPRSession({ status: "mergeable" });

    await dispatchers.maybeDispatchMergeConflicts(session, "mergeable");

    expect(scm.getMergeability).toHaveBeenCalledTimes(1);
    expect(sessionManager.send).toHaveBeenCalled();
  });

  it("clears the dispatched flag once conflicts resolve", async () => {
    const get = vi
      .fn()
      .mockReturnValueOnce({
        state: "open",
        ciStatus: "passing",
        reviewDecision: "none",
        mergeable: false,
        hasConflicts: true,
      })
      .mockReturnValueOnce({
        state: "open",
        ciStatus: "passing",
        reviewDecision: "none",
        mergeable: true,
        hasConflicts: false,
      });
    const cache = makeCache({ get });
    const { dispatchers, updates } = makeHarness({
      scm: createMockSCM(),
      cache,
      reactions: {
        "merge-conflicts": { auto: true, action: "send-to-agent", message: "m" },
      },
    });
    const session = makeOpenPRSession({ status: "ci_failed" });

    await dispatchers.maybeDispatchMergeConflicts(session, "ci_failed");
    await dispatchers.maybeDispatchMergeConflicts(session, "approved");

    const clearingUpdate = updates.find((u) => u.updates.lastMergeConflictDispatched === "");
    expect(clearingUpdate).toBeDefined();
  });
});
