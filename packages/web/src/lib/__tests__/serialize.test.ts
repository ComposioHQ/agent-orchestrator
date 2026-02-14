/**
 * Tests for session serialization and PR enrichment
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Session, PRInfo, SCM } from "@agent-orchestrator/core";
import { sessionToDashboard, enrichSessionPR } from "../serialize";
import { prCache, prCacheKey } from "../cache";
import type { DashboardSession } from "../types";

// Helper to create a minimal Session for testing
function createCoreSession(overrides?: Partial<Session>): Session {
  return {
    id: "test-1",
    projectId: "test",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/test",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    lastActivityAt: new Date("2025-01-01T01:00:00Z"),
    metadata: {},
    ...overrides,
  };
}

// Helper to create a minimal PRInfo for testing
function createPRInfo(overrides?: Partial<PRInfo>): PRInfo {
  return {
    number: 1,
    url: "https://github.com/test/repo/pull/1",
    title: "Test PR",
    owner: "test",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

// Mock SCM that succeeds
function createMockSCM(): SCM {
  return {
    name: "mock",
    detectPR: vi.fn(),
    getPRState: vi.fn().mockResolvedValue("open"),
    getPRSummary: vi.fn().mockResolvedValue({
      state: "open",
      title: "Test PR",
      additions: 100,
      deletions: 50,
    }),
    getCIChecks: vi.fn().mockResolvedValue([
      { name: "test", status: "passed", url: "https://example.com" },
    ]),
    getCISummary: vi.fn().mockResolvedValue("passing"),
    getReviewDecision: vi.fn().mockResolvedValue("approved"),
    getMergeability: vi.fn().mockResolvedValue({
      mergeable: true,
      ciPassing: true,
      approved: true,
      noConflicts: true,
      blockers: [],
    }),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getReviews: vi.fn(),
    getAutomatedComments: vi.fn(),
    mergePR: vi.fn(),
    closePR: vi.fn(),
  };
}

// Mock SCM that fails all requests
function createFailingSCM(): SCM {
  const error = new Error("API rate limited");
  return {
    name: "mock-failing",
    detectPR: vi.fn(),
    getPRState: vi.fn().mockRejectedValue(error),
    getPRSummary: vi.fn().mockRejectedValue(error),
    getCIChecks: vi.fn().mockRejectedValue(error),
    getCISummary: vi.fn().mockRejectedValue(error),
    getReviewDecision: vi.fn().mockRejectedValue(error),
    getMergeability: vi.fn().mockRejectedValue(error),
    getPendingComments: vi.fn().mockRejectedValue(error),
    getReviews: vi.fn(),
    getAutomatedComments: vi.fn(),
    mergePR: vi.fn(),
    closePR: vi.fn(),
  };
}

describe("sessionToDashboard", () => {
  it("should convert a core Session to DashboardSession", () => {
    const coreSession = createCoreSession();
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.id).toBe("test-1");
    expect(dashboard.projectId).toBe("test");
    expect(dashboard.status).toBe("working");
    expect(dashboard.activity).toBe("active");
    expect(dashboard.branch).toBe("feat/test");
    expect(dashboard.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(dashboard.lastActivityAt).toBe("2025-01-01T01:00:00.000Z");
  });

  it("should use agentInfo summary if available", () => {
    const coreSession = createCoreSession({
      agentInfo: {
        summary: "Working on feature X",
        agentSessionId: "abc123",
      },
    });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.summary).toBe("Working on feature X");
  });

  it("should fall back to metadata summary if agentInfo is null", () => {
    const coreSession = createCoreSession({
      agentInfo: null,
      metadata: { summary: "Metadata summary" },
    });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.summary).toBe("Metadata summary");
  });

  it("should convert PRInfo to DashboardPR with defaults", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.pr).not.toBeNull();
    expect(dashboard.pr?.number).toBe(1);
    expect(dashboard.pr?.url).toBe("https://github.com/test/repo/pull/1");
    expect(dashboard.pr?.title).toBe("Test PR");
    expect(dashboard.pr?.state).toBe("open");
    expect(dashboard.pr?.additions).toBe(0);
    expect(dashboard.pr?.deletions).toBe(0);
    expect(dashboard.pr?.ciStatus).toBe("none");
    expect(dashboard.pr?.reviewDecision).toBe("none");
    expect(dashboard.pr?.mergeability.blockers).toContain("Data not loaded");
  });

  it("should set pr to null when session has no PR", () => {
    const coreSession = createCoreSession({ pr: null });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.pr).toBeNull();
  });
});

describe("enrichSessionPR", () => {
  beforeEach(() => {
    prCache.clear();
  });

  it("should enrich PR with live SCM data", async () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);
    const scm = createMockSCM();

    await enrichSessionPR(dashboard, scm, pr);

    expect(dashboard.pr?.state).toBe("open");
    expect(dashboard.pr?.additions).toBe(100);
    expect(dashboard.pr?.deletions).toBe(50);
    expect(dashboard.pr?.ciStatus).toBe("passing");
    expect(dashboard.pr?.reviewDecision).toBe("approved");
    expect(dashboard.pr?.mergeability.mergeable).toBe(true);
    expect(dashboard.pr?.ciChecks).toHaveLength(1);
    expect(dashboard.pr?.ciChecks[0]?.name).toBe("test");
  });

  it("should cache successful enrichment results", async () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);
    const scm = createMockSCM();

    await enrichSessionPR(dashboard, scm, pr);

    const cacheKey = prCacheKey(pr.owner, pr.repo, pr.number);
    const cached = prCache.get(cacheKey);
    expect(cached).not.toBeNull();
    expect(cached?.additions).toBe(100);
    expect(cached?.deletions).toBe(50);
  });

  it("should use cached data on subsequent calls", async () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard1 = sessionToDashboard(coreSession);
    const dashboard2 = sessionToDashboard(coreSession);
    const scm = createMockSCM();

    // First call: fetch from SCM
    await enrichSessionPR(dashboard1, scm, pr);
    expect(scm.getPRSummary).toHaveBeenCalledTimes(1);

    // Second call: use cache
    await enrichSessionPR(dashboard2, scm, pr);
    expect(scm.getPRSummary).toHaveBeenCalledTimes(1); // Still 1, not 2
    expect(dashboard2.pr?.additions).toBe(100);
  });

  it("should handle rate limit errors gracefully", async () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);
    const scm = createFailingSCM();

    // Spy on console.error
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await enrichSessionPR(dashboard, scm, pr);

    // Should keep default values but update blocker message
    expect(dashboard.pr?.additions).toBe(0);
    expect(dashboard.pr?.deletions).toBe(0);
    expect(dashboard.pr?.mergeability.blockers).toContain("API rate limited or unavailable");

    // Should log error
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("should not cache failed enrichment attempts", async () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);
    const scm = createFailingSCM();

    await enrichSessionPR(dashboard, scm, pr);

    const cacheKey = prCacheKey(pr.owner, pr.repo, pr.number);
    const cached = prCache.get(cacheKey);
    expect(cached).toBeNull();
  });

  it("should handle partial failures gracefully", async () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);

    // Mock SCM with partial failures
    const scm: SCM = {
      ...createMockSCM(),
      getCISummary: vi.fn().mockRejectedValue(new Error("CI API failed")),
      getMergeability: vi.fn().mockRejectedValue(new Error("Merge API failed")),
    };

    await enrichSessionPR(dashboard, scm, pr);

    // Successful fields should be populated
    expect(dashboard.pr?.additions).toBe(100);
    expect(dashboard.pr?.deletions).toBe(50);
    expect(dashboard.pr?.reviewDecision).toBe("approved");

    // Failed fields should have graceful defaults
    expect(dashboard.pr?.mergeability.blockers).toContain("Merge status unavailable");

    // Should still cache partial results
    const cacheKey = prCacheKey(pr.owner, pr.repo, pr.number);
    const cached = prCache.get(cacheKey);
    expect(cached).not.toBeNull();
  });

  it("should do nothing if dashboard.pr is null", async () => {
    const dashboard: DashboardSession = {
      id: "test-1",
      projectId: "test",
      status: "working",
      activity: "active",
      branch: "feat/test",
      issueId: null,
      issueUrl: null,
      issueLabel: null,
      summary: null,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      pr: null,
      metadata: {},
    };
    const pr = createPRInfo();
    const scm = createMockSCM();

    await enrichSessionPR(dashboard, scm, pr);

    expect(scm.getPRSummary).not.toHaveBeenCalled();
  });

  it("should handle missing optional SCM methods", async () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);

    // SCM without getPRSummary
    const scm: SCM = {
      ...createMockSCM(),
      getPRSummary: undefined,
    };

    await enrichSessionPR(dashboard, scm, pr);

    // Should fall back to getPRState
    expect(scm.getPRState).toHaveBeenCalled();
    expect(dashboard.pr?.state).toBe("open");
  });
});

describe("basicPRToDashboard defaults", () => {
  it("should not look like failing CI", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);

    // ciStatus "none" is neutral (no checks configured), not failing
    expect(dashboard.pr?.ciStatus).toBe("none");
    expect(dashboard.pr?.ciStatus).not.toBe("failing");
  });

  it("should not look like changes requested", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);

    // reviewDecision "none" is neutral (no review required), not changes_requested
    expect(dashboard.pr?.reviewDecision).toBe("none");
    expect(dashboard.pr?.reviewDecision).not.toBe("changes_requested");
  });

  it("should have explicit blocker indicating data not loaded", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.pr?.mergeability.blockers).toContain("Data not loaded");
  });
});
