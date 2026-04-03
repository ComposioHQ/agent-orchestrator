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

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-ctx-builder-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  vi.clearAllMocks();

  // Default: execFile calls back with empty stdout
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

  it("includes PR info", async () => {
    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "work done", pr: "https://github.com/org/repo/pull/42" },
      tmpDir,
    );
    expect(result).toContain("https://github.com/org/repo/pull/42");
    expect(result).toContain("Check its status");
  });

  it("includes git commits when available", async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb?: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cb) cb(null, "abc1234 Fix login\ndef5678 Add tests\n", "");
      },
    );

    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "work", branch: "feat/test" },
      tmpDir,
    );
    expect(result).toContain("### Commits Made");
    expect(result).toContain("- abc1234 Fix login");
    expect(result).toContain("- def5678 Add tests");
  });

  it("handles git failure gracefully (best effort)", async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb?: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cb) cb(new Error("git failed"), "", "");
      },
    );

    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "Fixed auth", branch: "feat/test" },
      tmpDir,
    );
    // Should still return context from summary, just no commits
    expect(result).toContain("### Agent Summary");
    expect(result).not.toContain("### Commits Made");
  });

  it("skips commits section when workspace path does not exist", async () => {
    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "work", branch: "feat/test" },
      "/nonexistent/path",
    );
    expect(result).toContain("### Agent Summary");
    expect(result).not.toContain("### Commits Made");
  });

  it("truncates commits to 20", async () => {
    const commits = Array.from(
      { length: 30 },
      (_, i) => `${String(i).padStart(7, "0")} Commit ${i}`,
    );
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb?: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cb) cb(null, commits.join("\n") + "\n", "");
      },
    );

    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "work", branch: "feat/test" },
      tmpDir,
    );
    expect(result).toContain("### Commits Made");
    const commitLines = result!.split("\n").filter((l: string) => l.startsWith("- "));
    expect(commitLines.length).toBeLessThanOrEqual(20);
  });

  it("always includes instructions when context is returned", async () => {
    const result = await buildPreviousSessionContext(
      { status: "killed", summary: "Fixed auth" },
      tmpDir,
    );
    expect(result).toContain("Do NOT start over from scratch");
  });

  it("includes all sections when everything is present", async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb?: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cb) cb(null, "abc1234 Fix login\n", "");
      },
    );

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
});
