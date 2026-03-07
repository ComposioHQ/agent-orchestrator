import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createRateLimitTracker, type RateLimitTracker } from "../rate-limit-tracker.js";

describe("createRateLimitTracker", () => {
  let tracker: RateLimitTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    tracker = createRateLimitTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ===========================================================================
  // Recording and checking rate limits
  // ===========================================================================

  describe("recordRateLimit / isRateLimited", () => {
    it("records a rate limit and reports it as limited", () => {
      const resetAt = new Date(Date.now() + 30 * 60 * 1_000); // 30 min from now
      tracker.recordRateLimit("claude", resetAt, "429 Too Many Requests");

      expect(tracker.isRateLimited("claude")).toBe(true);
    });

    it("returns false for executables that are not rate limited", () => {
      expect(tracker.isRateLimited("claude")).toBe(false);
      expect(tracker.isRateLimited("codex")).toBe(false);
    });

    it("overwrites existing entry when recording again", () => {
      const resetAt1 = new Date(Date.now() + 20 * 60 * 1_000);
      const resetAt2 = new Date(Date.now() + 60 * 60 * 1_000);

      tracker.recordRateLimit("claude", resetAt1, "first limit");
      tracker.recordRateLimit("claude", resetAt2, "second limit");

      const entries = tracker.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].reason).toBe("second limit");
      expect(entries[0].resetAt.getTime()).toBe(resetAt2.getTime());
    });

    it("tracks multiple executables independently", () => {
      const resetAt = new Date(Date.now() + 30 * 60 * 1_000);
      tracker.recordRateLimit("claude", resetAt, "rate limited");
      tracker.recordRateLimit("codex", resetAt, "rate limited");

      expect(tracker.isRateLimited("claude")).toBe(true);
      expect(tracker.isRateLimited("codex")).toBe(true);
      expect(tracker.isRateLimited("aider")).toBe(false);
    });
  });

  // ===========================================================================
  // Minimum reset floor
  // ===========================================================================

  describe("minimum reset floor", () => {
    it("enforces 15 minute minimum floor by default", () => {
      // Try to set reset to 1 minute from now — should be pushed to 15 min
      const tooSoon = new Date(Date.now() + 1 * 60 * 1_000);
      tracker.recordRateLimit("claude", tooSoon, "rate limited");

      const entries = tracker.getEntries();
      const expectedFloor = Date.now() + 15 * 60 * 1_000;
      expect(entries[0].resetAt.getTime()).toBe(expectedFloor);
    });

    it("does not adjust reset time that exceeds the floor", () => {
      const farFuture = new Date(Date.now() + 60 * 60 * 1_000); // 1 hour
      tracker.recordRateLimit("claude", farFuture, "rate limited");

      const entries = tracker.getEntries();
      expect(entries[0].resetAt.getTime()).toBe(farFuture.getTime());
    });

    it("respects custom minResetFloorMs", () => {
      const customTracker = createRateLimitTracker({
        minResetFloorMs: 5 * 60 * 1_000, // 5 minutes
      });

      const tooSoon = new Date(Date.now() + 1 * 60 * 1_000);
      customTracker.recordRateLimit("claude", tooSoon, "rate limited");

      const entries = customTracker.getEntries();
      const expectedFloor = Date.now() + 5 * 60 * 1_000;
      expect(entries[0].resetAt.getTime()).toBe(expectedFloor);
    });

    it("enforces floor for reset time in the past", () => {
      const past = new Date(Date.now() - 60 * 1_000); // 1 min ago
      tracker.recordRateLimit("claude", past, "stale reset");

      const entries = tracker.getEntries();
      const expectedFloor = Date.now() + 15 * 60 * 1_000;
      expect(entries[0].resetAt.getTime()).toBe(expectedFloor);
    });
  });

  // ===========================================================================
  // Expiry and pruning
  // ===========================================================================

  describe("expiry and pruning", () => {
    it("auto-expires entries when checking isRateLimited", () => {
      const resetAt = new Date(Date.now() + 20 * 60 * 1_000); // 20 min
      tracker.recordRateLimit("claude", resetAt, "rate limited");

      expect(tracker.isRateLimited("claude")).toBe(true);

      // Advance time past the reset
      vi.advanceTimersByTime(21 * 60 * 1_000);

      expect(tracker.isRateLimited("claude")).toBe(false);
      expect(tracker.getEntries()).toHaveLength(0);
    });

    it("pruneExpired removes all expired entries", () => {
      const soon = new Date(Date.now() + 16 * 60 * 1_000); // 16 min (above floor)
      const later = new Date(Date.now() + 60 * 60 * 1_000); // 1 hour

      tracker.recordRateLimit("claude", soon, "rate limited");
      tracker.recordRateLimit("codex", later, "rate limited");

      expect(tracker.getEntries()).toHaveLength(2);

      // Advance past first but not second
      vi.advanceTimersByTime(20 * 60 * 1_000);
      tracker.pruneExpired();

      const remaining = tracker.getEntries();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].executable).toBe("codex");
    });

    it("pruneExpired handles empty state", () => {
      tracker.pruneExpired();
      expect(tracker.getEntries()).toHaveLength(0);
    });

    it("pruneExpired removes all when all expired", () => {
      const resetAt = new Date(Date.now() + 16 * 60 * 1_000);
      tracker.recordRateLimit("claude", resetAt, "limited");
      tracker.recordRateLimit("codex", resetAt, "limited");

      vi.advanceTimersByTime(20 * 60 * 1_000);
      tracker.pruneExpired();

      expect(tracker.getEntries()).toHaveLength(0);
    });
  });

  // ===========================================================================
  // clear
  // ===========================================================================

  describe("clear", () => {
    it("removes all entries", () => {
      const resetAt = new Date(Date.now() + 30 * 60 * 1_000);
      tracker.recordRateLimit("claude", resetAt, "limited");
      tracker.recordRateLimit("codex", resetAt, "limited");

      expect(tracker.getEntries()).toHaveLength(2);
      tracker.clear();
      expect(tracker.getEntries()).toHaveLength(0);
    });

    it("works on empty tracker", () => {
      tracker.clear();
      expect(tracker.getEntries()).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Fallback chain walking
  // ===========================================================================

  describe("getAvailableExecutable", () => {
    it("returns preferred executable when not rate limited", () => {
      const chainTracker = createRateLimitTracker({
        fallbackChains: { claude: ["codex", "aider"] },
      });

      expect(chainTracker.getAvailableExecutable("claude")).toBe("claude");
    });

    it("returns first available fallback when preferred is rate limited", () => {
      const chainTracker = createRateLimitTracker({
        fallbackChains: { claude: ["codex", "aider"] },
      });

      const resetAt = new Date(Date.now() + 30 * 60 * 1_000);
      chainTracker.recordRateLimit("claude", resetAt, "limited");

      expect(chainTracker.getAvailableExecutable("claude")).toBe("codex");
    });

    it("skips rate-limited fallbacks", () => {
      const chainTracker = createRateLimitTracker({
        fallbackChains: { claude: ["codex", "aider"] },
      });

      const resetAt = new Date(Date.now() + 30 * 60 * 1_000);
      chainTracker.recordRateLimit("claude", resetAt, "limited");
      chainTracker.recordRateLimit("codex", resetAt, "limited");

      expect(chainTracker.getAvailableExecutable("claude")).toBe("aider");
    });

    it("returns preferred when all fallbacks are rate limited", () => {
      const chainTracker = createRateLimitTracker({
        fallbackChains: { claude: ["codex", "aider"] },
      });

      const resetAt = new Date(Date.now() + 30 * 60 * 1_000);
      chainTracker.recordRateLimit("claude", resetAt, "limited");
      chainTracker.recordRateLimit("codex", resetAt, "limited");
      chainTracker.recordRateLimit("aider", resetAt, "limited");

      expect(chainTracker.getAvailableExecutable("claude")).toBe("claude");
    });

    it("returns preferred when no fallback chain is configured", () => {
      const resetAt = new Date(Date.now() + 30 * 60 * 1_000);
      tracker.recordRateLimit("claude", resetAt, "limited");

      // No fallback chains configured in default tracker
      expect(tracker.getAvailableExecutable("claude")).toBe("claude");
    });

    it("returns preferred for unknown executable not in any chain", () => {
      const chainTracker = createRateLimitTracker({
        fallbackChains: { claude: ["codex"] },
      });

      expect(chainTracker.getAvailableExecutable("aider")).toBe("aider");
    });

    it("handles fallback becoming available after expiry", () => {
      const chainTracker = createRateLimitTracker({
        fallbackChains: { claude: ["codex", "aider"] },
      });

      const shortReset = new Date(Date.now() + 16 * 60 * 1_000); // 16 min
      const longReset = new Date(Date.now() + 60 * 60 * 1_000); // 1 hour

      chainTracker.recordRateLimit("claude", longReset, "limited");
      chainTracker.recordRateLimit("codex", shortReset, "limited");

      // Initially, codex is limited, so aider is the fallback
      expect(chainTracker.getAvailableExecutable("claude")).toBe("aider");

      // After codex reset expires, codex should be available
      vi.advanceTimersByTime(20 * 60 * 1_000);
      expect(chainTracker.getAvailableExecutable("claude")).toBe("codex");
    });
  });

  // ===========================================================================
  // Output pattern detection
  // ===========================================================================

  describe("detectFromOutput", () => {
    it("detects 'rate limit' pattern", () => {
      const result = tracker.detectFromOutput(
        "Error: rate limit exceeded for this API key",
      );
      expect(result.detected).toBe(true);
      expect(result.reason).toContain("rate limit");
    });

    it("detects 'rate_limit' (underscore) pattern", () => {
      const result = tracker.detectFromOutput("rate_limit error on request");
      expect(result.detected).toBe(true);
    });

    it("detects 'ratelimit' (no separator) pattern", () => {
      const result = tracker.detectFromOutput("ratelimit: please slow down");
      expect(result.detected).toBe(true);
    });

    it("detects 'rate-limit' (hyphen) pattern", () => {
      const result = tracker.detectFromOutput("rate-limit reached");
      expect(result.detected).toBe(true);
    });

    it("detects 'too many requests' pattern", () => {
      const result = tracker.detectFromOutput(
        "HTTP 429: Too Many Requests. Please slow down.",
      );
      expect(result.detected).toBe(true);
    });

    it("detects '429' status code", () => {
      const result = tracker.detectFromOutput(
        "Request failed with status 429",
      );
      expect(result.detected).toBe(true);
    });

    it("does not false-positive on '429' within larger numbers", () => {
      const result = tracker.detectFromOutput("processed 14295 records");
      expect(result.detected).toBe(false);
    });

    it("detects 'quota exceeded' pattern", () => {
      const result = tracker.detectFromOutput(
        "Error: API quota exceeded for project",
      );
      expect(result.detected).toBe(true);
    });

    it("detects 'throttled' pattern", () => {
      const result = tracker.detectFromOutput(
        "Your requests are being throttled",
      );
      expect(result.detected).toBe(true);
    });

    it("returns detected=false for unrelated output", () => {
      const result = tracker.detectFromOutput(
        "Successfully compiled 42 files in 3.5 seconds",
      );
      expect(result.detected).toBe(false);
      expect(result.resetAt).toBeUndefined();
      expect(result.reason).toBeUndefined();
    });

    it("returns detected=false for empty output", () => {
      const result = tracker.detectFromOutput("");
      expect(result.detected).toBe(false);
    });

    // --- Reset time extraction ---

    it("extracts 'try again in N minutes'", () => {
      const result = tracker.detectFromOutput(
        "Rate limit exceeded. Try again in 5 minutes.",
      );
      expect(result.detected).toBe(true);
      expect(result.resetAt).toBeDefined();

      const expectedMs = Date.now() + 5 * 60 * 1_000;
      expect(result.resetAt!.getTime()).toBe(expectedMs);
    });

    it("extracts 'try again in N seconds'", () => {
      const result = tracker.detectFromOutput(
        "Rate limit hit. Try again in 30 seconds.",
      );
      expect(result.detected).toBe(true);
      expect(result.resetAt).toBeDefined();

      const expectedMs = Date.now() + 30 * 1_000;
      expect(result.resetAt!.getTime()).toBe(expectedMs);
    });

    it("extracts 'try again in N hours'", () => {
      const result = tracker.detectFromOutput(
        "Rate limit reached. Try again in 2 hours.",
      );
      expect(result.detected).toBe(true);
      expect(result.resetAt).toBeDefined();

      const expectedMs = Date.now() + 2 * 60 * 60 * 1_000;
      expect(result.resetAt!.getTime()).toBe(expectedMs);
    });

    it("extracts 'retry after N mins'", () => {
      const result = tracker.detectFromOutput(
        "Throttled. Retry after 10 mins.",
      );
      expect(result.detected).toBe(true);
      expect(result.resetAt).toBeDefined();

      const expectedMs = Date.now() + 10 * 60 * 1_000;
      expect(result.resetAt!.getTime()).toBe(expectedMs);
    });

    it("extracts 'wait N seconds'", () => {
      const result = tracker.detectFromOutput(
        "Too many requests, wait 60 seconds before retrying.",
      );
      expect(result.detected).toBe(true);
      expect(result.resetAt).toBeDefined();

      const expectedMs = Date.now() + 60 * 1_000;
      expect(result.resetAt!.getTime()).toBe(expectedMs);
    });

    it("extracts 'resets in N minutes'", () => {
      const result = tracker.detectFromOutput(
        "Rate limit active. Resets in 15 minutes.",
      );
      expect(result.detected).toBe(true);
      expect(result.resetAt).toBeDefined();

      const expectedMs = Date.now() + 15 * 60 * 1_000;
      expect(result.resetAt!.getTime()).toBe(expectedMs);
    });

    it("extracts absolute reset timestamp", () => {
      const result = tracker.detectFromOutput(
        "Rate limit exceeded. Resets at 2025-06-15T13:00:00Z",
      );
      expect(result.detected).toBe(true);
      expect(result.resetAt).toBeDefined();
      expect(result.resetAt!.toISOString()).toBe("2025-06-15T13:00:00.000Z");
    });

    it("returns no resetAt when no time info is present", () => {
      const result = tracker.detectFromOutput("Error: rate limit exceeded");
      expect(result.detected).toBe(true);
      expect(result.resetAt).toBeUndefined();
    });

    it("handles multiline output and finds the rate limit line", () => {
      const output = [
        "Starting agent session...",
        "Connected to API",
        "Error: Too many requests. Try again in 5 minutes.",
        "Session terminated.",
      ].join("\n");

      const result = tracker.detectFromOutput(output);
      expect(result.detected).toBe(true);
      expect(result.reason).toContain("Too many requests");
      expect(result.resetAt).toBeDefined();
    });

    it("truncates very long reason lines", () => {
      const longLine = "Rate limit exceeded " + "x".repeat(300);
      const result = tracker.detectFromOutput(longLine);
      expect(result.detected).toBe(true);
      expect(result.reason!.length).toBeLessThanOrEqual(203); // 200 + "..."
    });
  });

  // ===========================================================================
  // Rapid exit detection
  // ===========================================================================

  describe("detectRapidExit", () => {
    it("detects session that exited within 10 seconds as rapid", () => {
      const start = new Date("2025-06-15T12:00:00Z");
      const end = new Date("2025-06-15T12:00:05Z"); // 5 seconds later

      expect(tracker.detectRapidExit(start, end)).toBe(true);
    });

    it("does not flag session that ran for more than 10 seconds", () => {
      const start = new Date("2025-06-15T12:00:00Z");
      const end = new Date("2025-06-15T12:00:15Z"); // 15 seconds later

      expect(tracker.detectRapidExit(start, end)).toBe(false);
    });

    it("detects exit at exactly the threshold as non-rapid", () => {
      const start = new Date("2025-06-15T12:00:00Z");
      const end = new Date("2025-06-15T12:00:10Z"); // exactly 10 seconds

      // 10 seconds is NOT less than 10 seconds threshold
      expect(tracker.detectRapidExit(start, end)).toBe(false);
    });

    it("detects instant exit (0 duration) as rapid", () => {
      const time = new Date("2025-06-15T12:00:00Z");
      expect(tracker.detectRapidExit(time, time)).toBe(true);
    });

    it("handles end before start (negative duration) as non-rapid", () => {
      const start = new Date("2025-06-15T12:00:10Z");
      const end = new Date("2025-06-15T12:00:00Z"); // before start

      expect(tracker.detectRapidExit(start, end)).toBe(false);
    });

    it("respects custom rapidExitThresholdMs", () => {
      const customTracker = createRateLimitTracker({
        rapidExitThresholdMs: 30 * 1_000, // 30 seconds
      });

      const start = new Date("2025-06-15T12:00:00Z");
      const end15s = new Date("2025-06-15T12:00:15Z");
      const end35s = new Date("2025-06-15T12:00:35Z");

      expect(customTracker.detectRapidExit(start, end15s)).toBe(true);
      expect(customTracker.detectRapidExit(start, end35s)).toBe(false);
    });
  });

  // ===========================================================================
  // getEntries
  // ===========================================================================

  describe("getEntries", () => {
    it("returns empty array when no entries", () => {
      expect(tracker.getEntries()).toEqual([]);
    });

    it("returns all recorded entries", () => {
      const resetAt = new Date(Date.now() + 30 * 60 * 1_000);
      tracker.recordRateLimit("claude", resetAt, "limited");
      tracker.recordRateLimit("codex", resetAt, "limited too");

      const entries = tracker.getEntries();
      expect(entries).toHaveLength(2);

      const names = entries.map((e) => e.executable).sort();
      expect(names).toEqual(["claude", "codex"]);
    });

    it("returns entries with correct structure", () => {
      const resetAt = new Date(Date.now() + 30 * 60 * 1_000);
      tracker.recordRateLimit("claude", resetAt, "API quota exceeded");

      const entry = tracker.getEntries()[0];
      expect(entry.executable).toBe("claude");
      expect(entry.rateLimitedAt).toBeInstanceOf(Date);
      expect(entry.resetAt).toBeInstanceOf(Date);
      expect(entry.reason).toBe("API quota exceeded");
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe("edge cases", () => {
    it("works with no config (all defaults)", () => {
      const defaultTracker = createRateLimitTracker();

      expect(defaultTracker.isRateLimited("claude")).toBe(false);
      expect(defaultTracker.getAvailableExecutable("claude")).toBe("claude");
      expect(defaultTracker.getEntries()).toEqual([]);
      expect(defaultTracker.detectFromOutput("all good")).toEqual({
        detected: false,
      });
    });

    it("works with empty fallback chains", () => {
      const emptyChainTracker = createRateLimitTracker({
        fallbackChains: {},
      });

      const resetAt = new Date(Date.now() + 30 * 60 * 1_000);
      emptyChainTracker.recordRateLimit("claude", resetAt, "limited");

      expect(emptyChainTracker.getAvailableExecutable("claude")).toBe("claude");
    });

    it("works with empty fallback array", () => {
      const emptyArrayTracker = createRateLimitTracker({
        fallbackChains: { claude: [] },
      });

      const resetAt = new Date(Date.now() + 30 * 60 * 1_000);
      emptyArrayTracker.recordRateLimit("claude", resetAt, "limited");

      expect(emptyArrayTracker.getAvailableExecutable("claude")).toBe("claude");
    });

    it("handles case sensitivity in output detection", () => {
      expect(
        tracker.detectFromOutput("RATE LIMIT exceeded").detected,
      ).toBe(true);
      expect(
        tracker.detectFromOutput("Rate Limit Reached").detected,
      ).toBe(true);
      expect(
        tracker.detectFromOutput("QUOTA EXCEEDED").detected,
      ).toBe(true);
      expect(
        tracker.detectFromOutput("THROTTLED").detected,
      ).toBe(true);
    });

    it("handles undefined config values gracefully", () => {
      const partialTracker = createRateLimitTracker({
        minResetFloorMs: undefined,
        fallbackChains: undefined,
        rapidExitThresholdMs: undefined,
      });

      // Should use defaults
      const tooSoon = new Date(Date.now() + 1 * 60 * 1_000);
      partialTracker.recordRateLimit("claude", tooSoon, "limited");

      const entries = partialTracker.getEntries();
      const expectedFloor = Date.now() + 15 * 60 * 1_000;
      expect(entries[0].resetAt.getTime()).toBe(expectedFloor);
    });

    it("record + clear + record works correctly", () => {
      const resetAt = new Date(Date.now() + 30 * 60 * 1_000);
      tracker.recordRateLimit("claude", resetAt, "first");

      tracker.clear();
      expect(tracker.isRateLimited("claude")).toBe(false);

      tracker.recordRateLimit("claude", resetAt, "second");
      expect(tracker.isRateLimited("claude")).toBe(true);
      expect(tracker.getEntries()[0].reason).toBe("second");
    });

    it("detectFromOutput with 'try again in' but no rate limit keyword still needs keyword", () => {
      // "try again in 5 minutes" alone does not trigger detection
      // without a rate limit keyword
      const result = tracker.detectFromOutput(
        "Test failed. Try again in 5 minutes after fixing the issue.",
      );
      expect(result.detected).toBe(false);
    });
  });
});
