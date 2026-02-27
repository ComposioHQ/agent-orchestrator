import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectConfig, WorkspaceCreateConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that uses the mocked modules
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { create, manifest, default as defaultExport } from "./index.js";

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockExecFileAsync = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;
const mockRmSync = rmSync as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockCmdSuccess(stdout = "") {
  mockExecFileAsync.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

function mockCmdError(message: string) {
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
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("manifest & exports", () => {
  it("has correct manifest metadata", () => {
    expect(manifest.name).toBe("container-use");
    expect(manifest.slot).toBe("workspace");
    expect(manifest.version).toBe("0.1.0");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });

  it("create() returns a workspace with correct name", () => {
    const ws = create();
    expect(ws.name).toBe("container-use");
  });
});

describe("workspace.create()", () => {
  it("creates worktree and starts docker container", async () => {
    const ws = create();

    mockCmdSuccess(""); // git fetch
    mockCmdSuccess(""); // git worktree add
    mockCmdSuccess(""); // docker run

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/.worktrees/myproject/session-1");
    expect(info.branch).toBe("feat/TEST-1");
    expect(info.sessionId).toBe("session-1");
    expect(info.projectId).toBe("myproject");
  });

  it("calls git fetch and git worktree add with correct args", async () => {
    const ws = create();

    mockCmdSuccess(""); // git fetch
    mockCmdSuccess(""); // git worktree add
    mockCmdSuccess(""); // docker run

    await ws.create(makeCreateConfig());

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["fetch", "origin", "--quiet"],
      expect.objectContaining({ cwd: "/repo/path" }),
    );

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree", "add", "-b", "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "origin/main",
      ],
      expect.objectContaining({ cwd: "/repo/path" }),
    );
  });

  it("starts a docker container with the worktree mounted", async () => {
    const ws = create();

    mockCmdSuccess(""); // git fetch
    mockCmdSuccess(""); // git worktree add
    mockCmdSuccess(""); // docker run

    await ws.create(makeCreateConfig());

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "run", "-d", "--name", "ao-myproject-session-1",
        "-v", "/mock-home/.worktrees/myproject/session-1:/workspace",
      ]),
      expect.anything(),
    );
  });

  it("continues when git fetch fails (offline)", async () => {
    const ws = create();

    mockCmdError("Could not resolve host"); // git fetch fails
    mockCmdSuccess(""); // git worktree add
    mockCmdSuccess(""); // docker run

    const info = await ws.create(makeCreateConfig());
    expect(info.path).toBe("/mock-home/.worktrees/myproject/session-1");
  });

  it("handles branch already exists by adding worktree then checking out", async () => {
    const ws = create();

    mockCmdSuccess(""); // git fetch
    mockCmdError("already exists"); // worktree add -b fails
    mockCmdSuccess(""); // worktree add (without -b)
    mockCmdSuccess(""); // git checkout
    mockCmdSuccess(""); // docker run

    const info = await ws.create(makeCreateConfig());
    expect(info.branch).toBe("feat/TEST-1");
  });

  it("cleans up worktree when docker fails", async () => {
    const ws = create();

    mockCmdSuccess(""); // git fetch
    mockCmdSuccess(""); // git worktree add
    mockCmdError("docker daemon not running"); // docker run fails
    mockCmdSuccess(""); // git worktree remove (cleanup)

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      "Failed to start Docker container",
    );
  });

  it("rejects invalid projectId", async () => {
    const ws = create();
    await expect(
      ws.create(makeCreateConfig({ projectId: "bad/project" })),
    ).rejects.toThrow('Invalid projectId "bad/project"');
  });

  it("rejects invalid sessionId", async () => {
    const ws = create();
    await expect(
      ws.create(makeCreateConfig({ sessionId: "../escape" })),
    ).rejects.toThrow('Invalid sessionId "../escape"');
  });
});

