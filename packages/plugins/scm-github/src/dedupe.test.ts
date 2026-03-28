import { describe, it, expect, vi, beforeEach } from "vitest";
import { RequestDeduplicator, ghDeduplicator } from "./dedupe.js";

describe("RequestDeduplicator", () => {
  beforeEach(() => {
    // Clear pending requests before each test
    const deduplicator = new RequestDeduplicator();
    (deduplicator as any).pendingRequests.clear();
  });

  it("should dedupe concurrent identical requests", async () => {
    const deduplicator = new RequestDeduplicator();
    const mockFn = vi.fn().mockResolvedValue("result");
    
    // Make 3 concurrent calls
    const promises = [
      deduplicator.dedupe(["a", "b"], () => mockFn()),
      deduplicator.dedupe(["a", "b"], () => mockFn()),
      deduplicator.dedupe(["a", "b"], () => mockFn()),
    ];

    await Promise.all(promises);

    // Only one actual call should have been made
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it("should not dedupe different requests", async () => {
    const deduplicator = new RequestDeduplicator();
    const mockFn1 = vi.fn().mockResolvedValue("result1");
    const mockFn2 = vi.fn().mockResolvedValue("result2");
    
    await Promise.all([
      deduplicator.dedupe(["a", "b"], () => mockFn1()),
      deduplicator.dedupe(["a", "c"], () => mockFn2()),
    ]);

    expect(mockFn1).toHaveBeenCalledTimes(1);
    expect(mockFn2).toHaveBeenCalledTimes(1);
  });

  it("should clean up pending requests after completion", async () => {
    const deduplicator = new RequestDeduplicator();
    const mockFn = vi.fn().mockResolvedValue("result");
    
    await deduplicator.dedupe(["test"], () => mockFn());
    
    const pending = (deduplicator as any).pendingRequests;
    expect(pending.size).toBe(0);
  });

  it("should handle errors properly", async () => {
    const deduplicator = new RequestDeduplicator();
    const mockError = new Error("test error");
    const mockFn = vi.fn().mockRejectedValue(mockError);
    
    await expect(deduplicator.dedupe(["fail"], () => mockFn())).rejects.toThrow("test error");
    
    // Error should still clean up pending requests
    const pending = (deduplicator as any).pendingRequests;
    expect(pending.size).toBe(0);
  });

  it("should avoid key collision with args containing ':'", async () => {
    const deduplicator = new RequestDeduplicator();
    const mockFn1 = vi.fn().mockResolvedValue("result1");
    const mockFn2 = vi.fn().mockResolvedValue("result2");
    
    // These should not collide even though they contain ":"
    // ["a:b", "c"] and ["a", "b:c"] are different commands
    await Promise.all([
      deduplicator.dedupe(["a:b", "c"], () => mockFn1()),
      deduplicator.dedupe(["a", "b:c"], () => mockFn2()),
    ]);

    expect(mockFn1).toHaveBeenCalledTimes(1);
    expect(mockFn2).toHaveBeenCalledTimes(1);
  });

  it("should handle sequential calls properly", async () => {
    const deduplicator = new RequestDeduplicator();
    const mockFn = vi.fn()
      .mockResolvedValueOnce("result1")
      .mockResolvedValueOnce("result2");
    
    const result1 = await deduplicator.dedupe(["test"], () => mockFn());
    const result2 = await deduplicator.dedupe(["test"], () => mockFn());

    expect(result1).toBe("result1");
    expect(result2).toBe("result2");
    expect(mockFn).toHaveBeenCalledTimes(2);
  });
});

describe("ghDeduplicator", () => {
  it("should be a singleton instance", () => {
    const deduper1 = ghDeduplicator;
    const deduper2 = ghDeduplicator;
    
    expect(deduper1).toBe(deduper2);
  });

  it("should have the dedupe method", () => {
    expect(typeof ghDeduplicator.dedupe).toBe("function");
  });
});
