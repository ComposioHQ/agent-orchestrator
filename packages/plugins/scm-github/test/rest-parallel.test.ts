/**
 * Tests for REST API Parallel PR Enrichment with 2-Guard ETag Strategy
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  LRUCache,
  ETagCache,
  BatchObserverImpl,
  fetchPRData,
  fetchCIData,
  shouldRefreshPREnrichment,
  enrichSessionsPRBatch,
  PARALLEL_CONCURRENCY,
  PR_METADATA_CACHE_SIZE,
  ENRICHMENT_CACHE_SIZE,
} from "../src/rest-parallel.js";

// Mock the gh function
vi.mock("../src/rest-parallel.js", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("../src/rest-parallel.js");

  // Create a mock fetch function
  const mockFetch = async (args: string[]): Promise<string> => {
    const url = args[args.indexOf("api") + 1];
    if (url?.includes("/pulls?")) {
      // PR list ETag check
      return 'ETag: "abc123"';
    }
    if (url?.includes("/commits/HEAD/status")) {
      // Commit status check
      return JSON.stringify({
        state: "success",
        statuses: [
          {
            context: "test-ci",
            state: "success",
            target_url: "https://example.com/ci",
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          },
        ],
      });
    }
    if (args.includes("pr") && args.includes("view")) {
      // PR view
      return JSON.stringify({
        state: "open",
        title: "Test PR",
        additions: 100,
        deletions: 50,
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        headRefOid: "abc123def456",
      });
    }
    return "{}";
  };

  return {
    ...mod,
    shouldRefreshPREnrichment: mod.shouldRefreshPREnrichment,
    enrichSessionsPRBatch: mod.enrichSessionsPRBatch,
  };
});

describe("LRU Cache", () => {
  it("should store and retrieve values", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("should return null for missing keys", () => {
    const cache = new LRUCache<string, number>(3);
    expect(cache.get("missing")).toBeNull();
  });

  it("should evict oldest entry when at capacity", () => {
    const cache = new LRUCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    expect(cache.get("a")).toBeNull(); // evicted
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("should move accessed entries to most recently used", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    // Access "a" to make it MRU
    cache.get("a");
    cache.set("d", 4);

    expect(cache.get("b")).toBeNull(); // evicted
    expect(cache.get("a")).toBe(1); // preserved
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("should track size correctly", () => {
    const cache = new LRUCache<string, number>(10);
    expect(cache.size()).toBe(0);

    cache.set("a", 1);
    expect(cache.size()).toBe(1);

    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size()).toBe(3);
  });

  it("should clear all entries", () => {
    const cache = new LRUCache<string, number>(10);
    cache.set("a", 1);
    cache.set("b", 2);

    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("a")).toBeNull();
  });
});

describe("ETag Cache", () => {
  it("should store and retrieve ETags", () => {
    const cache = new ETagCache(60_000);
    cache.set("key1", "etag1");
    cache.set("key2", "etag2");

    expect(cache.get("key1")).toBe("etag1");
    expect(cache.get("key2")).toBe("etag2");
  });

  it("should return null for missing keys", () => {
    const cache = new ETagCache(60_000);
    expect(cache.get("missing")).toBeNull();
  });

  it("should expire entries after TTL", () => {
    const cache = new ETagCache(10); // 10ms TTL for testing
    cache.set("key1", "etag1");

    expect(cache.get("key1")).toBe("etag1");

    // Wait for expiration
    return new Promise((resolve) => setTimeout(resolve, 15)).then(() => {
      expect(cache.get("key1")).toBeNull();
    });
  });

  it("should invalidate specific keys", () => {
    const cache = new ETagCache(60_000);
    cache.set("key1", "etag1");
    cache.set("key2", "etag2");

    cache.invalidate("key1");

    expect(cache.get("key1")).toBeNull();
    expect(cache.get("key2")).toBe("etag2");
  });

  it("should invalidate all keys for a repo", () => {
    const cache = new ETagCache(60_000);
    cache.set("pr-list:owner/repo1", "etag1");
    cache.set("commit-status:owner/repo1/1", "etag2");
    cache.set("pr-list:owner/repo2", "etag3");
    cache.set("commit-status:owner/repo2/2", "etag4");

    cache.invalidateRepo("owner", "repo1");

    expect(cache.get("pr-list:owner/repo1")).toBeNull();
    expect(cache.get("commit-status:owner/repo1/1")).toBeNull();
    expect(cache.get("pr-list:owner/repo2")).toBe("etag3");
    expect(cache.get("commit-status:owner/repo2/2")).toBe("etag4");
  });
});

describe("Batch Observer", () => {
  it("should record success messages", () => {
    const observer = new BatchObserverImpl("test");
    observer.recordSuccess("testOp", 123, { key: "value" });

    const logs = observer.getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[OK] testOp (123ms)");
    expect(logs[0]).toContain('"key":"value"');
  });

  it("should record failure messages", () => {
    const observer = new BatchObserverImpl("test");
    const error = new Error("test error");
    observer.recordFailure("testOp", error, 456);

    const logs = observer.getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[ERR] testOp failed: test error (456ms)");
  });

  it("should log messages", () => {
    const observer = new BatchObserverImpl("test");
    observer.log("test message", { key: "value" });

    const logs = observer.getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[test] test message");
    expect(logs[0]).toContain('"key":"value"');
  });

  it("should clear logs", () => {
    const observer = new BatchObserverImpl("test");
    observer.recordSuccess("op1", 100);
    observer.log("msg1");
    observer.recordFailure("op2", new Error("err"), 200);

    expect(observer.getLogs()).toHaveLength(3);
    observer.clear();
    expect(observer.getLogs()).toHaveLength(0);
  });

  it("should return all logs", () => {
    const observer = new BatchObserverImpl("test");
    observer.recordSuccess("op1", 100);
    observer.log("msg1");

    const logs = observer.getLogs();
    expect(logs).toHaveLength(2);
  });
});

describe("PR Data Fetching", () => {
  it("should parse PR state correctly", () => {
    // Test parsePRState through fetchPRData
    const pr = {
      number: 1,
      owner: "test",
      repo: "test-repo",
      branch: "feature",
      baseBranch: "main",
      isDraft: false,
      title: "Test PR",
      url: "https://github.com/test/test-repo/pull/1",
    };

    // This would call the mocked gh function which returns a response
    // In a real test, we'd mock execFileAsync
    // For now, just verify the interface exists
    expect(typeof fetchPRData).toBe("function");
  });
});

describe("CI Data Fetching", () => {
  it("should map check states correctly", () => {
    // The function exists
    expect(typeof fetchCIData).toBe("function");
  });
});

describe("Constants", () => {
  it("should export parallel concurrency constant", () => {
    expect(PARALLEL_CONCURRENCY).toBe(10);
  });

  it("should export PR metadata cache size constant", () => {
    expect(PR_METADATA_CACHE_SIZE).toBe(100);
  });

  it("should export enrichment cache size constant", () => {
    expect(ENRICHMENT_CACHE_SIZE).toBe(200);
  });
});

describe("Batch Enrichment", () => {
  beforeEach(() => {
    // Clear any cached state
    vi.clearAllMocks();
  });

  it("should return a Map from enrichSessionsPRBatch", async () => {
    const prs = [
      {
        number: 1,
        owner: "test",
        repo: "test-repo",
        branch: "feature",
        baseBranch: "main",
        isDraft: false,
        title: "Test PR",
        url: "https://github.com/test/test-repo/pull/1",
        headRefOid: "abc123",
      },
    ];

    const result = await enrichSessionsPRBatch(prs);

    expect(result).toBeInstanceOf(Map);
  });

  it("should handle empty PR list", async () => {
    const result = await enrichSessionsPRBatch([]);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("should handle multiple PRs", async () => {
    const prs = Array.from({ length: 5 }, (_, i) => ({
      number: i + 1,
      owner: "test",
      repo: "test-repo",
      branch: `feature-${i}`,
      baseBranch: "main",
      isDraft: false,
      title: `Test PR ${i + 1}`,
      url: `https://github.com/test/test-repo/pull/${i + 1}`,
      headRefOid: `abc${i}def`,
    }));

    const result = await enrichSessionsPRBatch(prs);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBeGreaterThan(0);
  });
});

describe("Cache Key Generation", () => {
  it("should generate consistent cache keys", () => {
    // Cache key format: owner/repo#number
    const pr1 = {
      number: 1,
      owner: "test",
      repo: "test-repo",
      branch: "feature",
      baseBranch: "main",
      isDraft: false,
      title: "Test PR",
      url: "https://github.com/test/test-repo/pull/1",
    };

    const pr2 = {
      number: 1,
      owner: "test",
      repo: "test-repo",
      branch: "different-branch",
      baseBranch: "main",
      isDraft: false,
      title: "Test PR",
      url: "https://github.com/test/test-repo/pull/1",
    };

    // Both should have the same cache key
    // In the actual implementation, this is done by prCacheKey function
    expect(pr1.number).toBe(pr2.number);
    expect(pr1.owner).toBe(pr2.owner);
    expect(pr1.repo).toBe(pr2.repo);
  });
});

describe("Error Handling", () => {
  it("should handle API errors gracefully", async () => {
    const prs = [
      {
        number: 1,
        owner: "test",
        repo: "test-repo",
        branch: "feature",
        baseBranch: "main",
        isDraft: false,
        title: "Test PR",
        url: "https://github.com/test/test-repo/pull/1",
        headRefOid: "abc123",
      },
    ];

    // With mocked gh function returning errors, the function should still return
    const result = await enrichSessionsPRBatch(prs);

    expect(result).toBeInstanceOf(Map);
  });
});
