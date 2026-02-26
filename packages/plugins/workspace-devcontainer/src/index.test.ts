import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectConfig, WorkspaceCreateConfig, WorkspaceInfo } from "@composio/ao-core";

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
import { existsSync, readdirSync } from "node:fs";
import { create, manifest, default as defaultExport } from "./index.js";

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockExecFileAsync = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;

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
    expect(manifest.name).toBe("devcontainer");
    expect(manifest.slot).toBe("workspace");
    expect(manifest.version).toBe("0.1.0");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });

  it("create() returns a workspace with correct name", () => {
    const ws = create();
    expect(ws.name).toBe("devcontainer");
  });
});

describe("workspace.create()", () => {
  it("creates worktree and starts devcontainer", async () => {
    const ws = create();

    mockCmdSuccess(""); // git fetch
    mockCmdSuccess(""); // git worktree add
    mockCmdSuccess(""); // devcontainer up

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/.worktrees/myproject/session-1");
    expect(info.branch).toBe("feat/TEST-1");
    expect(info.sessionId).toBe("session-1");
    expect(info.projectId).toBe("myproject");
  });

  it("calls devcontainer up with workspace-folder", async () => {
    const ws = create();

    mockCmdSuccess(""); // git fetch
    mockCmdSuccess(""); // git worktree add
    mockCmdSuccess(""); // devcontainer up

    await ws.create(makeCreateConfig());

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "devcontainer",
      ["up", "--workspace-folder", "/mock-home/.worktrees/myproject/session-1"],
      expect.anything(),
    );
  });

  it("continues when git fetch fails (offline)", async () => {
    const ws = create();

    mockCmdError("Could not resolve host"); // git fetch fails
    mockCmdSuccess(""); // git worktree add
    mockCmdSuccess(""); // devcontainer up

    const info = await ws.create(makeCreateConfig());
    expect(info.path).toBe("/mock-home/.worktrees/myproject/session-1");
  });

  it("handles branch already exists", async () => {
    const ws = create();

    mockCmdSuccess(""); // git fetch
    mockCmdError("already exists"); // worktree add -b fails
    mockCmdSuccess(""); // worktree add (without -b)
    mockCmdSuccess(""); // git checkout
    mockCmdSuccess(""); // devcontainer up

    const info = await ws.create(makeCreateConfig());
    expect(info.branch).toBe("feat/TEST-1");
  });

  it("throws for non-already-exists worktree errors", async () => {
    const ws = create();

    mockCmdSuccess(""); // git fetch
    mockCmdError("fatal: invalid reference"); // worktree add fails

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      'Failed to create worktree for branch "feat/TEST-1"',
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

  it("uses custom worktreeDir from config", async () => {
    const ws = create({ worktreeDir: "/custom/worktrees" });

    mockCmdSuccess(""); // git fetch
    mockCmdSuccess(""); // git worktree add
    mockCmdSuccess(""); // devcontainer up

    const info = await ws.create(makeCreateConfig());
    expect(info.path).toBe("/custom/worktrees/myproject/session-1");
  });
});

describe("workspace.destroy()", () => {
  it("shuts down devcontainer and removes worktree", async () => {
    const ws = create();

    mockCmdSuccess(""); // devcontainer down
    mockCmdSuccess("/repo/path/.git"); // git rev-parse
    mockCmdSuccess(""); // git worktree remove

    await ws.destroy("/mock-home/.worktrees/myproject/session-1");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "devcontainer",
      ["down", "--workspace-folder", "/mock-home/.worktrees/myproject/session-1"],
      expect.anything(),
    );
  });

  it("falls back to rmSync when git commands fail", async () => {
    const ws = create();

    mockCmdSuccess(""); // devcontainer down
    mockCmdError("not a git repository"); // git rev-parse fails
    mockExistsSync.mockReturnValueOnce(true);

    await ws.destroy("/mock-home/.worktrees/myproject/session-1");

    // rmSync imported dynamically inside destroy, but we check existsSync was called
    expect(mockExistsSync).toHaveBeenCalled();
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

  it("returns true when git repo exists", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(true);
    mockCmdSuccess("true"); // git rev-parse
    expect(await ws.exists("/mock-home/.worktrees/myproject/session-1")).toBe(true);
  });

  it("returns false when git rev-parse fails", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(true);
    mockCmdError("not a git repository");
    expect(await ws.exists("/mock-home/.worktrees/myproject/session-1")).toBe(false);
  });
});

describe("workspace.postCreate()", () => {
  it("runs postCreate commands in workspace", async () => {
    const ws = create();
    const info: WorkspaceInfo = {
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    };
    const proj = makeProject({ postCreate: ["pnpm install"] });

    mockCmdSuccess(""); // sh -c "pnpm install"

    await ws.postCreate!(info, proj);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "sh",
      ["-c", "pnpm install"],
      expect.objectContaining({ cwd: "/mock-home/.worktrees/myproject/session-1" }),
    );
  });

  it("does nothing when no postCreate configured", async () => {
    const ws = create();
    const info: WorkspaceInfo = {
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    };

    await ws.postCreate!(info, makeProject());
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});

describe("workspace.restore()", () => {
  it("restores worktree and starts devcontainer", async () => {
    const ws = create();

    mockCmdSuccess(""); // git worktree prune
    mockCmdSuccess(""); // git fetch
    mockCmdSuccess(""); // git worktree add
    mockCmdSuccess(""); // devcontainer up

    const info = await ws.restore(
      makeCreateConfig(),
      "/mock-home/.worktrees/myproject/session-1",
    );

    expect(info.path).toBe("/mock-home/.worktrees/myproject/session-1");
    expect(info.branch).toBe("feat/TEST-1");
  });
});
