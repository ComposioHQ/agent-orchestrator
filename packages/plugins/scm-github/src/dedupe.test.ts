import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RequestDeduplicator, ghDeduplicator } from "./dedupe.js";

describe("RequestDeduplicator", () => {
  let deduper: RequestDeduplicator;

  beforeEach(() => {
    deduper = new RequestDeduplicator();
  });

  afterEach(() => {
    deduper.clear();
  });

  describe("key()", () => {
    it("generates consistent keys from arguments", () => {
      expect(deduper.key(["pr", "view", "123"])).toBe("gh:pr:view:123");
      expect(deduper.key(["api", "repos", "owner/repo/pulls/123"]))
        .toBe("gh:api:repos:owner/repo/pulls/123");
    });

    it("handles arguments with special characters", () => {
      expect(deduper.key(["pr", "view", "owner/repo#123"]))
        .toBe("gh:pr:view:owner/repo#123");
    });
  });

  describe("dedupe()", () => {
    it("returns cached promise for concurrent requests", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "result";
      };

      // Launch concurrent requests
      const [r1, r2, r3] = await Promise.all([
        deduper.dedupe("key", fn),
        deduper.dedupe("key", fn),
        deduper.dedupe("key", fn),
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

      const r1 = await deduper.dedupe("key", fn);
      expect(r1).toBe("result-1");

      const r2 = await deduper.dedupe("key", fn);
      expect(r2).toBe("result-2");

      expect(callCount).toBe(2);
    });

    it("cleans up pending request after completion", async () => {
      const fn = async () => "result";
      await deduper.dedupe("key", fn);

      expect(deduper.getStats().pending).toBe(0);
    });

    it("handles rejection and cleans up", async () => {
      const fn = async () => {
        throw new Error("test error");
      };

      await expect(deduper.dedupe("key", fn)).rejects.toThrow("test error");
      expect(deduper.getStats().pending).toBe(0);
    });

    it("shares rejection for concurrent requests", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        throw new Error("test error");
      };

      const results = await Promise.allSettled([
        deduper.dedupe("key", fn),
        deduper.dedupe("key", fn),
        deduper.dedupe("key", fn),
      ]);

      expect(callCount).toBe(1); // Only one execution
      expect(results.every((r) => r.status === "rejected")).toBe(true);
    });

    it("handles different keys independently", async () => {
      let callCount = 0;
      const fn = async (key: string) => {
        callCount++;
        return `result-${key}`;
      };

      const [r1, r2, r3] = await Promise.all([
        deduper.dedupe("key1", () => fn("key1")),
        deduper.dedupe("key2", () => fn("key2")),
        deduper.dedupe("key3", () => fn("key3")),
      ]);

      expect(r1).toBe("result-key1");
      expect(r2).toBe("result-key2");
      expect(r3).toBe("result-key3");
      expect(callCount).toBe(3); // All three executed
    });
  });

  describe("getStats()", () => {
    it("returns current statistics", async () => {
      const fn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "result";
      };

      // Start a request but don't await it
      const promise = deduper.dedupe("key", fn);
      expect(deduper.getStats().pending).toBe(1);

      await promise;
      expect(deduper.getStats().pending).toBe(0);
    });

    it("tracks multiple concurrent requests", async () => {
      const fn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "result";
      };

      const promises = [
        deduper.dedupe("key1", fn),
        deduper.dedupe("key2", fn),
        deduper.dedupe("key3", fn),
      ];

      expect(deduper.getStats().pending).toBe(3);

      await Promise.all(promises);
      expect(deduper.getStats().pending).toBe(0);
    });
  });

  describe("clear()", () => {
    it("clears all pending requests", async () => {
      const fn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "result";
      };

      const promise = deduper.dedupe("key", fn);
      expect(deduper.getStats().pending).toBe(1);

      deduper.clear();
      expect(deduper.getStats().pending).toBe(0);

      // The existing promise should still resolve
      await expect(promise).resolves.toBe("result");
    });
  });

  describe("ghDeduplicator global instance", () => {
    it("is a singleton instance", () => {
      expect(ghDeduplicator).toBeInstanceOf(RequestDeduplicator);
    });

    it("shares state across all uses", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return "result";
      };

      const key = "test:shared:key";
      const [r1, r2] = await Promise.all([
        ghDeduplicator.dedupe(key, fn),
        ghDeduplicator.dedupe(key, fn),
      ]);

      expect(r1).toBe("result");
      expect(r2).toBe("result");
      expect(callCount).toBe(1);
    });
  });
});
