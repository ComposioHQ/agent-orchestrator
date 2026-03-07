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
  platform: vi.fn(() => "linux"),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as childProcess from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { platform } from "node:os";
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
const mockPlatform = platform as ReturnType<typeof vi.fn>;

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
  mockPlatform.mockReturnValue("linux");
});

describe("manifest & exports", () => {
  it("has correct manifest metadata", () => {
    expect(manifest.name).toBe("overlay");
    expect(manifest.slot).toBe("workspace");
    expect(manifest.version).toBe("0.1.0");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });

  it("create() returns a workspace with correct name", () => {
    const ws = create();
    expect(ws.name).toBe("overlay");
  });
});

describe("workspace.create()", () => {
  it("mounts overlay filesystem and returns workspace info", async () => {
    const ws = create();

    mockCmdSuccess(""); // mount

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/.ao-overlays/myproject/session-1/merged");
    expect(info.branch).toBe("feat/TEST-1");
    expect(info.sessionId).toBe("session-1");
    expect(info.projectId).toBe("myproject");
  });

  it("calls mount with correct overlay options", async () => {
    const ws = create();

    mockCmdSuccess(""); // mount

    await ws.create(makeCreateConfig());

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "mount",
      [
        "-t", "overlay", "overlay", "-o",
        "lowerdir=/repo/path,upperdir=/mock-home/.ao-overlays/myproject/session-1/upper,workdir=/mock-home/.ao-overlays/myproject/session-1/work",
        "/mock-home/.ao-overlays/myproject/session-1/merged",
      ],
      expect.anything(),
    );
  });

  it("throws on non-Linux platforms", async () => {
    mockPlatform.mockReturnValue("darwin");
    const ws = create();

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      "workspace-overlay requires Linux",
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

  it("uses custom overlayDir from config", async () => {
    const ws = create({ overlayDir: "/custom/overlays" });

    mockCmdSuccess(""); // mount

    const info = await ws.create(makeCreateConfig());
    expect(info.path).toBe("/custom/overlays/myproject/session-1/merged");
  });
});

describe("workspace.destroy()", () => {
  it("unmounts overlay and removes session directory", async () => {
    const ws = create();

    mockCmdSuccess(""); // umount
    mockExistsSync.mockReturnValueOnce(true); // session dir exists

    await ws.destroy("/mock-home/.ao-overlays/myproject/session-1/merged");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "umount",
      ["/mock-home/.ao-overlays/myproject/session-1/merged"],
      expect.anything(),
    );
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining("session-1"),
      { recursive: true, force: true },
    );
  });

  it("still removes directory even when umount fails", async () => {
    const ws = create();

    mockCmdError("not mounted"); // umount fails
    mockExistsSync.mockReturnValueOnce(true);

    await ws.destroy("/mock-home/.ao-overlays/myproject/session-1/merged");

    expect(mockRmSync).toHaveBeenCalled();
  });

  it("does nothing if session directory does not exist", async () => {
    const ws = create();

    mockCmdError("not mounted");
    mockExistsSync.mockReturnValueOnce(false);

    await ws.destroy("/mock-home/.ao-overlays/myproject/session-1/merged");

    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("rejects destroy outside managed overlay directory", async () => {
    const ws = create();

    await expect(ws.destroy("/tmp/random/merged")).rejects.toThrow(
      'Refusing to manage overlay path outside "/mock-home/.ao-overlays"',
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

  it("returns workspace infos for valid overlay sessions", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true); // project dir exists
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
    ]);
    mockExistsSync.mockReturnValueOnce(true); // merged dir exists
    mockCmdSuccess("feat/TEST-1"); // git branch --show-current

    const result = await ws.list("myproject");
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-1");
    expect(result[0].path).toContain("merged");
  });

  it("skips entries without merged directory", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true); // project dir exists
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
    ]);
    mockExistsSync.mockReturnValueOnce(false); // merged dir does not exist

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

  it("returns true when mountpoint check succeeds", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(true);
    mockCmdSuccess(""); // mountpoint -q succeeds (returns 0)

    expect(await ws.exists("/mock-home/.ao-overlays/myproject/session-1/merged")).toBe(true);
  });

  it("returns false when mountpoint check fails", async () => {
    const ws = create();
    mockExistsSync.mockReturnValueOnce(true); // path exists
    mockCmdError("not a mountpoint"); // mountpoint fails

    expect(await ws.exists("/mock-home/.ao-overlays/myproject/session-1/merged")).toBe(false);
  });
});

describe("workspace.restore()", () => {
  it("remounts overlay filesystem", async () => {
    const ws = create();

    mockCmdSuccess(""); // mount

    const info = await ws.restore(
      makeCreateConfig(),
      "/mock-home/.ao-overlays/myproject/session-1/merged",
    );

    expect(info.path).toBe("/mock-home/.ao-overlays/myproject/session-1/merged");
    expect(info.branch).toBe("feat/TEST-1");
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "mount",
      expect.arrayContaining(["-t", "overlay"]),
      expect.anything(),
    );
  });

  it("throws on non-Linux platforms", async () => {
    mockPlatform.mockReturnValue("darwin");
    const ws = create();

    await expect(
      ws.restore(makeCreateConfig(), "/some/path/merged"),
    ).rejects.toThrow("workspace-overlay requires Linux");
  });

  it("rejects restore outside managed overlay directory", async () => {
    const ws = create();

    await expect(
      ws.restore(makeCreateConfig(), "/tmp/random/merged"),
    ).rejects.toThrow('Refusing to manage overlay path outside "/mock-home/.ao-overlays"');
  });

  it("rejects invalid sessionId during restore", async () => {
    const ws = create();

    await expect(
      ws.restore(
        makeCreateConfig({ sessionId: "../escape" }),
        "/mock-home/.ao-overlays/myproject/session-1/merged",
      ),
    ).rejects.toThrow('Invalid sessionId "../escape"');
  });
});

describe("workspace.postCreate()", () => {
  it("runs commands in merged workspace", async () => {
    const ws = create();
    const info: WorkspaceInfo = {
      path: "/mock-home/.ao-overlays/myproject/session-1/merged",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    };
    const proj = makeProject({ postCreate: ["make build"] });

    mockCmdSuccess("");

    await ws.postCreate!(info, proj);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "sh",
      ["-c", "make build"],
      expect.objectContaining({ cwd: "/mock-home/.ao-overlays/myproject/session-1/merged" }),
    );
  });

  it("does nothing when no postCreate configured", async () => {
    const ws = create();
    const info: WorkspaceInfo = {
      path: "/mock-home/.ao-overlays/myproject/session-1/merged",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    };

    await ws.postCreate!(info, makeProject());
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});
