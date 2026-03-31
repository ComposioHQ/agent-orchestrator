import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGit, mockGh } = vi.hoisted(() => ({
  mockGit: vi.fn(),
  mockGh: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  git: mockGit,
  gh: mockGh,
}));

import { detectDefaultBranch } from "../../src/lib/git-utils.js";

beforeEach(() => {
  mockGit.mockReset();
  mockGh.mockReset();
});

describe("detectDefaultBranch", () => {
  // --- Method 1: symbolic-ref ---

  it("returns branch from symbolic-ref when available", async () => {
    mockGit.mockResolvedValue("refs/remotes/origin/main");

    const result = await detectDefaultBranch("/test", "owner/repo");

    expect(result).toBe("main");
    expect(mockGit).toHaveBeenCalledWith(
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      "/test",
    );
  });

  it("parses branch name with slashes from symbolic-ref", async () => {
    mockGit.mockResolvedValue("refs/remotes/origin/release/v2");

    const result = await detectDefaultBranch("/test", "owner/repo");

    expect(result).toBe("release/v2");
  });

  it("returns 'master' from symbolic-ref when repo uses master", async () => {
    mockGit.mockResolvedValue("refs/remotes/origin/master");

    const result = await detectDefaultBranch("/test", null);

    expect(result).toBe("master");
  });

  // --- Method 2: GitHub API ---

  it("falls back to gh API when symbolic-ref fails", async () => {
    mockGit.mockResolvedValue(null); // symbolic-ref fails
    mockGh.mockResolvedValue("develop");

    const result = await detectDefaultBranch("/test", "owner/repo");

    expect(result).toBe("develop");
    expect(mockGh).toHaveBeenCalledWith([
      "repo",
      "view",
      "owner/repo",
      "--json",
      "defaultBranchRef",
      "-q",
      ".defaultBranchRef.name",
    ]);
  });

  it("skips gh API when ownerRepo is null", async () => {
    mockGit
      .mockResolvedValueOnce(null)  // symbolic-ref fails
      .mockResolvedValueOnce("yes") // origin/main exists
      .mockResolvedValue(null);

    const result = await detectDefaultBranch("/test", null);

    expect(result).toBe("main");
    expect(mockGh).not.toHaveBeenCalled();
  });

  it("skips gh API when symbolic-ref returns non-matching output", async () => {
    mockGit
      .mockResolvedValueOnce("some-garbage-output") // symbolic-ref returns non-matching
      .mockResolvedValueOnce(null); // gh api also fails, then check common branches
    mockGh.mockResolvedValue("main");

    const result = await detectDefaultBranch("/test", "owner/repo");

    expect(result).toBe("main");
  });

  // --- Method 3: Check common branch names ---

  it("falls back to checking common branch names when both methods fail", async () => {
    mockGit
      .mockResolvedValueOnce(null)  // symbolic-ref fails
      .mockResolvedValueOnce(null)  // origin/main doesn't exist
      .mockResolvedValueOnce("ok"); // origin/master exists
    mockGh.mockResolvedValue(null);  // gh API fails

    const result = await detectDefaultBranch("/test", "owner/repo");

    expect(result).toBe("master");
  });

  it("checks common branches in order: main, master, next, develop", async () => {
    mockGit.mockResolvedValue(null); // everything fails
    mockGh.mockResolvedValue(null);

    await detectDefaultBranch("/test", "owner/repo");

    // After symbolic-ref, it checks each common branch
    const gitCalls = mockGit.mock.calls;
    const revParseCalls = gitCalls.filter(
      (call: string[][]) => call[0][0] === "rev-parse" && call[0][1] === "--verify",
    );

    expect(revParseCalls).toEqual([
      [["rev-parse", "--verify", "origin/main"], "/test"],
      [["rev-parse", "--verify", "origin/master"], "/test"],
      [["rev-parse", "--verify", "origin/next"], "/test"],
      [["rev-parse", "--verify", "origin/develop"], "/test"],
    ]);
  });

  it("returns 'next' when origin/main and origin/master don't exist but origin/next does", async () => {
    mockGit
      .mockResolvedValueOnce(null)  // symbolic-ref fails
      .mockResolvedValueOnce(null)  // origin/main doesn't exist
      .mockResolvedValueOnce(null)  // origin/master doesn't exist
      .mockResolvedValueOnce("ok"); // origin/next exists
    mockGh.mockResolvedValue(null);

    const result = await detectDefaultBranch("/test", "owner/repo");

    expect(result).toBe("next");
  });

  // --- Ultimate fallback ---

  it("returns 'main' as ultimate fallback when all methods fail", async () => {
    mockGit.mockResolvedValue(null);
    mockGh.mockResolvedValue(null);

    const result = await detectDefaultBranch("/test", "owner/repo");

    expect(result).toBe("main");
  });

  it("returns 'main' as ultimate fallback with null ownerRepo", async () => {
    mockGit.mockResolvedValue(null);

    const result = await detectDefaultBranch("/test", null);

    expect(result).toBe("main");
    expect(mockGh).not.toHaveBeenCalled();
  });
});
