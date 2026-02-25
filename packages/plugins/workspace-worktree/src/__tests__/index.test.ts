import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectConfig, WorkspaceCreateConfig, WorkspaceInfo } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that uses the mocked modules
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  // Set custom promisify so `promisify(execFile)` returns { stdout, stderr }
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  symlinkSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as childProcess from "node:child_process";
import { existsSync, lstatSync, symlinkSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { create, manifest } from "../index.js";

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockExecFileAsync = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockLstatSync = lstatSync as ReturnType<typeof vi.fn>;
const mockSymlinkSync = symlinkSync as ReturnType<typeof vi.fn>;
const mockRmSync = rmSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockGitSuccess(stdout: string) {
  mockExecFileAsync.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

function mockGitError(message: string) {
  mockExecFileAsync.mockRejectedValueOnce(new Error(message));
}

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    name: "test-project",
    repo: "test/repo",
    path: "/repo/path",
    defaultBranch: "main",
    sessionPrefix: "test",
    ...overrides,
  };
}

function makeCreateConfig(overrides?: Partial<WorkspaceCreateConfig>): WorkspaceCreateConfig {
  return {
    projectId: "myproject",
    project: makeProject(),
    sessionId: "session-1",
    branch: "feat/TEST-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Tests
// ===========================================================================

describe("manifest", () => {
  it("has name 'worktree' and slot 'workspace'", () => {
    expect(manifest.name).toBe("worktree");
    expect(manifest.slot).toBe("workspace");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Workspace plugin: git worktrees");
  });
});

describe("create() factory", () => {
  it("uses ~/.worktrees as default base dir", async () => {
    const ws = create();

    // Mock: fetch, worktree add
    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/.worktrees/myproject/session-1");
  });

  it("uses custom worktreeDir from config", async () => {
    const ws = create({ worktreeDir: "/custom/worktrees" });

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/custom/worktrees/myproject/session-1");
  });

  it("expands tilde in custom worktreeDir", async () => {
    const ws = create({ worktreeDir: "~/custom-path" });

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/custom-path/myproject/session-1");
  });
});

describe("workspace.create()", () => {
  it("calls git fetch and git worktree add with correct args", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // worktree add

    await ws.create(makeCreateConfig());

    // First call: git fetch origin --quiet
    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["fetch", "origin", "--quiet"], {
      cwd: "/repo/path",
    });

    // Second call: git worktree add -b <branch> <path> <baseRef>
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "origin/main",
      ],
      { cwd: "/repo/path" },
    );
  });

  it("creates the project worktree directory", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // worktree add

    await ws.create(makeCreateConfig());

    expect(mockMkdirSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject", {
      recursive: true,
    });
  });

  it("continues when fetch fails (offline)", async () => {
    const ws = create();

    mockGitError("Could not resolve host"); // fetch fails
    mockGitSuccess(""); // worktree add succeeds

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/.worktrees/myproject/session-1");
  });

  it("handles branch already exists by adding worktree then checking out", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitError("already exists"); // worktree add -b fails
    mockGitSuccess(""); // worktree add (without -b)
    mockGitSuccess(""); // checkout

    const info = await ws.create(makeCreateConfig());

    // Third call: worktree add without -b
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "/mock-home/.worktrees/myproject/session-1", "origin/main"],
      { cwd: "/repo/path" },
    );

    // Fourth call: checkout
    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["checkout", "feat/TEST-1"], {
      cwd: "/mock-home/.worktrees/myproject/session-1",
    });

    expect(info.branch).toBe("feat/TEST-1");
  });

  it("cleans up worktree on checkout failure", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitError("already exists"); // worktree add -b fails
    mockGitSuccess(""); // worktree add (without -b)
    mockGitError("checkout failed: conflict"); // checkout fails
    mockGitSuccess(""); // worktree remove (cleanup)

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      'Failed to checkout branch "feat/TEST-1" in worktree: checkout failed: conflict',
    );

    // Verify cleanup was attempted
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/mock-home/.worktrees/myproject/session-1"],
      { cwd: "/repo/path" },
    );
  });

  it("still throws on checkout failure even if cleanup fails", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitError("already exists"); // worktree add -b fails
    mockGitSuccess(""); // worktree add (without -b)
    mockGitError("checkout failed"); // checkout fails
    mockGitError("worktree remove failed"); // cleanup also fails

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      'Failed to checkout branch "feat/TEST-1" in worktree',
    );
  });

  it("throws for non-already-exists worktree add errors", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitError("fatal: invalid reference"); // worktree add fails with other error

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      'Failed to create worktree for branch "feat/TEST-1": fatal: invalid reference',
    );
  });

  it("uses baseBranch as the starting point when provided", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // worktree add

    await ws.create(makeCreateConfig({ baseBranch: "feat/existing-feature" }));

    // worktree add should use origin/feat/existing-feature instead of origin/main
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "origin/feat/existing-feature",
      ],
      { cwd: "/repo/path" },
    );
  });

  it("falls back to defaultBranch when baseBranch is not provided", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // worktree add

    await ws.create(makeCreateConfig());

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "origin/main",
      ],
      { cwd: "/repo/path" },
    );
  });

  it("uses baseBranch in fallback path when branch already exists", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitError("already exists"); // worktree add -b fails
    mockGitSuccess(""); // worktree add (without -b)
    mockGitSuccess(""); // checkout

    await ws.create(makeCreateConfig({ baseBranch: "feat/existing-feature" }));

    // Fallback worktree add should also use baseBranch
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "/mock-home/.worktrees/myproject/session-1", "origin/feat/existing-feature"],
      { cwd: "/repo/path" },
    );
  });

  it("rejects invalid projectId", async () => {
    const ws = create();

    await expect(ws.create(makeCreateConfig({ projectId: "bad/project" }))).rejects.toThrow(
      'Invalid projectId "bad/project"',
    );
  });

  it("rejects projectId with dots", async () => {
    const ws = create();

    await expect(ws.create(makeCreateConfig({ projectId: "my.project" }))).rejects.toThrow(
      'Invalid projectId "my.project"',
    );
  });

  it("rejects invalid sessionId", async () => {
    const ws = create();

    await expect(ws.create(makeCreateConfig({ sessionId: "../escape" }))).rejects.toThrow(
      'Invalid sessionId "../escape"',
    );
  });

  it("rejects sessionId with spaces", async () => {
    const ws = create();

    await expect(ws.create(makeCreateConfig({ sessionId: "bad session" }))).rejects.toThrow(
      'Invalid sessionId "bad session"',
    );
  });

  it("returns correct WorkspaceInfo", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig());

    expect(info).toEqual({
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    });
  });

  it("expands tilde in project path", async () => {
    const ws = create();

    mockGitSuccess(""); // fetch
    mockGitSuccess(""); // worktree add

    await ws.create(
      makeCreateConfig({
        project: makeProject({ path: "~/my-repo" }),
      }),
    );

    // fetch should use expanded path
    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["fetch", "origin", "--quiet"], {
      cwd: "/mock-home/my-repo",
    });
  });
});

