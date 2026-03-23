import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GhCache } from "./cache.js";

describe("GhCache", () => {
  let cache: GhCache;

  beforeEach(() => {
    cache = new GhCache();
  });

  afterEach(() => {
    cache.clear();
  });

  describe("key()", () => {
    it("generates consistent keys from arguments", () => {
      expect(cache.key(["pr", "view", "123"])).toBe("gh:pr:view:123");
      expect(cache.key(["api", "repos", "owner/repo/pulls/123"])).toBe(
        "gh:api:repos:owner/repo/pulls/123",
      );
      expect(
        cache.key(["pr", "view", "123", "--repo", "owner/repo", "--json", "state,title"]),
      ).toBe("gh:pr:view:123:--repo:owner/repo:--json:state,title");
    });

    it("handles empty arguments", () => {
      expect(cache.key([])).toBe("gh:");
    });
  });

  describe("getTTL()", () => {
    it("returns appropriate TTL for different operations", () => {
      expect(cache.getTTL(["pr", "checks", "123"])).toBe(15_000);
      expect(cache.getTTL(["pr", "view", "123"])).toBe(30_000);
      expect(cache.getTTL(["api", "repos/..."])).toBe(30_000);
      expect(cache.getTTL(["pr", "list"])).toBe(30_000);
      expect(cache.getTTL(["unknown", "command"])).toBe(30_000);
    });

    it("uses default TTL for unknown commands", () => {
      expect(cache.getTTL(["unknown"])).toBe(30_000);
      expect(cache.getTTL(["pr", "unknown"])).toBe(30_000);
    });

    it("uses default TTL for api/graphql (reviewDecision, comments endpoints)", () => {
      // GraphQL calls for reviewDecision and comments use default TTL
      expect(cache.getTTL(["api", "graphql"])).toBe(30_000);
    });
  });

  describe("get() and set()", () => {
    it("stores and retrieves values", () => {
      cache.set("key1", "value1", 60_000);
      expect(cache.get("key1")).toBe("value1");
    });

    it("returns null for non-existent keys", () => {
      expect(cache.get("nonexistent")).toBeNull();
    });

    it("stores and retrieves complex objects", () => {
      const complexValue = { nested: { data: [1, 2, 3] }, text: "hello" };
      cache.set("complex", complexValue, 60_000);
      expect(cache.get("complex")).toEqual(complexValue);
    });

    it("evicts expired entries", async () => {
      cache.set("expired", "value", 1); // 1ms TTL
      expect(cache.get("expired")).toBe("value"); // Still valid

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cache.get("expired")).toBeNull(); // Now expired
    });

    it("overwrites existing values with same key", () => {
      cache.set("key", "first", 60_000);
      cache.set("key", "second", 60_000);
      expect(cache.get("key")).toBe("second");
    });
  });

  describe("dedupe()", () => {
    it("returns cached promise for concurrent requests", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return "result";
      };

      // Launch concurrent requests
      const [r1, r2, r3] = await Promise.all([
        cache.dedupe("key", fn),
        cache.dedupe("key", fn),
        cache.dedupe("key", fn),
      ]);

      expect(r1).toBe("result");
      expect(r2).toBe("result");
      expect(r3).toBe("result");
      expect(callCount).toBe(1); // Only one execution
    });

    it("allows new requests after completion", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return `result-${callCount}`;
      };

      const r1 = await cache.dedupe("key", fn);
      expect(r1).toBe("result-1");

      const r2 = await cache.dedupe("key", fn);
      expect(r2).toBe("result-2");

      expect(callCount).toBe(2);
    });

    it("cleans up pending request after completion", async () => {
      const fn = async () => "result";
      await cache.dedupe("key", fn);

      expect(cache.getStats().pending).toBe(0);
    });

    it("cleans up pending request after rejection", async () => {
      const fn = async () => {
        throw new Error("failed");
      };

      await expect(cache.dedupe("key", fn)).rejects.toThrow("failed");
      expect(cache.getStats().pending).toBe(0);
    });

    it("handles multiple different keys concurrently", async () => {
      const calls = new Map<string, number>();
      const fn = (key: string) => async () => {
        calls.set(key, (calls.get(key) ?? 0) + 1);
        return `result-${key}`;
      };

      const [r1, r2, r3] = await Promise.all([
        cache.dedupe("key1", fn("key1")),
        cache.dedupe("key2", fn("key2")),
        cache.dedupe("key3", fn("key3")),
      ]);

      expect(r1).toBe("result-key1");
      expect(r2).toBe("result-key2");
      expect(r3).toBe("result-key3");
      expect(calls.get("key1")).toBe(1);
      expect(calls.get("key2")).toBe(1);
      expect(calls.get("key3")).toBe(1);
    });
  });

  describe("invalidatePR()", () => {
    it("removes all cache entries for a specific PR", () => {
      // Generate keys using cache.key() to match production behavior
      const pr123ViewKey = cache.key(["pr", "view", "123", "--repo", "owner/repo", "--json", "state"]);
      const pr123ChecksKey = cache.key(["pr", "checks", "123", "--repo", "owner/repo"]);
      const pr456ViewKey = cache.key(["pr", "view", "456", "--repo", "owner/repo", "--json", "state"]);
      const differentPr123ViewKey = cache.key(["pr", "view", "123", "--repo", "different/repo", "--json", "state"]);

      cache.set(pr123ViewKey, "data1", 60_000);
      cache.set(pr123ChecksKey, "data2", 60_000);
      cache.set(pr456ViewKey, "data3", 60_000);
      cache.set(differentPr123ViewKey, "data4", 60_000);

      cache.invalidatePR({ owner: "owner", repo: "repo", number: 123 });

      expect(cache.get(pr123ViewKey)).toBeNull();
      expect(cache.get(pr123ChecksKey)).toBeNull();
      expect(cache.get(pr456ViewKey)).toBe("data3");
      expect(cache.get(differentPr123ViewKey)).toBe("data4");
    });

    it("removes GraphQL and REST API entries for the same PR", () => {
      // GraphQL query key (includes number=123)
      const graphqlKey = cache.key([
        "api",
        "graphql",
        "-f",
        "owner=owner",
        "-f",
        "name=repo",
        "-F",
        "number=123",
        "-f",
        "query=some query",
      ]);
      // REST API key (includes pulls/123/)
      const restKey = cache.key(["api", "--method", "GET", "repos/owner/repo/pulls/123/comments"]);

      cache.set(graphqlKey, "graphqlData", 60_000);
      cache.set(restKey, "restData", 60_000);

      cache.invalidatePR({ owner: "owner", repo: "repo", number: 123 });

      expect(cache.get(graphqlKey)).toBeNull();
      expect(cache.get(restKey)).toBeNull();
    });

    it("does not affect cache if no matching entries", () => {
      const unrelatedKey = cache.key(["api", "repos", "other/owner", "issues"]);
      cache.set(unrelatedKey, "data", 60_000);
      cache.invalidatePR({ owner: "owner", repo: "repo", number: 123 });

      expect(cache.get(unrelatedKey)).toBe("data");
    });
  });

  describe("invalidateRepo()", () => {
    it("removes all cache entries for a specific repository", () => {
      // Generate keys using cache.key() to match production behavior
      const ownerRepoPr123ViewKey = cache.key(["pr", "view", "123", "--repo", "owner/repo", "--json", "state"]);
      const ownerRepoPr456ChecksKey = cache.key(["pr", "checks", "456", "--repo", "owner/repo"]);
      const otherRepoPr123ViewKey = cache.key(["pr", "view", "123", "--repo", "other/repo", "--json", "state"]);

      cache.set(ownerRepoPr123ViewKey, "data1", 60_000);
      cache.set(ownerRepoPr456ChecksKey, "data2", 60_000);
      cache.set(otherRepoPr123ViewKey, "data3", 60_000);

      cache.invalidateRepo("owner", "repo");

      expect(cache.get(ownerRepoPr123ViewKey)).toBeNull();
      expect(cache.get(ownerRepoPr456ChecksKey)).toBeNull();
      expect(cache.get(otherRepoPr123ViewKey)).toBe("data3");
    });

    it("removes REST API entries for a specific repository", () => {
      const restKey = cache.key(["api", "--method", "GET", "repos/owner/repo/pulls/123/comments"]);

      cache.set(restKey, "data", 60_000);

      cache.invalidateRepo("owner", "repo");

      expect(cache.get(restKey)).toBeNull();
    });
  });

  describe("getStats()", () => {
    it("returns current cache statistics", () => {
      cache.set("key1", "value1", 60_000);
      cache.set("key2", "value2", 60_000);

      expect(cache.getStats().size).toBe(2);
      expect(cache.getStats().pending).toBe(0);
    });

    it("updates stats as entries are added and removed", async () => {
      cache.set("key1", "value1", 60_000);
      expect(cache.getStats().size).toBe(1);

      cache.set("key2", "value2", 60_000);
      expect(cache.getStats().size).toBe(2);

      // Simulate expiration
      cache.set("key3", "value3", 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      cache.get("key3"); // This will delete expired entry
      expect(cache.getStats().size).toBe(2);
    });

    it("tracks pending requests", async () => {
      const fn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "result";
      };

      const promise = cache.dedupe("key", fn);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cache.getStats().pending).toBe(1);

      await promise;
      expect(cache.getStats().pending).toBe(0);
    });
  });

  describe("clear()", () => {
    it("removes all cache entries", () => {
      cache.set("key1", "value1", 60_000);
      cache.set("key2", "value2", 60_000);

      cache.clear();

      expect(cache.getStats().size).toBe(0);
      expect(cache.get("key1")).toBeNull();
      expect(cache.get("key2")).toBeNull();
    });

    it("clears pending requests", async () => {
      const fn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "result";
      };

      cache.dedupe("key", fn);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cache.getStats().pending).toBe(1);

      cache.clear();
      expect(cache.getStats().pending).toBe(0);
    });
  });

  describe("integration scenarios", () => {
    it("simulates real-world caching pattern", async () => {
      let apiCalls = 0;
      const mockFetch = async (pr: number) => {
        apiCalls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return JSON.stringify({ number: pr, title: `PR ${pr}` });
      };

      // First request - should hit API
      const key1 = cache.key(["pr", "view", "123", "--repo", "owner/repo", "--json", "number,title"]);
      const result1 = await cache.dedupe(key1, () => mockFetch(123));
      expect(apiCalls).toBe(1);

      // Second request - should use cache
      cache.set(key1, result1, 30_000);
      const cached = cache.get(key1);
      expect(cached).toBe(result1);
      expect(apiCalls).toBe(1);

      // Invalidate and fetch again
      cache.invalidatePR({ owner: "owner", repo: "repo", number: 123 });
      expect(cache.get(key1)).toBeNull();

      const result2 = await cache.dedupe(key1, () => mockFetch(123));
      expect(apiCalls).toBe(2);
      expect(result2).toBe(result1);
    });

    it("handles concurrent requests for same PR data", async () => {
      const requests = [1, 2, 3, 4, 5];
      let callCount = 0;

      const fetchData = async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return JSON.stringify({ state: "open", title: "Test PR" });
      };

      const results = await Promise.all(
        requests.map(() => {
          const key = cache.key(["pr", "view", "123", "--json", "state,title"]);
          return cache.dedupe(key, fetchData);
        }),
      );

      expect(callCount).toBe(1);
      expect(results).toHaveLength(5);
      results.forEach((r: string) => expect(r).toBe('{"state":"open","title":"Test PR"}'));
    });
  });
});
