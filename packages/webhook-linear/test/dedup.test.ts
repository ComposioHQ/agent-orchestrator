import { describe, it, expect, beforeEach, vi } from "vitest";
import { wasRecentlySpawned, markSpawned, cleanup, reset, entries } from "../src/dedup.js";

beforeEach(() => {
  reset();
});

describe("wasRecentlySpawned", () => {
  it("returns false for an unknown issue", () => {
    expect(wasRecentlySpawned("ENG-123", "code")).toBe(false);
  });

  it("returns true after markSpawned", () => {
    markSpawned("ENG-123", "code");
    expect(wasRecentlySpawned("ENG-123", "code")).toBe(true);
  });

  it("different spawn types are tracked independently", () => {
    markSpawned("ENG-123", "code");
    expect(wasRecentlySpawned("ENG-123", "code")).toBe(true);
    expect(wasRecentlySpawned("ENG-123", "test-gen")).toBe(false);
  });

  it("returns false for expired entries", () => {
    // Mock Date.now to simulate time passing beyond 5 min window
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 6 * 60 * 1000);

    markSpawned("ENG-456", "code");
    expect(wasRecentlySpawned("ENG-456", "code")).toBe(false);

    vi.restoreAllMocks();
  });
});

describe("cleanup", () => {
  it("removes expired entries", () => {
    const now = Date.now();
    // Manually insert by using markSpawned at "now", then advance time
    markSpawned("ENG-789", "code");
    markSpawned("ENG-790", "test-gen");

    // Advance time past dedup window for cleanup
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);

    expect(entries().size).toBe(2);
    cleanup();
    expect(entries().size).toBe(0);

    vi.restoreAllMocks();
  });

  it("keeps entries that are still within the window", () => {
    markSpawned("ENG-791", "code");
    cleanup();
    // cleanup with real time — entry should still be present
    expect(wasRecentlySpawned("ENG-791", "code")).toBe(true);
  });
});
