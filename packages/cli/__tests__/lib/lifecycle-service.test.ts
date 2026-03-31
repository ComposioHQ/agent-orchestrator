import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockExistsSync,
  mockMkdirSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockUnlinkSync,
  mockOpenSync,
  mockCloseSync,
  mockSpawn,
  mockGetProjectBaseDir,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockOpenSync: vi.fn(),
  mockCloseSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockGetProjectBaseDir: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
  openSync: mockOpenSync,
  closeSync: mockCloseSync,
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("@composio/ao-core", () => ({
  getProjectBaseDir: mockGetProjectBaseDir,
}));

import type { OrchestratorConfig } from "@composio/ao-core";
import {
  getLifecyclePidFile,
  getLifecycleLogFile,
  writeLifecycleWorkerPid,
  clearLifecycleWorkerPid,
  getLifecycleWorkerStatus,
  ensureLifecycleWorker,
  stopLifecycleWorker,
} from "../../src/lib/lifecycle-service.js";

function makeConfig(projectId = "proj1", projectPath = "/home/user/proj"): OrchestratorConfig {
  return {
    configPath: "/home/user/.ao/config.yaml",
    projects: {
      [projectId]: { path: projectPath },
    },
  } as unknown as OrchestratorConfig;
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockGetProjectBaseDir.mockReturnValue("/home/user/.ao/projects/proj1");
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue("");
  mockMkdirSync.mockReturnValue(undefined);
  mockWriteFileSync.mockReturnValue(undefined);
  mockUnlinkSync.mockReturnValue(undefined);
  mockOpenSync.mockReturnValue(42);
  mockCloseSync.mockReturnValue(undefined);
});

describe("getLifecyclePidFile", () => {
  it("returns path to lifecycle-worker.pid under project base dir", () => {
    const config = makeConfig();
    const result = getLifecyclePidFile(config, "proj1");
    expect(result).toBe("/home/user/.ao/projects/proj1/lifecycle-worker.pid");
    expect(mockGetProjectBaseDir).toHaveBeenCalledWith(
      "/home/user/.ao/config.yaml",
      "/home/user/proj",
    );
  });

  it("throws for unknown project", () => {
    const config = makeConfig();
    expect(() => getLifecyclePidFile(config, "unknown")).toThrow("Unknown project: unknown");
  });
});

describe("getLifecycleLogFile", () => {
  it("returns path to lifecycle-worker.log under project base dir", () => {
    const config = makeConfig();
    const result = getLifecycleLogFile(config, "proj1");
    expect(result).toBe("/home/user/.ao/projects/proj1/lifecycle-worker.log");
  });

  it("throws for unknown project", () => {
    const config = makeConfig();
    expect(() => getLifecycleLogFile(config, "nope")).toThrow("Unknown project: nope");
  });
});

describe("writeLifecycleWorkerPid", () => {
  it("creates directory and writes PID file", () => {
    const config = makeConfig();
    writeLifecycleWorkerPid(config, "proj1", 12345);
    expect(mockMkdirSync).toHaveBeenCalledWith("/home/user/.ao/projects/proj1", {
      recursive: true,
    });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/home/user/.ao/projects/proj1/lifecycle-worker.pid",
      "12345\n",
      "utf-8",
    );
  });
});

describe("clearLifecycleWorkerPid", () => {
  it("does nothing if PID file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const config = makeConfig();
    clearLifecycleWorkerPid(config, "proj1");
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("deletes PID file when no pid argument is given", () => {
    mockExistsSync.mockReturnValue(true);
    const config = makeConfig();
    clearLifecycleWorkerPid(config, "proj1");
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      "/home/user/.ao/projects/proj1/lifecycle-worker.pid",
    );
  });

  it("deletes PID file when pid matches file content", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("999\n");
    const config = makeConfig();
    clearLifecycleWorkerPid(config, "proj1", 999);
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("does NOT delete PID file when pid does not match file content", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("888\n");
    const config = makeConfig();
    clearLifecycleWorkerPid(config, "proj1", 999);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("silently swallows unlink errors", () => {
    mockExistsSync.mockReturnValue(true);
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const config = makeConfig();
    expect(() => clearLifecycleWorkerPid(config, "proj1")).not.toThrow();
  });
});

describe("getLifecycleWorkerStatus", () => {
  it("returns running=true when PID file exists and process is alive", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("1234\n");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const config = makeConfig();
    const status = getLifecycleWorkerStatus(config, "proj1");
    expect(status.running).toBe(true);
    expect(status.pid).toBe(1234);
    killSpy.mockRestore();
  });

  it("returns running=false and clears stale PID when process is not alive", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("9999\n");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    const config = makeConfig();
    const status = getLifecycleWorkerStatus(config, "proj1");
    expect(status.running).toBe(false);
    expect(status.pid).toBe(null);
    killSpy.mockRestore();
  });

  it("returns running=true when EPERM (process exists but no permission)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("5555\n");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    const config = makeConfig();
    const status = getLifecycleWorkerStatus(config, "proj1");
    expect(status.running).toBe(true);
    expect(status.pid).toBe(5555);
    killSpy.mockRestore();
  });

  it("returns running=false when no PID file exists", () => {
    mockExistsSync.mockReturnValue(false);
    const config = makeConfig();
    const status = getLifecycleWorkerStatus(config, "proj1");
    expect(status.running).toBe(false);
    expect(status.pid).toBe(null);
  });

  it("returns running=false when PID file contains garbage", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not-a-number\n");
    const config = makeConfig();
    const status = getLifecycleWorkerStatus(config, "proj1");
    expect(status.running).toBe(false);
    expect(status.pid).toBe(null);
  });

  it("includes pidFile and logFile paths in status", () => {
    mockExistsSync.mockReturnValue(false);
    const config = makeConfig();
    const status = getLifecycleWorkerStatus(config, "proj1");
    expect(status.pidFile).toBe("/home/user/.ao/projects/proj1/lifecycle-worker.pid");
    expect(status.logFile).toBe("/home/user/.ao/projects/proj1/lifecycle-worker.log");
  });
});

