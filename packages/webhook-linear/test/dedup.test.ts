import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  wasRecentlySpawned,
  markSpawned,
  cleanup,
  reset,
  entries,
} from "../src/dedup.js";

describe("dedup tracker", () => {
  beforeEach(() => {
    reset();
    vi.useRealTimers();
  });

  describe("wasRecentlySpawned", () => {
    it("returns false for an unknown issue", () => {
      expect(wasRecentlySpawned("ISSUE-1", "code")).toBe(false);
    });

    it("returns true after markSpawned for same issue and type", () => {
      markSpawned("ISSUE-1", "code");
      expect(wasRecentlySpawned("ISSUE-1", "code")).toBe(true);
    });

    it("treats different spawn types as independent", () => {
      markSpawned("ISSUE-1", "code");
      expect(wasRecentlySpawned("ISSUE-1", "test-gen")).toBe(false);
    });

    it("treats different issue IDs as independent", () => {
      markSpawned("ISSUE-1", "code");
      expect(wasRecentlySpawned("ISSUE-2", "code")).toBe(false);
    });

    it("returns false after the 5-minute dedup window expires", () => {
      vi.useFakeTimers();
      markSpawned("ISSUE-1", "code");
      expect(wasRecentlySpawned("ISSUE-1", "code")).toBe(true);

      // Advance past the 5-minute window
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(wasRecentlySpawned("ISSUE-1", "code")).toBe(false);
    });

    it("returns true just before the 5-minute window expires", () => {
      vi.useFakeTimers();
      markSpawned("ISSUE-1", "code");

      vi.advanceTimersByTime(5 * 60 * 1000 - 1);
      expect(wasRecentlySpawned("ISSUE-1", "code")).toBe(true);
    });

    it("deletes the expired entry from the map on access", () => {
      vi.useFakeTimers();
      markSpawned("ISSUE-1", "code");

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      wasRecentlySpawned("ISSUE-1", "code");

      expect(entries().size).toBe(0);
    });
  });

  describe("markSpawned", () => {
    it("updates the timestamp if called again for the same key", () => {
      vi.useFakeTimers();
      markSpawned("ISSUE-1", "code");

      vi.advanceTimersByTime(3 * 60 * 1000);
      markSpawned("ISSUE-1", "code");

      // Should still be considered recent after another 3 minutes
      // (total 6 min from first spawn, but only 3 min from second)
      vi.advanceTimersByTime(3 * 60 * 1000);
      expect(wasRecentlySpawned("ISSUE-1", "code")).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("removes expired entries", () => {
      vi.useFakeTimers();
      markSpawned("ISSUE-1", "code");
      markSpawned("ISSUE-2", "code");

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      cleanup();

      expect(entries().size).toBe(0);
    });

    it("keeps fresh entries", () => {
      vi.useFakeTimers();
      markSpawned("ISSUE-1", "code");

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      markSpawned("ISSUE-2", "test-gen");

      cleanup();

      expect(entries().size).toBe(1);
      expect(wasRecentlySpawned("ISSUE-1", "code")).toBe(false);
      expect(wasRecentlySpawned("ISSUE-2", "test-gen")).toBe(true);
    });

    it("does nothing when there are no entries", () => {
      cleanup();
      expect(entries().size).toBe(0);
    });
  });

  describe("reset", () => {
    it("clears all entries", () => {
      markSpawned("ISSUE-1", "code");
      markSpawned("ISSUE-2", "test-gen");
      markSpawned("ISSUE-3", "code");

      expect(entries().size).toBe(3);

      reset();
      expect(entries().size).toBe(0);
    });
  });

  describe("entries", () => {
    it("returns an empty map when nothing has been spawned", () => {
      expect(entries().size).toBe(0);
    });

    it("returns current map state with all tracked entries", () => {
      markSpawned("ISSUE-1", "code");
      markSpawned("ISSUE-2", "test-gen");

      const map = entries();
      expect(map.size).toBe(2);
      expect(map.has("ISSUE-1:code")).toBe(true);
      expect(map.has("ISSUE-2:test-gen")).toBe(true);
    });

    it("reflects timestamps as numbers", () => {
      vi.useFakeTimers();
      markSpawned("ISSUE-1", "code");

      const map = entries();
      const timestamp = map.get("ISSUE-1:code");
      expect(typeof timestamp).toBe("number");
      expect(timestamp).toBe(Date.now());
    });
  });
});
