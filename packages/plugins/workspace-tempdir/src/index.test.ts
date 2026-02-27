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
  mkdtempSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
  tmpdir: () => "/tmp",
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as childProcess from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { create, manifest, default as defaultExport } from "./index.js";

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockExecFileAsync = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;
const mockMkdtempSync = mkdtempSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;
const mockRmSync = rmSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockWriteFileSync = writeFileSync as ReturnType<typeof vi.fn>;

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
    expect(manifest.name).toBe("tempdir");
    expect(manifest.slot).toBe("workspace");
    expect(manifest.version).toBe("0.1.0");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });

  it("create() returns a workspace with correct name", () => {
    const ws = create();
    expect(ws.name).toBe("tempdir");
  });
});

describe("workspace.create()", () => {
  it("creates a temp directory and shallow clones into it", async () => {
    const ws = create();

    mockMkdtempSync.mockReturnValueOnce("/tmp/ao-myproject-session-1-xyz");
    mockCmdSuccess(""); // git clone
    mockCmdSuccess(""); // git checkout -b
    mockReadFileSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    }); // tracking file doesn't exist yet

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/tmp/ao-myproject-session-1-xyz");
    expect(info.branch).toBe("feat/TEST-1");
    expect(info.sessionId).toBe("session-1");
    expect(info.projectId).toBe("myproject");
  });

  it("calls git clone with --depth 1", async () => {
    const ws = create();

    mockMkdtempSync.mockReturnValueOnce("/tmp/ao-myproject-session-1-xyz");
    mockCmdSuccess(""); // git clone
    mockCmdSuccess(""); // git checkout -b
    mockReadFileSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    await ws.create(makeCreateConfig());

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "clone", "--depth", "1",
        "--branch", "main",
        "/repo/path",
        "/tmp/ao-myproject-session-1-xyz",
      ],
      expect.anything(),
    );
  });

  it("updates tracking file with session mapping", async () => {
    const ws = create();

    mockMkdtempSync.mockReturnValueOnce("/tmp/ao-myproject-session-1-xyz");
    mockCmdSuccess(""); // git clone
    mockCmdSuccess(""); // git checkout -b
    mockReadFileSync.mockReturnValueOnce("{}"); // empty tracking file

    await ws.create(makeCreateConfig());

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("sessions.json"),
      expect.stringContaining("session-1"),
      "utf-8",
    );
  });

  it("cleans up temp directory on clone failure", async () => {
    const ws = create();

    mockMkdtempSync.mockReturnValueOnce("/tmp/ao-myproject-session-1-xyz");
    mockCmdError("clone failed"); // git clone fails

    await expect(ws.create(makeCreateConfig())).rejects.toThrow("Failed to clone");

    expect(mockRmSync).toHaveBeenCalledWith("/tmp/ao-myproject-session-1-xyz", {
      recursive: true,
      force: true,
    });
  });

  it("cleans up temp directory on branch creation failure", async () => {
    const ws = create();

    mockMkdtempSync.mockReturnValueOnce("/tmp/ao-myproject-session-1-xyz");
    mockCmdSuccess(""); // git clone succeeds
    mockCmdError("branch creation failed"); // git checkout -b fails

    await expect(ws.create(makeCreateConfig())).rejects.toThrow("Failed to create branch");

    expect(mockRmSync).toHaveBeenCalledWith("/tmp/ao-myproject-session-1-xyz", {
      recursive: true,
      force: true,
    });
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
  it("removes the workspace directory", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(false); // tracking dir missing
    mockExistsSync.mockReturnValueOnce(true); // workspace exists

    await ws.destroy("/tmp/ao-myproject-session-1-xyz");

    expect(mockRmSync).toHaveBeenCalledWith("/tmp/ao-myproject-session-1-xyz", {
      recursive: true,
      force: true,
    });
  });

  it("does nothing if directory does not exist", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(false); // tracking dir missing
    mockExistsSync.mockReturnValueOnce(false); // workspace missing

    await ws.destroy("/nonexistent");

    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("removes matching tracking entries by workspace path", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true); // tracking dir exists
    mockReaddirSync.mockReturnValueOnce([{ name: "myproject", isDirectory: () => true }]);
    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({ "session-1": "/tmp/ao-myproject-session-1-xyz" }),
    );
    mockExistsSync.mockReturnValueOnce(false); // workspace already gone

    await ws.destroy("/tmp/ao-myproject-session-1-xyz");

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("/myproject/sessions.json"),
      "{}",
      "utf-8",
    );
  });
});

