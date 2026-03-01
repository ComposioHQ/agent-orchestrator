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

describe("getStats", () => {
  let cache: TTLCache<string>;

  beforeEach(() => {
    cache = new TTLCache<string>(1000); // 1 second TTL
  });

  afterEach(() => {
    cache.clear(); // Clean up interval
  });

  it("should return initial stats with all zeros", () => {
    const stats = cache.getStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe(0);
    expect(stats.size).toBe(0);
  });

  it("should increment hits after a cache hit", () => {
    cache.set("key1", "value1");
    cache.get("key1"); // hit

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
  });

  it("should increment misses after a cache miss", () => {
    cache.get("nonexistent"); // miss

    const stats = cache.getStats();
    expect(stats.misses).toBe(1);
  });

  it("should calculate hit rate correctly", () => {
    cache.set("key1", "value1");
    cache.get("key1"); // hit
    cache.get("key1"); // hit
    cache.get("key1"); // hit
    cache.get("nonexistent"); // miss

    const stats = cache.getStats();
    expect(stats.hits).toBe(3);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(0.75); // 3 / (3 + 1)
  });

  it("should track the number of entries via size", () => {
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    cache.set("key3", "value3");

    const stats = cache.getStats();
    expect(stats.size).toBe(3);
  });

  it("should reset size after clear but retain hit/miss counters", () => {
    cache.set("key1", "value1");
    cache.get("key1"); // hit
    cache.get("nonexistent"); // miss

    cache.clear();

    const stats = cache.getStats();
    expect(stats.size).toBe(0);
    // hits and misses are NOT reset by clear()
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });

  it("should count expired entry access as a miss", () => {
    vi.useFakeTimers();
    cache.set("key1", "value1");

    // Advance time past TTL
    vi.advanceTimersByTime(1001);
    cache.get("key1"); // miss (expired)

    const stats = cache.getStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(1);

    vi.useRealTimers();
  });
});