describe("ensureLifecycleWorker", () => {
  it("returns started=false when worker is already running", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("1234\n");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const config = makeConfig();
    const result = await ensureLifecycleWorker(config, "proj1");
    expect(result.started).toBe(false);
    expect(result.running).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("spawns a lifecycle worker when not running and returns started=true", async () => {
    // First call to getLifecycleWorkerStatus: not running
    // Second call (waitForLifecycleWorker): running
    let callCount = 0;
    mockExistsSync.mockImplementation(() => {
      callCount++;
      // After spawn writes PID, subsequent calls should find the file
      return callCount > 2;
    });
    mockReadFileSync.mockReturnValue("5678\n");

    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      // After spawn, the process should be running
      if (pid === 5678) return true;
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    const mockChild = {
      pid: 5678,
      unref: vi.fn(),
    };
    mockSpawn.mockReturnValue(mockChild);

    const config = makeConfig();
    const result = await ensureLifecycleWorker(config, "proj1");
    expect(result.started).toBe(true);
    expect(result.running).toBe(true);
    expect(mockSpawn).toHaveBeenCalled();
    expect(mockChild.unref).toHaveBeenCalled();
    expect(mockCloseSync).toHaveBeenCalledTimes(2); // stdout and stderr file descriptors
    killSpy.mockRestore();
  });

  it("throws when worker fails to start within timeout", async () => {
    // Always report not running
    mockExistsSync.mockReturnValue(false);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    const mockChild = { pid: 7777, unref: vi.fn() };
    mockSpawn.mockReturnValue(mockChild);

    const config = makeConfig();
    // Use a very short timeout to speed up the test. We need to mock the internal
    // waitForLifecycleWorker which polls every 100ms. The function uses 5000ms default.
    // Since we can't easily override the timeout, we rely on the fact that after
    // the deadline passes, the status check will still be not-running.
    await expect(ensureLifecycleWorker(config, "proj1")).rejects.toThrow(
      /Lifecycle worker failed to start/,
    );
    killSpy.mockRestore();
  }, 15_000);
});

describe("stopLifecycleWorker", () => {
  it("returns false when worker is not running", async () => {
    mockExistsSync.mockReturnValue(false);
    const config = makeConfig();
    const result = await stopLifecycleWorker(config, "proj1");
    expect(result).toBe(false);
  });

  it("sends SIGTERM and returns true when process stops", async () => {
    // For getLifecycleWorkerStatus: running
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("1234\n");
    let killed = false;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, sig?: string | number) => {
      if (sig === 0 || sig === undefined) {
        if (killed) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      }
      if (sig === "SIGTERM") {
        killed = true;
        return true;
      }
      return true;
    });

    const config = makeConfig();
    const result = await stopLifecycleWorker(config, "proj1");
    expect(result).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(1234, "SIGTERM");
    killSpy.mockRestore();
  });

  it("returns false when SIGTERM itself throws (process already gone)", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("1234\n");
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, sig?: string | number) => {
      if (sig === 0 || sig === undefined) return true; // Appears running for status check
      if (sig === "SIGTERM") {
        throw new Error("ESRCH");
      }
      return true;
    });

    const config = makeConfig();
    const result = await stopLifecycleWorker(config, "proj1");
    expect(result).toBe(false);
    killSpy.mockRestore();
  });

  it("falls back to SIGKILL when process does not stop after SIGTERM", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("1234\n");
    // Process stays alive after SIGTERM, always responds to kill(0)
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, _sig?: string | number) => {
      return true;
    });

    const config = makeConfig();
    const result = await stopLifecycleWorker(config, "proj1");
    expect(result).toBe(true);
    // Should have attempted SIGTERM then SIGKILL
    const sigTermCalls = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM");
    const sigKillCalls = killSpy.mock.calls.filter((c) => c[1] === "SIGKILL");
    expect(sigTermCalls.length).toBeGreaterThanOrEqual(1);
    expect(sigKillCalls.length).toBeGreaterThanOrEqual(1);
    killSpy.mockRestore();
  }, 15_000);
});