describe("workspace.list()", () => {
  it("returns workspace infos from tracking file", async () => {
    const ws = create();

    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({ "session-1": "/tmp/ao-myproject-session-1-xyz" }),
    );
    mockExistsSync.mockReturnValueOnce(true); // tmpDir exists
    mockCmdSuccess("feat/TEST-1"); // git branch --show-current

    const result = await ws.list("myproject");
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-1");
    expect(result[0].path).toBe("/tmp/ao-myproject-session-1-xyz");
    expect(result[0].branch).toBe("feat/TEST-1");
  });

  it("returns empty array when tracking file does not exist", async () => {
    const ws = create();

    mockReadFileSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    const result = await ws.list("myproject");
    expect(result).toEqual([]);
  });

  it("skips entries where temp directory no longer exists", async () => {
    const ws = create();

    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({ "session-1": "/tmp/ao-myproject-session-1-xyz" }),
    );
    mockExistsSync.mockReturnValueOnce(false); // tmpDir doesn't exist

    const result = await ws.list("myproject");
    expect(result).toEqual([]);
  });

  it("skips entries where git branch fails", async () => {
    const ws = create();

    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({ "session-1": "/tmp/ao-myproject-session-1-xyz" }),
    );
    mockExistsSync.mockReturnValueOnce(true);
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

  it("returns true when path exists and is a git repo", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(true);
    mockCmdSuccess("true"); // git rev-parse --is-inside-work-tree

    expect(await ws.exists("/tmp/ao-myproject-session-1-xyz")).toBe(true);
  });

  it("returns false when path exists but is not a git repo", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(true);
    mockCmdError("not a git repository");

    expect(await ws.exists("/tmp/ao-myproject-session-1-xyz")).toBe(false);
  });
});

describe("workspace.restore()", () => {
  it("clones into workspace path and checks out branch", async () => {
    const ws = create();

    mockCmdSuccess(""); // git clone
    mockCmdSuccess(""); // git checkout

    const info = await ws.restore(
      makeCreateConfig(),
      "/tmp/ao-myproject-session-1-xyz",
    );

    expect(info.path).toBe("/tmp/ao-myproject-session-1-xyz");
    expect(info.branch).toBe("feat/TEST-1");
    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("/myproject/sessions.json"),
      expect.stringContaining("session-1"),
      "utf-8",
    );
  });

  it("creates branch if checkout fails", async () => {
    const ws = create();

    mockCmdSuccess(""); // git clone
    mockCmdError("pathspec did not match"); // git checkout fails
    mockCmdSuccess(""); // git checkout -b

    const info = await ws.restore(
      makeCreateConfig(),
      "/tmp/ao-myproject-session-1-xyz",
    );

    expect(info.branch).toBe("feat/TEST-1");
  });

  it("throws and cleans up on clone failure", async () => {
    const ws = create();

    mockCmdError("clone failed");

    await expect(
      ws.restore(makeCreateConfig(), "/tmp/ao-myproject-session-1-xyz"),
    ).rejects.toThrow("Clone failed during restore");

    expect(mockRmSync).toHaveBeenCalled();
  });
});

describe("workspace.postCreate()", () => {
  it("runs postCreate commands in workspace", async () => {
    const ws = create();
    const info: WorkspaceInfo = {
      path: "/tmp/ao-myproject-session-1-xyz",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    };
    const proj = makeProject({ postCreate: ["npm install"] });

    mockCmdSuccess("");

    await ws.postCreate!(info, proj);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "sh",
      ["-c", "npm install"],
      expect.objectContaining({ cwd: "/tmp/ao-myproject-session-1-xyz" }),
    );
  });

  it("does nothing when no postCreate configured", async () => {
    const ws = create();
    const info: WorkspaceInfo = {
      path: "/tmp/ao-myproject-session-1-xyz",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    };

    await ws.postCreate!(info, makeProject());
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});
