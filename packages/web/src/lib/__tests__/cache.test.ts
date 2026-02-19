/**
 * Tests for TTL cache implementation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TTLCache, prCacheKey } from "../cache";

describe("TTLCache", () => {
  let cache: TTLCache<string>;

  beforeEach(() => {
    cache = new TTLCache<string>(1000); // 1 second TTL
  });

  afterEach(() => {
    cache.clear(); // Clean up interval
  });

  it("should store and retrieve values", () => {
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("should return null for non-existent keys", () => {
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("should expire entries after TTL", () => {
    vi.useFakeTimers();
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");

    // Advance time past TTL
    vi.advanceTimersByTime(1001);
    expect(cache.get("key1")).toBeNull();

    vi.useRealTimers();
  });

  it("should not expire entries before TTL", () => {
    vi.useFakeTimers();
    cache.set("key1", "value1");

    // Advance time before TTL expires
    vi.advanceTimersByTime(500);
    expect(cache.get("key1")).toBe("value1");

    vi.useRealTimers();
  });

  it("should clear all entries", () => {
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    expect(cache.size()).toBe(2);

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("key1")).toBeNull();
    expect(cache.get("key2")).toBeNull();
  });

  it("should overwrite existing keys", () => {
    cache.set("key1", "value1");
    cache.set("key1", "value2");
    expect(cache.get("key1")).toBe("value2");
  });

  it("should handle custom TTL", () => {
    vi.useFakeTimers();
    const shortCache = new TTLCache<string>(100); // 100ms TTL
    shortCache.set("key1", "value1");

    vi.advanceTimersByTime(99);
    expect(shortCache.get("key1")).toBe("value1");

    vi.advanceTimersByTime(2);
    expect(shortCache.get("key1")).toBeNull();

    shortCache.clear();
    vi.useRealTimers();
  });

  it("should automatically evict expired entries via cleanup interval", async () => {
    // Use a real short-lived cache for this test
    const shortCache = new TTLCache<string>(50); // 50ms TTL
    shortCache.set("key1", "value1");
    shortCache.set("key2", "value2");
    expect(shortCache.size()).toBe(2);

    // Wait for TTL + cleanup interval to run
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Both entries should be evicted by cleanup
    expect(shortCache.size()).toBe(0);

    shortCache.clear();
  });

  it("should not prevent process exit with unref", () => {
    // This test just verifies the cache can be created without throwing
    const testCache = new TTLCache<string>(1000);
    expect(testCache).toBeDefined();
    testCache.clear();
  });

  describe("getWithMetadata", () => {
    it("should return value with metadata", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      cache.set("key1", "value1");

      // Advance time by 500ms
      vi.advanceTimersByTime(500);

      const result = cache.getWithMetadata("key1");
      expect(result).not.toBeNull();
      expect(result?.value).toBe("value1");
      expect(result?.ageMs).toBe(500);
      expect(result?.ttlMs).toBe(1000);
      expect(result?.cachedAt.getTime()).toBe(now);
      expect(result?.stale).toBe(false); // 500ms < 75% of 1000ms

      vi.useRealTimers();
    });

    it("should mark entry as stale when >75% of TTL", () => {
      vi.useFakeTimers();
      cache.set("key1", "value1");

      // Advance time to 800ms (80% of 1000ms TTL)
      vi.advanceTimersByTime(800);

      const result = cache.getWithMetadata("key1");
      expect(result).not.toBeNull();
      expect(result?.stale).toBe(true); // 800ms > 75% of 1000ms

      vi.useRealTimers();
    });

    it("should return null for expired entries", () => {
      vi.useFakeTimers();
      cache.set("key1", "value1");

      // Advance past TTL
      vi.advanceTimersByTime(1001);

      const result = cache.getWithMetadata("key1");
      expect(result).toBeNull();

      vi.useRealTimers();
    });

    it("should return null for non-existent keys", () => {
      const result = cache.getWithMetadata("nonexistent");
      expect(result).toBeNull();
    });

    it("should work alongside get() method", () => {
      cache.set("key1", "value1");

      // Both methods should work
      expect(cache.get("key1")).toBe("value1");
      const result = cache.getWithMetadata("key1");
      expect(result?.value).toBe("value1");
    });
  });
});

describe("prCacheKey", () => {
  it("should generate correct cache key", () => {
    expect(prCacheKey("owner", "repo", 123)).toBe("owner/repo#123");
  });

  it("should generate unique keys for different PRs", () => {
    const key1 = prCacheKey("owner1", "repo1", 1);
    const key2 = prCacheKey("owner1", "repo1", 2);
    const key3 = prCacheKey("owner2", "repo1", 1);

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key2).not.toBe(key3);
  });
});
