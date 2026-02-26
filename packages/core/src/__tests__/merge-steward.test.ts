import { describe, expect, it, vi } from "vitest";
import { MergeStewardService } from "../merge-steward.js";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

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
    expect(calls.some((call) => Array.isArray(call[1]) && (call[1] as string[]).includes("--squash"))).toBe(true);
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
    expect(
      calls.some(
        (call) =>
          Array.isArray(call[1]) &&
          (call[1] as string[]).includes("merge-tree") &&
          (call[1] as string[]).includes("origin/feature/test"),
      ),
    ).toBe(true);
  });

  it("runs test command without shell wrapping", async () => {
    const exec = vi.fn(async () => {});
    const service = new MergeStewardService(exec);

    await service.testThenMerge({
      repoPath: "/repo",
      sourceBranch: "feature/test",
      targetBranch: "main",
      testCommand: "pnpm test",
    });

    expect(exec).toHaveBeenCalledWith("pnpm", ["test"], expect.any(String));
    const calls = exec.mock.calls as unknown[][];
    expect(calls.some((call) => call[0] === "sh")).toBe(false);
  });

  it("always removes temp worktree even when tests fail", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (_cmd === "pnpm" && args[0] === "test") {
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

  it("preserves original error when worktree add fails", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes("add")) {
        throw new Error("worktree add failed");
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
    ).rejects.toThrow("worktree add failed");

    const calls = exec.mock.calls as unknown[][];
    expect(
      calls.some(
        (call) => Array.isArray(call[1]) && (call[1] as string[]).includes("remove"),
      ),
    ).toBe(false);
  });

  it("removes temp directory when test command parsing fails", async () => {
    const beforeEntries = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("ao-merge-steward-")),
    );
    const service = new MergeStewardService(vi.fn(async () => {}));

    await expect(
      service.testThenMerge({
        repoPath: "/repo",
        sourceBranch: "feature/test",
        targetBranch: "main",
        testCommand: "\"unterminated",
      }),
    ).rejects.toThrow("Invalid test command");

    const afterEntries = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("ao-merge-steward-"),
    );
    const leaked = afterEntries.filter((name) => !beforeEntries.has(name));
    expect(leaked).toEqual([]);
  });

  it("uses origin/<sourceBranch> for merge method in detached worktree", async () => {
    const exec = vi.fn(async () => {});
    const service = new MergeStewardService(exec);

    await service.testThenMerge({
      repoPath: "/repo",
      sourceBranch: "feature/remote-only",
      targetBranch: "main",
      testCommand: "pnpm test",
      mergeMethod: "merge",
    });

    const calls = exec.mock.calls as unknown[][];
    expect(
      calls.some(
        (call) =>
          call[0] === "git" &&
          Array.isArray(call[1]) &&
          (call[1] as string[]).includes("merge") &&
          (call[1] as string[]).includes("--no-ff") &&
          (call[1] as string[]).includes("origin/feature/remote-only"),
      ),
    ).toBe(true);
  });

  it("reports cleanup failure alongside primary failure", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (_cmd === "pnpm" && args[0] === "test") {
        throw new Error("tests failed");
      }
      if (_cmd === "git" && args.includes("worktree") && args.includes("remove")) {
        throw new Error("worktree remove failed");
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
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof AggregateError)) return false;
      const messages = error.errors.map((err) => (err instanceof Error ? err.message : String(err)));
      return messages.includes("tests failed") && messages.includes("worktree remove failed");
    });
  });
});
