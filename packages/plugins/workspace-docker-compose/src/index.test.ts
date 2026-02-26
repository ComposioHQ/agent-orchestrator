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
  copyFileSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as childProcess from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { create, manifest, default as defaultExport } from "./index.js";

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockExecFileAsync = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;
const mockRmSync = rmSync as ReturnType<typeof vi.fn>;
const mockStatSync = statSync as ReturnType<typeof vi.fn>;

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

/**
 * Mock existsSync to respond true for the compose file lookup.
 * The plugin checks for docker-compose.yml first.
 */
function mockComposeFileExists() {
  // findComposeFile iterates COMPOSE_FILE_NAMES and calls existsSync for each
  // We need existsSync to return true for the first compose file name
  mockExistsSync.mockImplementation((p: string) => {
    if (typeof p === "string" && p.endsWith("docker-compose.yml")) return true;
    return false;
  });
  mockStatSync.mockReturnValue({ isFile: () => true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("manifest & exports", () => {
  it("has correct manifest metadata", () => {
    expect(manifest.name).toBe("docker-compose");
    expect(manifest.slot).toBe("workspace");
    expect(manifest.version).toBe("0.1.0");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });

  it("create() returns a workspace with correct name", () => {
    const ws = create();
    expect(ws.name).toBe("docker-compose");
  });
});

describe("workspace.create()", () => {
  it("clones repo, checks out branch, and runs docker compose up", async () => {
    const ws = create();
    mockComposeFileExists();

    mockCmdSuccess("https://github.com/test/repo.git"); // git remote get-url origin
    mockCmdSuccess(""); // git clone
    mockCmdSuccess(""); // git checkout -b
    mockCmdSuccess(""); // docker compose up -d

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/.ao-compose-workspaces/myproject/session-1");
    expect(info.branch).toBe("feat/TEST-1");
    expect(info.sessionId).toBe("session-1");
    expect(info.projectId).toBe("myproject");
  });

  it("throws when no compose file found", async () => {
    const ws = create();
    mockExistsSync.mockReturnValue(false); // no compose file

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      "No Docker Compose file found",
    );
  });

  it("throws when workspace path already exists", async () => {
    const ws = create();
    // First few existsSync calls: compose file lookup
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("docker-compose.yml")) return true;
      // The workspace path check
      if (typeof p === "string" && p.includes("session-1")) return true;
      return false;
    });
    mockStatSync.mockReturnValue({ isFile: () => true });

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      "already exists",
    );
  });

  it("cleans up on clone failure", async () => {
    const ws = create();

    // existsSync needs to:
    // 1. Return true for compose file lookup (findComposeFile)
    // 2. Return false for workspace path existence check (line 149)
    // 3. Return true for cleanup check after clone fails (line 178)
    let workspaceExistsCallCount = 0;
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("docker-compose.yml")) return true;
      if (typeof p === "string" && p.includes("session-1")) {
        workspaceExistsCallCount++;
        // First call (line 149): workspace doesn't exist yet
        // Second call (line 178): workspace exists for cleanup
        return workspaceExistsCallCount > 1;
      }
      return false;
    });
    mockStatSync.mockReturnValue({ isFile: () => true });

    mockCmdSuccess("https://github.com/test/repo.git"); // git remote get-url
    mockCmdError("clone failed"); // git clone fails

    await expect(ws.create(makeCreateConfig())).rejects.toThrow("Failed to clone");
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
  it("tears down compose services and removes workspace directory", async () => {
    const ws = create();

    // existsSync for the workspace path and compose file
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("docker-compose.yml")) return true;
      return true;
    });
    mockStatSync.mockReturnValue({ isFile: () => true });

    mockCmdSuccess(""); // docker compose down

    await ws.destroy("/mock-home/.ao-compose-workspaces/myproject/session-1");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["compose", "-p", "ao-myproject-session-1"]),
      expect.anything(),
    );
    expect(mockRmSync).toHaveBeenCalled();
  });

  it("removes directory even when compose down fails", async () => {
    const ws = create();

    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("docker-compose.yml")) return true;
      return true;
    });
    mockStatSync.mockReturnValue({ isFile: () => true });

    mockCmdError("compose down failed"); // docker compose down fails

    await ws.destroy("/mock-home/.ao-compose-workspaces/myproject/session-1");

    expect(mockRmSync).toHaveBeenCalled();
  });
});

describe("workspace.list()", () => {
  it("returns empty array when project directory does not exist", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(false);
    const result = await ws.list("myproject");
    expect(result).toEqual([]);
  });

  it("returns workspace infos for valid git repos", async () => {
    const ws = create();

    mockExistsSync.mockReturnValue(false);
    mockExistsSync.mockReturnValueOnce(true); // projectWorkspaceDir exists
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

  it("returns true when git repo and compose services are running", async () => {
    const ws = create();
    // existsSync: first call for path check, then for compose file lookup
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("docker-compose.yml")) return true;
      return true; // workspace path exists
    });
    mockStatSync.mockReturnValue({ isFile: () => true });
    mockCmdSuccess("true"); // git rev-parse --is-inside-work-tree
    mockCmdSuccess("service1"); // docker compose ps --services

    expect(await ws.exists("/mock-home/.ao-compose-workspaces/myproject/session-1")).toBe(true);
  });
});

describe("workspace.postCreate()", () => {
  it("runs commands via docker compose exec", async () => {
    const ws = create();
    const info: WorkspaceInfo = {
      path: "/mock-home/.ao-compose-workspaces/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    };
    const proj = makeProject({ postCreate: ["npm install"] });

    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("docker-compose.yml")) return true;
      return false;
    });
    mockStatSync.mockReturnValue({ isFile: () => true });

    mockCmdSuccess("web"); // docker compose ps --services
    mockCmdSuccess(""); // docker compose exec

    await ws.postCreate!(info, proj);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["compose", "-p", "ao-myproject-session-1"]),
      expect.anything(),
    );
  });

  it("does nothing when no postCreate configured", async () => {
    const ws = create();
    const info: WorkspaceInfo = {
      path: "/mock-home/.ao-compose-workspaces/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    };

    await ws.postCreate!(info, makeProject());
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});
