import { describe, it, expect, vi, beforeEach } from "vitest";
import { reapStaleSessions } from "../session-reaper.js";
import type { ReaperConfig, ReaperDeps } from "../session-reaper.js";
import type { Session, SessionManager, SessionId } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_NOW = new Date("2025-01-01T12:00:00Z");
const TWO_HOURS_MS = 7_200_000;
const FOUR_HOURS_MS = 14_400_000;

function makeSession(id: SessionId, overrides?: Partial<Session>): Session {
  return {
    id,
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: `branch-${id}`,
    issueId: null,
    pr: null,
    workspacePath: `/tmp/${id}`,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
    lastActivityAt: new Date(BASE_NOW.getTime() - TWO_HOURS_MS - 1000),
    metadata: {},
    ...overrides,
  };
}

function makeSessionManager(sessions: Session[]): SessionManager {
  const sm: SessionManager = {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn().mockResolvedValue(sessions),
    get: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  };
  return sm;
}

function makeConfig(overrides?: Partial<ReaperConfig>): ReaperConfig {
  return {
    orphanedThresholdMs: TWO_HOURS_MS,
    noPrThresholdMs: FOUR_HOURS_MS,
    maxKillsPerRun: 5,
    ...overrides,
  };
}

function makeDeps(sm: SessionManager): ReaperDeps {
  return {
    sessionManager: sm,
    now: BASE_NOW,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reapStaleSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. empty session list → empty result", async () => {
    const sm = makeSessionManager([]);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.dryRun).toBe(false);
  });

  it("2. all sessions in terminal state → all skipped", async () => {
    const sessions = [
      makeSession("s1", { status: "killed" }),
      makeSession("s2", { status: "done" }),
      makeSession("s3", { status: "merged" }),
      makeSession("s4", { status: "terminated" }),
      makeSession("s5", { status: "errored" }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(5);
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it("3. session with no PR past noPrThreshold → killed", async () => {
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s1");
    expect(result.killed[0].reason).toContain("no PR");
    expect(sm.kill).toHaveBeenCalledWith("s1");
  });

  it("4. session with no PR under noPrThreshold → skipped", async () => {
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS + 60_000), // under threshold
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it("5. orphaned session (exited activity) past orphanedThreshold → killed", async () => {
    const sessions = [
      makeSession("s1", {
        status: "working",
        activity: "exited",
        pr: { number: 1, url: "https://github.com/test/repo/pull/1", title: "PR", owner: "test", repo: "repo", branch: "branch-s1", baseBranch: "main", isDraft: false },
        createdAt: new Date(BASE_NOW.getTime() - TWO_HOURS_MS - 1000),
        lastActivityAt: new Date(BASE_NOW.getTime() - TWO_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s1");
    expect(result.killed[0].reason).toContain("orphaned");
    expect(sm.kill).toHaveBeenCalledWith("s1");
  });

  it("6. idle session past orphanedThreshold → killed", async () => {
    const sessions = [
      makeSession("s1", {
        status: "idle",
        activity: "idle",
        pr: { number: 1, url: "https://github.com/test/repo/pull/1", title: "PR", owner: "test", repo: "repo", branch: "branch-s1", baseBranch: "main", isDraft: false },
        lastActivityAt: new Date(BASE_NOW.getTime() - TWO_HOURS_MS - 1000),
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s1");
    expect(result.killed[0].reason).toContain("stale idle");
  });

  it("7. active session → skipped", async () => {
    const sessions = [
      makeSession("s1", {
        status: "working",
        activity: "active",
        pr: { number: 1, url: "https://github.com/test/repo/pull/1", title: "PR", owner: "test", repo: "repo", branch: "branch-s1", baseBranch: "main", isDraft: false },
        lastActivityAt: new Date(BASE_NOW.getTime() - 60_000), // 1 min ago
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it("8. session with PR → not killed for no-PR reason", async () => {
    const sessions = [
      makeSession("s1", {
        status: "working",
        activity: "active",
        pr: { number: 1, url: "https://github.com/test/repo/pull/1", title: "PR", owner: "test", repo: "repo", branch: "branch-s1", baseBranch: "main", isDraft: false },
        lastActivityAt: new Date(BASE_NOW.getTime() - 60_000),
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    const noPrKill = result.killed.find(k => k.reason.includes("no PR"));
    expect(noPrKill).toBeUndefined();
  });

  it("9. maxKillsPerRun cap respected (6 candidates, max 5 → only 5 killed)", async () => {
    // 6 sessions all past noPrThreshold with no PR
    const sessions = Array.from({ length: 6 }, (_, i) =>
      makeSession(`s${i + 1}`, {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    );
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig({ maxKillsPerRun: 5 }), makeDeps(sm));

    expect(result.killed).toHaveLength(5);
    expect(sm.kill).toHaveBeenCalledTimes(5);
    // The 6th session should be in skipped with a cap reason
    expect(result.skipped.some(s => s.reason.includes("cap"))).toBe(true);
  });

  it("10. dryRun mode → no kills, sessions listed as would-kill", async () => {
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    const result = await reapStaleSessions(makeConfig({ dryRun: true }), makeDeps(sm));

    expect(result.dryRun).toBe(true);
    expect(result.killed).toHaveLength(1);
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it("11. failed kills count toward cap (maxKillsPerRun=1, first fails → second skipped)", async () => {
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
      makeSession("s2", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    (sm.kill as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("kill failed"));

    const result = await reapStaleSessions(makeConfig({ maxKillsPerRun: 1 }), makeDeps(sm));

    expect(result.errors).toHaveLength(1);
    expect(result.killed).toHaveLength(0);
    expect(result.skipped.some(s => s.reason.includes("cap"))).toBe(true);
    expect(sm.kill).toHaveBeenCalledTimes(1);
  });

  it("12. kill failure → captured in errors, continues to next", async () => {
    const sessions = [
      makeSession("s1", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
      makeSession("s2", {
        pr: null,
        status: "working",
        activity: "active",
        createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
      }),
    ];
    const sm = makeSessionManager(sessions);
    (sm.kill as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("kill failed"))
      .mockResolvedValueOnce(undefined);

    const result = await reapStaleSessions(makeConfig(), makeDeps(sm));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].sessionId).toBe("s1");
    expect(result.errors[0].error).toContain("kill failed");
    // s2 should still be killed
    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].sessionId).toBe("s2");
  });
});
