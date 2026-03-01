import { describe, it, expect, beforeEach } from "vitest";
import { createWorkerPool, type WorkerPool } from "../worker-pool.js";

describe("createWorkerPool", () => {
  let pool: WorkerPool;

  beforeEach(() => {
    pool = createWorkerPool();
  });

  // ===========================================================================
  // Basic spawn/exit tracking
  // ===========================================================================

  describe("basic spawn/exit tracking", () => {
    it("starts with zero active sessions", () => {
      expect(pool.getActiveCount("proj-a")).toBe(0);
      expect(pool.getActiveSessions("proj-a")).toEqual([]);
    });

    it("tracks a spawned session", () => {
      pool.recordSpawn("proj-a", "session-1");
      expect(pool.getActiveCount("proj-a")).toBe(1);
      expect(pool.getActiveSessions("proj-a")).toEqual(["session-1"]);
    });

    it("tracks multiple spawned sessions in the same project", () => {
      pool.recordSpawn("proj-a", "session-1");
      pool.recordSpawn("proj-a", "session-2");
      pool.recordSpawn("proj-a", "session-3");
      expect(pool.getActiveCount("proj-a")).toBe(3);
      expect(pool.getActiveSessions("proj-a")).toContain("session-1");
      expect(pool.getActiveSessions("proj-a")).toContain("session-2");
      expect(pool.getActiveSessions("proj-a")).toContain("session-3");
    });

    it("tracks sessions across different projects independently", () => {
      pool.recordSpawn("proj-a", "a-1");
      pool.recordSpawn("proj-b", "b-1");
      pool.recordSpawn("proj-b", "b-2");
      expect(pool.getActiveCount("proj-a")).toBe(1);
      expect(pool.getActiveCount("proj-b")).toBe(2);
    });

    it("removes a session on exit", () => {
      pool.recordSpawn("proj-a", "session-1");
      pool.recordSpawn("proj-a", "session-2");
      pool.recordExit("proj-a", "session-1");
      expect(pool.getActiveCount("proj-a")).toBe(1);
      expect(pool.getActiveSessions("proj-a")).toEqual(["session-2"]);
    });

    it("cleans up project entry when all sessions exit", () => {
      pool.recordSpawn("proj-a", "session-1");
      pool.recordExit("proj-a", "session-1");
      expect(pool.getActiveCount("proj-a")).toBe(0);
      expect(pool.getActiveSessions("proj-a")).toEqual([]);
    });
  });

  // ===========================================================================
  // Global concurrency limits
  // ===========================================================================

  describe("global concurrency limits", () => {
    it("uses default global max of 10", () => {
      const status = pool.getStatus();
      expect(status.globalMax).toBe(10);
    });

    it("allows spawn when under global limit", () => {
      const check = pool.canSpawn("proj-a");
      expect(check.canSpawn).toBe(true);
      expect(check.limitHit).toBeUndefined();
      expect(check.reason).toBeUndefined();
    });

    it("blocks spawn when global limit reached", () => {
      const smallPool = createWorkerPool({ globalMaxConcurrent: 3 });
      smallPool.recordSpawn("proj-a", "s-1");
      smallPool.recordSpawn("proj-b", "s-2");
      smallPool.recordSpawn("proj-c", "s-3");

      const check = smallPool.canSpawn("proj-d");
      expect(check.canSpawn).toBe(false);
      expect(check.limitHit).toBe("global");
      expect(check.reason).toContain("Global concurrency limit");
      expect(check.reason).toContain("3/3");
      expect(check.slotsRemaining).toBe(0);
    });

    it("allows spawn again after a session exits from global limit", () => {
      const smallPool = createWorkerPool({ globalMaxConcurrent: 2 });
      smallPool.recordSpawn("proj-a", "s-1");
      smallPool.recordSpawn("proj-b", "s-2");

      expect(smallPool.canSpawn("proj-c").canSpawn).toBe(false);

      smallPool.recordExit("proj-a", "s-1");
      const check = smallPool.canSpawn("proj-c");
      expect(check.canSpawn).toBe(true);
    });

    it("respects custom global max", () => {
      const customPool = createWorkerPool({ globalMaxConcurrent: 2 });
      expect(customPool.getStatus().globalMax).toBe(2);
    });
  });

  // ===========================================================================
  // Per-project concurrency limits
  // ===========================================================================

  describe("per-project concurrency limits", () => {
    it("uses default per-project max of 5", () => {
      pool.recordSpawn("proj-a", "s-1");
      const status = pool.getStatus();
      expect(status.projectCounts["proj-a"]?.max).toBe(5);
    });

    it("blocks spawn when project limit reached", () => {
      const smallPool = createWorkerPool({ projectMaxConcurrent: 2, globalMaxConcurrent: 100 });
      smallPool.recordSpawn("proj-a", "s-1");
      smallPool.recordSpawn("proj-a", "s-2");

      const check = smallPool.canSpawn("proj-a");
      expect(check.canSpawn).toBe(false);
      expect(check.limitHit).toBe("project");
      expect(check.reason).toContain("proj-a");
      expect(check.reason).toContain("2/2");
    });

    it("allows other projects when one project is full", () => {
      const smallPool = createWorkerPool({ projectMaxConcurrent: 1, globalMaxConcurrent: 100 });
      smallPool.recordSpawn("proj-a", "s-1");

      expect(smallPool.canSpawn("proj-a").canSpawn).toBe(false);
      expect(smallPool.canSpawn("proj-b").canSpawn).toBe(true);
    });

    it("allows spawn again after a session exits from project limit", () => {
      const smallPool = createWorkerPool({ projectMaxConcurrent: 1 });
      smallPool.recordSpawn("proj-a", "s-1");

      expect(smallPool.canSpawn("proj-a").canSpawn).toBe(false);

      smallPool.recordExit("proj-a", "s-1");
      expect(smallPool.canSpawn("proj-a").canSpawn).toBe(true);
    });
  });

  // ===========================================================================
  // Per-project overrides
  // ===========================================================================

  describe("per-project overrides", () => {
    it("uses override max for specific project", () => {
      const overridePool = createWorkerPool({
        projectMaxConcurrent: 2,
        projectOverrides: {
          "big-project": { maxConcurrent: 8 },
        },
      });

      // big-project gets 8
      for (let i = 0; i < 8; i++) {
        overridePool.recordSpawn("big-project", `s-${i}`);
      }
      const status = overridePool.getStatus();
      expect(status.projectCounts["big-project"]?.max).toBe(8);
      expect(status.projectCounts["big-project"]?.active).toBe(8);
    });

    it("uses default for non-overridden projects", () => {
      const overridePool = createWorkerPool({
        projectMaxConcurrent: 3,
        projectOverrides: {
          "big-project": { maxConcurrent: 8 },
        },
      });

      overridePool.recordSpawn("normal-project", "s-1");
      const status = overridePool.getStatus();
      expect(status.projectCounts["normal-project"]?.max).toBe(3);
    });

    it("blocks spawn at override limit, not default", () => {
      const overridePool = createWorkerPool({
        projectMaxConcurrent: 5,
        globalMaxConcurrent: 100,
        projectOverrides: {
          "small-project": { maxConcurrent: 1 },
        },
      });

      overridePool.recordSpawn("small-project", "s-1");
      const check = overridePool.canSpawn("small-project");
      expect(check.canSpawn).toBe(false);
      expect(check.limitHit).toBe("project");
    });

    it("includes overridden projects with zero sessions in status", () => {
      const overridePool = createWorkerPool({
        projectOverrides: {
          "configured-project": { maxConcurrent: 3 },
        },
      });

      const status = overridePool.getStatus();
      expect(status.projectCounts["configured-project"]).toEqual({
        active: 0,
        max: 3,
      });
    });
  });

  // ===========================================================================
  // SpawnCheck: reasons and slot counts
  // ===========================================================================

  describe("SpawnCheck details", () => {
    it("reports correct slotsRemaining when both limits have room", () => {
      const smallPool = createWorkerPool({
        globalMaxConcurrent: 5,
        projectMaxConcurrent: 3,
      });
      smallPool.recordSpawn("proj-a", "s-1");

      // Global: 5 - 1 - 1 = 3, Project: 3 - 1 - 1 = 1 => min = 1
      const check = smallPool.canSpawn("proj-a");
      expect(check.canSpawn).toBe(true);
      expect(check.slotsRemaining).toBe(1);
    });

    it("reports global slotsRemaining when project limit hit", () => {
      const smallPool = createWorkerPool({
        globalMaxConcurrent: 10,
        projectMaxConcurrent: 2,
      });
      smallPool.recordSpawn("proj-a", "s-1");
      smallPool.recordSpawn("proj-a", "s-2");

      const check = smallPool.canSpawn("proj-a");
      expect(check.canSpawn).toBe(false);
      expect(check.limitHit).toBe("project");
      // Global remaining: 10 - 2 = 8
      expect(check.slotsRemaining).toBe(8);
    });

    it("reports 0 slotsRemaining when global limit hit", () => {
      const smallPool = createWorkerPool({ globalMaxConcurrent: 1 });
      smallPool.recordSpawn("proj-a", "s-1");

      const check = smallPool.canSpawn("proj-b");
      expect(check.canSpawn).toBe(false);
      expect(check.slotsRemaining).toBe(0);
    });

    it("reports correct slots for the last available slot", () => {
      const smallPool = createWorkerPool({
        globalMaxConcurrent: 3,
        projectMaxConcurrent: 3,
      });
      smallPool.recordSpawn("proj-a", "s-1");
      smallPool.recordSpawn("proj-a", "s-2");

      // After spawning, there would be 3 sessions, so global 3-2-1=0, project 3-2-1=0
      const check = smallPool.canSpawn("proj-a");
      expect(check.canSpawn).toBe(true);
      expect(check.slotsRemaining).toBe(0);
    });

    it("global limit takes precedence over project limit", () => {
      const smallPool = createWorkerPool({
        globalMaxConcurrent: 2,
        projectMaxConcurrent: 5,
      });
      smallPool.recordSpawn("proj-a", "s-1");
      smallPool.recordSpawn("proj-b", "s-2");

      const check = smallPool.canSpawn("proj-a");
      expect(check.canSpawn).toBe(false);
      expect(check.limitHit).toBe("global");
    });
  });

  // ===========================================================================
  // syncFromSessions
  // ===========================================================================

  describe("syncFromSessions", () => {
    it("rebuilds state from session list", () => {
      pool.syncFromSessions([
        { id: "s-1", projectId: "proj-a", status: "working" },
        { id: "s-2", projectId: "proj-a", status: "pr_open" },
        { id: "s-3", projectId: "proj-b", status: "spawning" },
      ]);

      expect(pool.getActiveCount("proj-a")).toBe(2);
      expect(pool.getActiveCount("proj-b")).toBe(1);
      expect(pool.getActiveSessions("proj-a")).toContain("s-1");
      expect(pool.getActiveSessions("proj-a")).toContain("s-2");
    });

    it("excludes terminal sessions", () => {
      pool.syncFromSessions([
        { id: "s-1", projectId: "proj-a", status: "working" },
        { id: "s-2", projectId: "proj-a", status: "killed" },
        { id: "s-3", projectId: "proj-a", status: "terminated" },
        { id: "s-4", projectId: "proj-a", status: "done" },
        { id: "s-5", projectId: "proj-a", status: "cleanup" },
        { id: "s-6", projectId: "proj-a", status: "errored" },
        { id: "s-7", projectId: "proj-a", status: "merged" },
      ]);

      expect(pool.getActiveCount("proj-a")).toBe(1);
      expect(pool.getActiveSessions("proj-a")).toEqual(["s-1"]);
    });

    it("clears previous state before syncing", () => {
      pool.recordSpawn("proj-a", "old-session");
      pool.syncFromSessions([
        { id: "new-session", projectId: "proj-b", status: "working" },
      ]);

      expect(pool.getActiveCount("proj-a")).toBe(0);
      expect(pool.getActiveCount("proj-b")).toBe(1);
    });

    it("handles empty session list", () => {
      pool.recordSpawn("proj-a", "s-1");
      pool.syncFromSessions([]);

      expect(pool.getActiveCount("proj-a")).toBe(0);
      expect(pool.getStatus().globalActive).toBe(0);
    });

    it("correctly counts all non-terminal statuses as active", () => {
      pool.syncFromSessions([
        { id: "s-1", projectId: "p", status: "spawning" },
        { id: "s-2", projectId: "p", status: "working" },
        { id: "s-3", projectId: "p", status: "pr_open" },
        { id: "s-4", projectId: "p", status: "ci_failed" },
        { id: "s-5", projectId: "p", status: "review_pending" },
        { id: "s-6", projectId: "p", status: "changes_requested" },
        { id: "s-7", projectId: "p", status: "approved" },
        { id: "s-8", projectId: "p", status: "mergeable" },
        { id: "s-9", projectId: "p", status: "needs_input" },
        { id: "s-10", projectId: "p", status: "stuck" },
      ]);

      expect(pool.getActiveCount("p")).toBe(10);
    });
  });

  // ===========================================================================
  // getStatus
  // ===========================================================================

  describe("getStatus", () => {
    it("returns correct global status", () => {
      pool.recordSpawn("proj-a", "s-1");
      pool.recordSpawn("proj-b", "s-2");

      const status = pool.getStatus();
      expect(status.globalActive).toBe(2);
      expect(status.globalMax).toBe(10);
    });

    it("returns per-project counts", () => {
      pool.recordSpawn("proj-a", "s-1");
      pool.recordSpawn("proj-a", "s-2");
      pool.recordSpawn("proj-b", "s-3");

      const status = pool.getStatus();
      expect(status.projectCounts["proj-a"]).toEqual({ active: 2, max: 5 });
      expect(status.projectCounts["proj-b"]).toEqual({ active: 1, max: 5 });
    });

    it("returns empty project counts when no sessions active", () => {
      const status = pool.getStatus();
      expect(status.globalActive).toBe(0);
      expect(Object.keys(status.projectCounts)).toHaveLength(0);
    });

    it("reflects custom config in status", () => {
      const customPool = createWorkerPool({
        globalMaxConcurrent: 20,
        projectMaxConcurrent: 8,
      });
      customPool.recordSpawn("proj-a", "s-1");

      const status = customPool.getStatus();
      expect(status.globalMax).toBe(20);
      expect(status.projectCounts["proj-a"]?.max).toBe(8);
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe("edge cases", () => {
    it("getActiveCount for unknown project returns 0", () => {
      expect(pool.getActiveCount("nonexistent")).toBe(0);
    });

    it("getActiveSessions for unknown project returns empty array", () => {
      expect(pool.getActiveSessions("nonexistent")).toEqual([]);
    });

    it("canSpawn for unknown project works correctly", () => {
      const check = pool.canSpawn("brand-new-project");
      expect(check.canSpawn).toBe(true);
    });

    it("double spawn of same session ID is idempotent in count", () => {
      pool.recordSpawn("proj-a", "s-1");
      pool.recordSpawn("proj-a", "s-1"); // duplicate
      expect(pool.getActiveCount("proj-a")).toBe(1);
    });

    it("double exit of same session does not go negative", () => {
      pool.recordSpawn("proj-a", "s-1");
      pool.recordExit("proj-a", "s-1");
      pool.recordExit("proj-a", "s-1"); // already removed
      expect(pool.getActiveCount("proj-a")).toBe(0);
    });

    it("exit for unknown project does not throw", () => {
      expect(() => pool.recordExit("nonexistent", "s-1")).not.toThrow();
    });

    it("exit for unknown session does not throw", () => {
      pool.recordSpawn("proj-a", "s-1");
      expect(() => pool.recordExit("proj-a", "unknown-session")).not.toThrow();
      expect(pool.getActiveCount("proj-a")).toBe(1);
    });

    it("handles many sessions across many projects", () => {
      const bigPool = createWorkerPool({
        globalMaxConcurrent: 100,
        projectMaxConcurrent: 20,
      });

      for (let p = 0; p < 5; p++) {
        for (let s = 0; s < 20; s++) {
          bigPool.recordSpawn(`proj-${p}`, `proj-${p}-s-${s}`);
        }
      }

      const status = bigPool.getStatus();
      expect(status.globalActive).toBe(100);
      expect(Object.keys(status.projectCounts)).toHaveLength(5);

      // Global limit (100/100) is checked first, so it reports "global"
      const check = bigPool.canSpawn("proj-0");
      expect(check.canSpawn).toBe(false);
      expect(check.limitHit).toBe("global");
    });

    it("global limit blocks even with project override allowing more", () => {
      const constrainedPool = createWorkerPool({
        globalMaxConcurrent: 2,
        projectOverrides: {
          "big-proj": { maxConcurrent: 100 },
        },
      });
      constrainedPool.recordSpawn("big-proj", "s-1");
      constrainedPool.recordSpawn("big-proj", "s-2");

      const check = constrainedPool.canSpawn("big-proj");
      expect(check.canSpawn).toBe(false);
      expect(check.limitHit).toBe("global");
    });
  });

  // ===========================================================================
  // clear
  // ===========================================================================

  describe("clear", () => {
    it("removes all tracked sessions", () => {
      pool.recordSpawn("proj-a", "s-1");
      pool.recordSpawn("proj-a", "s-2");
      pool.recordSpawn("proj-b", "s-3");
      pool.clear();

      expect(pool.getActiveCount("proj-a")).toBe(0);
      expect(pool.getActiveCount("proj-b")).toBe(0);
      expect(pool.getStatus().globalActive).toBe(0);
    });

    it("allows spawning after clear", () => {
      const smallPool = createWorkerPool({ globalMaxConcurrent: 1 });
      smallPool.recordSpawn("proj-a", "s-1");
      expect(smallPool.canSpawn("proj-a").canSpawn).toBe(false);

      smallPool.clear();
      expect(smallPool.canSpawn("proj-a").canSpawn).toBe(true);
    });

    it("clear is idempotent", () => {
      pool.clear();
      pool.clear();
      expect(pool.getStatus().globalActive).toBe(0);
    });
  });
});