describe("workspace.destroy()", () => {
  it("removes worktree via git commands", async () => {
    const ws = create();

    // rev-parse returns the .git dir
    mockGitSuccess("/repo/path/.git");
    // worktree remove succeeds
    mockGitSuccess("");

    await ws.destroy("/mock-home/.worktrees/myproject/session-1");

    // First call: rev-parse
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: "/mock-home/.worktrees/myproject/session-1" },
    );

    // Second call: worktree remove
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/mock-home/.worktrees/myproject/session-1"],
      { cwd: "/repo/path" },
    );
  });

  it("falls back to rmSync when git commands fail", async () => {
    const ws = create();

    mockGitError("not a git repository"); // rev-parse fails
    mockExistsSync.mockReturnValueOnce(true);

    await ws.destroy("/mock-home/.worktrees/myproject/session-1");

    expect(mockRmSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject/session-1", {
      recursive: true,
      force: true,
    });
  });

  it("does nothing if git fails and directory does not exist", async () => {
    const ws = create();

    mockGitError("not a git repository");
    mockExistsSync.mockReturnValueOnce(false);

    await ws.destroy("/nonexistent/path");

    expect(mockRmSync).not.toHaveBeenCalled();
  });
});

describe("workspace.list()", () => {
  it("returns empty array when project directory does not exist", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(false);

    const result = await ws.list("myproject");

    expect(result).toEqual([]);
  });

  it("returns empty array when project directory has no subdirectories", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([]);

    const result = await ws.list("myproject");

    expect(result).toEqual([]);
  });

  it("parses worktree list porcelain output", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
      { name: "session-2", isDirectory: () => true },
    ]);

    const porcelainOutput = [
      "worktree /mock-home/.worktrees/myproject/session-1",
      "HEAD abc1234",
      "branch refs/heads/feat/TEST-1",
      "",
      "worktree /mock-home/.worktrees/myproject/session-2",
      "HEAD def5678",
      "branch refs/heads/feat/TEST-2",
      "",
      "worktree /repo/path",
      "HEAD 0000000",
      "branch refs/heads/main",
    ].join("\n");

    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    });
    expect(result[1]).toEqual({
      path: "/mock-home/.worktrees/myproject/session-2",
      branch: "feat/TEST-2",
      sessionId: "session-2",
      projectId: "myproject",
    });
  });

  it("handles detached HEAD worktrees", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([{ name: "session-1", isDirectory: () => true }]);

    const porcelainOutput = [
      "worktree /mock-home/.worktrees/myproject/session-1",
      "HEAD abc1234",
      "detached",
    ].join("\n");

    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("detached");
  });

  it("excludes worktrees outside the project directory", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([{ name: "session-1", isDirectory: () => true }]);

    const porcelainOutput = [
      "worktree /other/path/session-1",
      "HEAD abc1234",
      "branch refs/heads/feat/other",
      "",
      "worktree /mock-home/.worktrees/myproject/session-1",
      "HEAD def5678",
      "branch refs/heads/feat/TEST-1",
    ].join("\n");

    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-1");
  });

  it("returns empty when all git worktree list calls fail", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([{ name: "session-1", isDirectory: () => true }]);

    mockGitError("fatal: not a git repository");

    const result = await ws.list("myproject");

    expect(result).toEqual([]);
  });

  it("tries next directory when first worktree list fails", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
      { name: "session-2", isDirectory: () => true },
    ]);

    // First dir fails
    mockGitError("fatal: not a git repository");
    // Second dir succeeds
    const porcelainOutput = [
      "worktree /mock-home/.worktrees/myproject/session-2",
      "HEAD abc1234",
      "branch refs/heads/feat/TEST-2",
    ].join("\n");
    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-2");
  });

  it("rejects invalid projectId", async () => {
    const ws = create();

    await expect(ws.list("bad/id")).rejects.toThrow('Invalid projectId "bad/id"');
  });

  it("filters out non-directory entries", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
      { name: ".DS_Store", isDirectory: () => false },
      { name: "readme.txt", isDirectory: () => false },
    ]);

    const porcelainOutput = [
      "worktree /mock-home/.worktrees/myproject/session-1",
      "HEAD abc1234",
      "branch refs/heads/feat/TEST-1",
    ].join("\n");

    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(1);
  });
});

