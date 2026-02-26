import { describe, expect, it, vi } from "vitest";
import { MergeStewardService } from "../merge-steward.js";

describe("MergeStewardService", () => {
  it("runs test then squash merge in temp worktree and pushes", async () => {
    const exec = vi.fn(async () => {});
    const service = new MergeStewardService(exec);

    const result = await service.testThenMerge({
      repoPath: "/repo",
      sourceBranch: "feature/test",
      targetBranch: "main",
      testCommand: "pnpm test",
      mergeMethod: "squash",
    });

    expect(result.merged).toBe(true);
    expect(exec).toHaveBeenCalledWith("git", ["-C", "/repo", "fetch", "origin"]);
    const calls = exec.mock.calls as unknown[][];
    expect(
      calls.some(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as string[]).includes("worktree") &&
          (call[1] as string[]).includes("add"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as string[]).includes("merge") &&
          (call[1] as string[]).includes("--squash"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) => Array.isArray(call[1]) && (call[1] as string[]).includes("push"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as string[]).includes("worktree") &&
          (call[1] as string[]).includes("remove"),
      ),
    ).toBe(true);
  });

  it("always removes temp worktree even when tests fail", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "-lc" && args[1] === "pnpm test") {
        throw new Error("tests failed");
      }
    });
    const service = new MergeStewardService(exec);

    await expect(
      service.testThenMerge({
        repoPath: "/repo",
        sourceBranch: "feature/test",
        targetBranch: "main",
        testCommand: "pnpm test",
      }),
    ).rejects.toThrow("tests failed");

    const calls = exec.mock.calls as unknown[][];
    const removeCall = calls.find(
      (call) => Array.isArray(call[1]) && (call[1] as string[]).includes("remove"),
    );
    expect(removeCall).toBeDefined();
  });
});