describe("workspace.destroy()", () => {
  it("removes docker container and git worktree", async () => {
    const ws = create();

    mockCmdSuccess(""); // docker rm -f
    mockCmdSuccess("/repo/path/.git"); // git rev-parse
    mockCmdSuccess(""); // git worktree remove

    await ws.destroy("/mock-home/.worktrees/myproject/session-1");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "docker",
      ["rm", "-f", "ao-myproject-session-1"],
      expect.anything(),
    );
  });

  it("falls back to rmSync when git commands fail", async () => {
    const ws = create();

    mockCmdSuccess(""); // docker rm
    mockCmdError("not a git repository"); // git rev-parse fails
    mockExistsSync.mockReturnValueOnce(true);

    await ws.destroy("/mock-home/.worktrees/myproject/session-1");

    expect(mockRmSync).toHaveBeenCalledWith(
      "/mock-home/.worktrees/myproject/session-1",
      { recursive: true, force: true },
    );
  });
});

describe("workspace.list()", () => {
  it("returns empty array when project directory does not exist", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(false);
    const result = await ws.list("myproject");
    expect(result).toEqual([]);
  });

  it("returns workspace infos for valid worktrees", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
    ]);
    mockCmdSuccess("feat/TEST-1"); // git branch --show-current

    const result = await ws.list("myproject");
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-1");
    expect(result[0].branch).toBe("feat/TEST-1");
  });

  it("skips entries where git branch fails", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
    ]);
    mockCmdError("not a git repository");

    const result = await ws.list("myproject");
    expect(result).toEqual([]);
  });

  it("rejects invalid projectId", async () => {
    const ws = create();
    await expect(ws.list("bad/id")).rejects.toThrow('Invalid projectId "bad/id"');
  });
});

describe("workspace.exists()", () => {
  it("returns false when path does not exist", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(false);
    expect(await ws.exists("/nonexistent")).toBe(false);
  });

  it("returns true when git repo and container are running", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(true);
    mockCmdSuccess("true"); // git rev-parse
    mockCmdSuccess("true"); // docker inspect
    expect(await ws.exists("/mock-home/.worktrees/myproject/session-1")).toBe(true);
  });

  it("returns false when container is not running", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(true);
    mockCmdSuccess("true"); // git rev-parse
    mockCmdError("No such container"); // docker inspect fails
    expect(await ws.exists("/mock-home/.worktrees/myproject/session-1")).toBe(false);
  });
});

describe("workspace.restore()", () => {
  it("creates parent directory and starts container", async () => {
    const ws = create();

    mockExistsSync.mockReturnValue(false);
    mockCmdSuccess(""); // git worktree prune
    mockCmdSuccess(""); // git fetch
    mockCmdSuccess(""); // git worktree add
    mockCmdSuccess(""); // docker rm -f
    mockCmdSuccess(""); // docker run

    const info = await ws.restore!(
      makeCreateConfig(),
      "/mock-home/.worktrees/myproject/session-1",
    );

    expect(mockMkdirSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject", {
      recursive: true,
    });
    expect(info.path).toBe("/mock-home/.worktrees/myproject/session-1");
    expect(info.branch).toBe("feat/TEST-1");
  });

  it("cleans up worktree when container start fails during restore", async () => {
    const ws = create();

    mockExistsSync.mockReturnValue(false);
    mockCmdSuccess(""); // git worktree prune
    mockCmdSuccess(""); // git fetch
    mockCmdSuccess(""); // git worktree add
    mockCmdSuccess(""); // docker rm -f
    mockCmdError("docker run failed"); // docker run
    mockCmdSuccess(""); // git worktree remove

    await expect(
      ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1"),
    ).rejects.toThrow("Failed to start Docker container");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/mock-home/.worktrees/myproject/session-1"],
      expect.objectContaining({ cwd: "/repo/path" }),
    );
  });

  it("fails restore when workspace path already exists", async () => {
    const ws = create();
    mockExistsSync.mockReturnValue(true);

    await expect(
      ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1"),
    ).rejects.toThrow(
      'Workspace path "/mock-home/.worktrees/myproject/session-1" already exists for session "session-1"',
    );
  });
});

describe("workspace.postCreate()", () => {
  it("runs commands inside docker container", async () => {
    const ws = create();
    const info = {
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    };
    const proj = makeProject({ postCreate: ["npm install"] });

    mockCmdSuccess(""); // docker exec

    await ws.postCreate!(info, proj);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "docker",
      ["exec", "ao-myproject-session-1", "sh", "-c", "npm install"],
      expect.anything(),
    );
  });

  it("does nothing when no postCreate configured", async () => {
    const ws = create();
    const info = {
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    };

    await ws.postCreate!(info, makeProject());
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});
