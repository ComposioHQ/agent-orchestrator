/**
 * Tests for TTL cache implementation
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TTLCache, prCacheKey } from "../cache";

describe("TTLCache", () => {
  let cache: TTLCache<string>;

  beforeEach(() => {
    cache = new TTLCache<string>(1000); // 1 second TTL
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

    vi.useRealTimers();
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
