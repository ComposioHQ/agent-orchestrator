import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockExecFileSync,
  mockExistsSync,
  mockReadFileSync,
  mockUnlinkSync,
  mockGetProjectBaseDir,
} = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockGetProjectBaseDir: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: mockExecFileSync,
  };
});

vi.mock("node:fs", () => ({
  closeSync: vi.fn(),
  existsSync: mockExistsSync,
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  readFileSync: mockReadFileSync,
  unlinkSync: mockUnlinkSync,
  writeFileSync: vi.fn(),
}));

vi.mock("@composio/ao-core", () => ({
  getProjectBaseDir: mockGetProjectBaseDir,
}));

import { getLifecycleWorkerStatus } from "../../src/lib/lifecycle-service.js";

const config = {
  configPath: "/repo/agent-orchestrator.yaml",
  projects: {
    proj: {
      path: "/repo/project",
    },
  },
} as const;

const pidFile = "/ao/proj/lifecycle-worker.pid";
const logFile = "/ao/proj/lifecycle-worker.log";

beforeEach(() => {
  mockExecFileSync.mockReset();
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockUnlinkSync.mockReset();
  mockGetProjectBaseDir.mockReset();
  mockGetProjectBaseDir.mockReturnValue("/ao/proj");
  vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLifecycleWorkerStatus", () => {
  it("returns running when the pid belongs to the matching lifecycle worker", () => {
    mockExistsSync.mockImplementation((path: string) =>
      path === pidFile || path === "/proc/123/cmdline",
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === pidFile) return "123\n";
      if (path === "/proc/123/cmdline") {
        return "node\0dist/index.js\0lifecycle-worker\0proj\0";
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const status = getLifecycleWorkerStatus(config, "proj");

    expect(status).toEqual({ running: true, pid: 123, pidFile, logFile });
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("clears a stale pidfile when the pid belongs to a different process", () => {
    mockExistsSync.mockImplementation((path: string) =>
      path === pidFile || path === "/proc/123/cmdline",
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === pidFile) return "123\n";
      if (path === "/proc/123/cmdline") {
        return "node\0server.js\0--watch\0";
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const status = getLifecycleWorkerStatus(config, "proj");

    expect(status).toEqual({ running: false, pid: null, pidFile, logFile });
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  it("falls back to ps output when /proc inspection is unavailable", () => {
    mockExistsSync.mockImplementation((path: string) => path === pidFile);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === pidFile) return "123\n";
      throw new Error(`Unexpected path: ${path}`);
    });
    mockExecFileSync.mockReturnValue("node dist/index.js lifecycle-worker proj\n");

    const status = getLifecycleWorkerStatus(config, "proj");

    expect(status).toEqual({ running: true, pid: 123, pidFile, logFile });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "ps",
      ["-p", "123", "-o", "command="],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("keeps the current behavior when ownership cannot be inspected", () => {
    mockExistsSync.mockImplementation((path: string) => path === pidFile);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === pidFile) return "123\n";
      throw new Error(`Unexpected path: ${path}`);
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ps unavailable");
    });

    const status = getLifecycleWorkerStatus(config, "proj");

    expect(status).toEqual({ running: true, pid: 123, pidFile, logFile });
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });
});
