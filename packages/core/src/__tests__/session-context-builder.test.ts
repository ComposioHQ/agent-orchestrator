import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Mock child_process with custom promisify support (same pattern as session-manager tests)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecFile = vi.fn() as any;
mockExecFile[Symbol.for("nodejs.util.promisify.custom")] = (...args: unknown[]) => {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile(...args, (error: any, stdout: string, stderr: string) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
};

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// Must import after mocking
const { buildPreviousSessionContext } = await import("../session-context-builder.js");

let tmpDir: string;

/**
 * Helper: mock git responses for rev-parse (current branch) and log (commits).
 * `currentBranch` defaults to "main" (different from the feature branch).
 */
function mockGitResponses(opts: {
  currentBranch?: string;
  commits?: string;
  failLog?: boolean;
}) {
  const { currentBranch = "main", commits = "", failLog = false } = opts;
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (!cb) return;
      // rev-parse --abbrev-ref HEAD
      if (args.includes("rev-parse")) {
        cb(null, `${currentBranch}\n`, "");
        return;
      }
      // git log
      if (args.includes("log")) {
        if (failLog) {
          cb(new Error("git log failed"), "", "");
        } else {
          cb(null, commits, "");
        }
        return;
      }
      cb(null, "", "");
    },
  );
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-ctx-builder-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  vi.clearAllMocks();

  // Default: all git commands return empty
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (cb) cb(null, "", "");
    },
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildPreviousSessionContext", () => {
  it("returns null when no meaningful context exists (no summary, no PR)", async () => {
    const result = await buildPreviousSessionContext({ status: "killed" }, tmpDir);
    expect(result).toBeNull();
  });

  it("includes status in output", async () => {
    const result = await buildPreviousSessionContext(
      { status: "errored", summary: "Fixed auth logic" },
      tmpDir,
    );
    expect(result).toContain("ended with status: errored");
  });

  it("defaults missing status to unknown", async () => {
    const result = await buildPreviousSessionContext({ summary: "Did some work" }, tmpDir);
    expect(result).toContain("ended with status: unknown");
  });

  it("includes agent summary", async () => {
    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "Fixed authentication module" },
      tmpDir,
    );
    expect(result).toContain("### Agent Summary");
    expect(result).toContain("Fixed authentication module");
  });

  it("truncates agent summary to 500 chars", async () => {
    const longSummary = "A".repeat(600);
    const result = await buildPreviousSessionContext(
      { status: "killed", summary: longSummary },
      tmpDir,
    );
    expect(result).toContain("### Agent Summary");
    expect(result).not.toContain("A".repeat(600));
    expect(result).toContain("...");
  });

  it("includes PR info", async () => {
    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "work done", pr: "https://github.com/org/repo/pull/42" },
      tmpDir,
    );
    expect(result).toContain("https://github.com/org/repo/pull/42");
    expect(result).toContain("Check its status");
  });

  it("includes git commits when on a different branch", async () => {
    mockGitResponses({
      currentBranch: "main",
      commits: "abc1234 Fix login\ndef5678 Add tests\n",
    });

    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "work", branch: "feat/test" },
      tmpDir,
    );
    expect(result).toContain("### Commits Made");
    expect(result).toContain("- abc1234 Fix login");
    expect(result).toContain("- def5678 Add tests");
  });

  it("shows 'existing commits' message when on the same branch (Gap 4)", async () => {
    mockGitResponses({
      currentBranch: "feat/test",
      commits: "abc1234 Fix login\ndef5678 Add tests\n",
    });

    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "work", branch: "feat/test" },
      tmpDir,
    );
    expect(result).not.toContain("### Commits Made");
    expect(result).toContain("2 existing commit(s) from a previous attempt");
    expect(result).toContain("git log");
  });

  it("uses the provided defaultBranch instead of hardcoded main", async () => {
    mockGitResponses({ commits: "abc1234 Fix login\n" });

    await buildPreviousSessionContext(
      { status: "killed", summary: "work", branch: "feat/test" },
      tmpDir,
      "develop",
    );

    // Find the git log call (not the rev-parse call)
    const logCall = mockExecFile.mock.calls.find(
      (c: string[][]) => c[1] && c[1].includes("log"),
    );
    expect(logCall).toBeDefined();
    const gitArgs = logCall[1] as string[];
    expect(gitArgs).toContain("origin/develop");
    expect(gitArgs).not.toContain("origin/main");
  });

  it("defaults to origin/main when no defaultBranch is provided", async () => {
    mockGitResponses({ commits: "abc1234 Fix login\n" });

    await buildPreviousSessionContext(
      { status: "killed", summary: "work", branch: "feat/test" },
      tmpDir,
    );

    const logCall = mockExecFile.mock.calls.find(
      (c: string[][]) => c[1] && c[1].includes("log"),
    );
    expect(logCall).toBeDefined();
    const gitArgs = logCall[1] as string[];
    expect(gitArgs).toContain("origin/main");
  });

  it("handles git failure gracefully (best effort)", async () => {
    mockGitResponses({ failLog: true });

    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "Fixed auth", branch: "feat/test" },
      tmpDir,
    );
    expect(result).toContain("### Agent Summary");
    expect(result).not.toContain("### Commits Made");
    expect(result).not.toContain("existing commit");
  });

  it("skips commits section when workspace path does not exist", async () => {
    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "work", branch: "feat/test" },
      "/nonexistent/path",
    );
    expect(result).toContain("### Agent Summary");
    expect(result).not.toContain("### Commits Made");
  });

  it("truncates commits to 10 and shows overflow count", async () => {
    const commits = Array.from(
      { length: 15 },
      (_, i) => `${String(i).padStart(7, "0")} Commit ${i}`,
    );
    mockGitResponses({ commits: commits.join("\n") + "\n" });

    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "work", branch: "feat/test" },
      tmpDir,
    );
    expect(result).toContain("### Commits Made");
    const commitLines = result!.split("\n").filter((l: string) => l.startsWith("- "));
    expect(commitLines.length).toBeLessThanOrEqual(10);
    expect(result).toContain("more commits not shown");
  });

  it("always includes instructions when context is returned", async () => {
    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "Fixed auth" },
      tmpDir,
    );
    expect(result).toContain("Do NOT start over from scratch");
  });

  it("includes all sections when everything is present", async () => {
    mockGitResponses({ commits: "abc1234 Fix login\n" });

    const result = await buildPreviousSessionContext(
      {
        status: "errored",
        summary: "Worked on auth",
        pr: "https://github.com/org/repo/pull/42",
        branch: "feat/test",
      },
      tmpDir,
    );
    expect(result).toContain("ended with status: errored");
    expect(result).toContain("### Agent Summary");
    expect(result).toContain("### Commits Made");
    expect(result).toContain("pull/42");
    expect(result).toContain("Do NOT start over from scratch");
  });

  it("returns context when only PR is present (no summary)", async () => {
    const result = await buildPreviousSessionContext(
      { status: "killed", pr: "https://github.com/org/repo/pull/42" },
      tmpDir,
    );
    expect(result).not.toBeNull();
    expect(result).toContain("pull/42");
  });

  // Gap 5: done sessions get different language
  it("uses completion language for done sessions", async () => {
    const result = await buildPreviousSessionContext(
      { status: "done", summary: "Completed the task", pr: "https://github.com/org/repo/pull/42" },
      tmpDir,
    );
    expect(result).toContain("completed normally");
    expect(result).not.toContain("ended with status");
    expect(result).toContain("Check for review feedback");
    expect(result).toContain("Do not redo work");
  });

  it("uses different PR language for done sessions", async () => {
    const result = await buildPreviousSessionContext(
      { status: "done", summary: "Done", pr: "https://github.com/org/repo/pull/42" },
      tmpDir,
    );
    expect(result).toContain("Check for review feedback");
    expect(result).not.toContain("Check its status and review comments before continuing");
  });
});