describe("workspace.postCreate()", () => {
  const workspaceInfo: WorkspaceInfo = {
    path: "/mock-home/.worktrees/myproject/session-1",
    branch: "feat/TEST-1",
    sessionId: "session-1",
    projectId: "myproject",
  };

  it("creates symlinks for configured paths", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["node_modules", ".env"] });

    // First symlink: node_modules exists, target lstat throws (doesn't exist)
    mockExistsSync.mockReturnValueOnce(true); // sourcePath exists
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    // Second symlink: .env exists, target lstat throws (doesn't exist)
    mockExistsSync.mockReturnValueOnce(true); // sourcePath exists
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).toHaveBeenCalledTimes(2);
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/repo/path/node_modules",
      "/mock-home/.worktrees/myproject/session-1/node_modules",
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/repo/path/.env",
      "/mock-home/.worktrees/myproject/session-1/.env",
    );
  });

  it("removes existing target before symlinking", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["node_modules"] });

    mockExistsSync.mockReturnValueOnce(true); // sourcePath exists
    mockLstatSync.mockReturnValueOnce({
      isSymbolicLink: () => true,
      isFile: () => false,
      isDirectory: () => false,
    });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockRmSync).toHaveBeenCalledWith(
      "/mock-home/.worktrees/myproject/session-1/node_modules",
      { recursive: true, force: true },
    );
    expect(mockSymlinkSync).toHaveBeenCalledTimes(1);
  });

  it("skips symlinks when source does not exist", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["nonexistent"] });

    mockExistsSync.mockReturnValueOnce(false); // sourcePath does not exist

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it("rejects absolute symlink paths", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["/absolute/path"] });

    await expect(ws.postCreate!(workspaceInfo, project)).rejects.toThrow(
      'Invalid symlink path "/absolute/path": must be a relative path without ".." segments',
    );
  });

  it("rejects .. directory traversal in symlink paths", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["../escape"] });

    await expect(ws.postCreate!(workspaceInfo, project)).rejects.toThrow(
      'Invalid symlink path "../escape": must be a relative path without ".." segments',
    );
  });

  it("rejects .. embedded in symlink paths", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["foo/../../../etc/passwd"] });

    await expect(ws.postCreate!(workspaceInfo, project)).rejects.toThrow(
      'must be a relative path without ".." segments',
    );
  });

  it("creates parent directories for nested symlink targets", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["config/settings"] });

    mockExistsSync.mockReturnValueOnce(true); // sourcePath exists
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockMkdirSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject/session-1/config", {
      recursive: true,
    });
  });

  it("runs postCreate commands", async () => {
    const ws = create();
    const project = makeProject({
      postCreate: ["pnpm install", "pnpm build"],
    });

    // Two sh -c calls
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockExecFileAsync).toHaveBeenCalledWith("sh", ["-c", "pnpm install"], {
      cwd: "/mock-home/.worktrees/myproject/session-1",
    });
    expect(mockExecFileAsync).toHaveBeenCalledWith("sh", ["-c", "pnpm build"], {
      cwd: "/mock-home/.worktrees/myproject/session-1",
    });
  });

  it("does nothing when no symlinks or postCreate configured", async () => {
    const ws = create();
    const project = makeProject();

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("handles both symlinks and postCreate commands together", async () => {
    const ws = create();
    const project = makeProject({
      symlinks: ["node_modules"],
      postCreate: ["pnpm install"],
    });

    // Symlink: source exists, target doesn't
    mockExistsSync.mockReturnValueOnce(true);
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    // postCreate command
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileAsync).toHaveBeenCalledWith("sh", ["-c", "pnpm install"], {
      cwd: "/mock-home/.worktrees/myproject/session-1",
    });
  });

  it("expands tilde in project path for symlink sources", async () => {
    const ws = create();
    const project = makeProject({ path: "~/my-repo", symlinks: ["data"] });

    mockExistsSync.mockReturnValueOnce(true);
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/mock-home/my-repo/data",
      "/mock-home/.worktrees/myproject/session-1/data",
    );
  });
});
