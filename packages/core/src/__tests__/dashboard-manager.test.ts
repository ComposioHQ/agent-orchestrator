import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  type DashboardRestartOpts,
  readPidFile,
  writePidFile,
  removePidFile,
  waitForHealthy,
  getDashboardStatus,
  stopDashboard,
  restartDashboard,
} from "../dashboard-manager.js";

// ---------------------------------------------------------------------------
// Hoisted mock functions — vi.hoisted() runs before vi.mock factories
// ---------------------------------------------------------------------------
const {
  mockExecFile,
  mockSpawn,
  mockExistsSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockUnlinkSync,
  mockRmSync,
  mockMkdirSync,
  mockOpenSync,
  mockCloseSync,
  mockFetch,
} = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockOpenSync: vi.fn(),
  mockCloseSync: vi.fn(),
  mockFetch: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  spawn: mockSpawn,
}));

// ---------------------------------------------------------------------------
// Mock node:fs
// ---------------------------------------------------------------------------
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
  rmSync: mockRmSync,
  mkdirSync: mockMkdirSync,
  openSync: mockOpenSync,
  closeSync: mockCloseSync,
}));

// ---------------------------------------------------------------------------
// Mock node:util — promisify wraps our mock execFile as a promise-returning fn
// ---------------------------------------------------------------------------
vi.mock("node:util", () => ({
  promisify: (fn: unknown) => {
    if (fn === mockExecFile) {
      return (...args: unknown[]) => {
        return new Promise((resolve, reject) => {
          type CbFn = (...a: [...unknown[], (err: Error | null, stdout: string, stderr: string) => void]) => void;
          (fn as CbFn)(...args, (err: Error | null, stdout: string, stderr: string) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          });
        });
      };
    }
    throw new Error("promisify called with unexpected function");
  },
}));

// ---------------------------------------------------------------------------
// Mock global fetch for waitForHealthy
// ---------------------------------------------------------------------------
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate a successful `lsof` call returning a PID. */
function mockLsofReturnsPid(pid: number): void {
  mockExecFile.mockImplementation(
    (
      cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (cmd === "lsof") {
        cb(null, `${pid}\n`, "");
      } else {
        cb(new Error("unknown command"), "", "");
      }
    },
  );
}

/** Simulate `lsof` finding nothing (exit code 1). */
function mockLsofReturnsEmpty(): void {
  mockExecFile.mockImplementation(
    (
      cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (cmd === "lsof") {
        cb(new Error("exit code 1"), "", "");
      } else {
        cb(new Error("unknown command"), "", "");
      }
    },
  );
}

/** Create a fake ChildProcess-like object from spawn. */
function makeFakeChild(pid: number | undefined): Partial<ChildProcess> {
  return {
    pid,
    unref: vi.fn(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Reset all mocks individually so implementations are cleared
  mockExecFile.mockReset();
  mockSpawn.mockReset();
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockWriteFileSync.mockReset();
  mockUnlinkSync.mockReset();
  mockRmSync.mockReset();
  mockMkdirSync.mockReset();
  mockOpenSync.mockReset();
  mockCloseSync.mockReset();
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// =========================================================================
// readPidFile
// =========================================================================
describe("readPidFile", () => {
  it("returns null when PID file does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    expect(readPidFile("/tmp/logs")).toBeNull();
    expect(mockExistsSync).toHaveBeenCalledWith("/tmp/logs/dashboard.pid");
  });

  it("returns PID when file exists and process is alive", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("42\n");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = readPidFile("/tmp/logs");

    expect(result).toBe(42);
    expect(killSpy).toHaveBeenCalledWith(42, 0);
  });

  it("returns null and cleans up when PID file contains NaN", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not-a-number\n");

    const result = readPidFile("/tmp/logs");

    expect(result).toBeNull();
  });

  it("returns null and removes stale PID file when process is dead", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("99999\n");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });

    const result = readPidFile("/tmp/logs");

    expect(result).toBeNull();
    expect(killSpy).toHaveBeenCalledWith(99999, 0);
    // Should attempt to remove the stale PID file
    expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/logs/dashboard.pid");
  });

  it("handles unlink failure gracefully when cleaning stale PID", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("99999\n");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("EACCES");
    });

    // Should not throw even if unlink fails
    expect(() => readPidFile("/tmp/logs")).not.toThrow();
    expect(readPidFile("/tmp/logs")).toBeNull();
  });
});

// =========================================================================
// writePidFile
// =========================================================================
describe("writePidFile", () => {
  it("writes the PID as a string to the correct path", () => {
    writePidFile("/tmp/logs", 1234);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/logs/dashboard.pid",
      "1234",
      "utf-8",
    );
  });

  it("handles large PIDs", () => {
    writePidFile("/var/ao", 4294967295);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/var/ao/dashboard.pid",
      "4294967295",
      "utf-8",
    );
  });
});

// =========================================================================
// removePidFile
// =========================================================================
describe("removePidFile", () => {
  it("removes the PID file when it exists", () => {
    mockExistsSync.mockReturnValue(true);

    removePidFile("/tmp/logs");

    expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/logs/dashboard.pid");
  });

  it("does nothing when PID file does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    removePidFile("/tmp/logs");

    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("does not throw when unlink fails", () => {
    mockExistsSync.mockReturnValue(true);
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("EACCES");
    });

    expect(() => removePidFile("/tmp/logs")).not.toThrow();
  });

  it("does not throw when existsSync fails", () => {
    mockExistsSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(() => removePidFile("/tmp/logs")).not.toThrow();
  });
});

// =========================================================================
// waitForHealthy
// =========================================================================
describe("waitForHealthy", () => {
  it("returns true when fetch succeeds with 200", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await waitForHealthy(3000, 5000);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns true when server responds with 404", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    const result = await waitForHealthy(3000, 5000);

    expect(result).toBe(true);
  });

  it("returns false on timeout when fetch keeps failing", async () => {
    vi.useFakeTimers();

    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const resultPromise = waitForHealthy(3000, 3000);

    // The function polls every 1000ms. Advance past the deadline.
    // First attempt: immediate, fails -> waits 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // Second attempt: fails -> waits 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // Third attempt: fails -> waits 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // Past deadline, should exit loop
    await vi.advanceTimersByTimeAsync(1000);

    const result = await resultPromise;
    expect(result).toBe(false);
  });

  it("succeeds after initial failures when server eventually responds", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    const resultPromise = waitForHealthy(3000, 10_000);

    // First call fails immediately, then waits 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // Second call fails, waits 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // Third call succeeds (callCount === 3)
    await vi.advanceTimersByTimeAsync(1000);

    const result = await resultPromise;
    expect(result).toBe(true);
  });

  it("handles 500 server error (not ok, not 404) and retries", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Server error — not ok and not 404
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    const resultPromise = waitForHealthy(3000, 10_000);

    // First attempt returns 500, but res.ok is false and status != 404, so no early return.
    // Wait for poll interval
    await vi.advanceTimersByTimeAsync(1000);
    // Second attempt returns 200
    await vi.advanceTimersByTimeAsync(1000);

    const result = await resultPromise;
    expect(result).toBe(true);
  });

  it("uses default timeout of 30000ms", async () => {
    vi.useFakeTimers();

    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const resultPromise = waitForHealthy(3000);

    // Advance 30 seconds + a bit to exceed the deadline
    for (let i = 0; i < 32; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    const result = await resultPromise;
    expect(result).toBe(false);
  });
});

// =========================================================================
// getDashboardStatus
// =========================================================================
describe("getDashboardStatus", () => {
  it('returns pid_file source when PID file has a live process', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("1234\n");
    vi.spyOn(process, "kill").mockImplementation(() => true);
    mockLsofReturnsEmpty(); // port scan would find nothing

    const status = await getDashboardStatus("/tmp/logs", 3000);

    expect(status).toEqual({ running: true, pid: 1234, source: "pid_file" });
  });

  it('returns port_scan source when no PID file but port is occupied', async () => {
    // PID file does not exist
    mockExistsSync.mockReturnValue(false);
    // lsof finds a process on the port
    mockLsofReturnsPid(5678);

    const status = await getDashboardStatus("/tmp/logs", 3000);

    expect(status).toEqual({ running: true, pid: 5678, source: "port_scan" });
  });

  it("returns not running when neither PID file nor port scan finds a process", async () => {
    mockExistsSync.mockReturnValue(false);
    mockLsofReturnsEmpty();

    const status = await getDashboardStatus("/tmp/logs", 3000);

    expect(status).toEqual({ running: false, pid: null, source: null });
  });

  it("prefers PID file over port scan when both would find a process", async () => {
    // PID file exists and is alive
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("1111\n");
    vi.spyOn(process, "kill").mockImplementation(() => true);
    // Port scan would also find something
    mockLsofReturnsPid(2222);

    const status = await getDashboardStatus("/tmp/logs", 3000);

    // Should return the PID from the file, not from port scan
    expect(status).toEqual({ running: true, pid: 1111, source: "pid_file" });
  });

  it("falls back to port scan when PID file has stale process", async () => {
    // First call to existsSync (in readPidFile) returns true for PID file
    // but process.kill throws (stale PID)
    mockExistsSync.mockImplementation((path: string) => {
      return (path as string).endsWith("dashboard.pid");
    });
    mockReadFileSync.mockReturnValue("9999\n");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    mockLsofReturnsPid(5555);

    const status = await getDashboardStatus("/tmp/logs", 3000);

    // readPidFile returns null (stale), falls through to port scan
    expect(status).toEqual({ running: true, pid: 5555, source: "port_scan" });
  });
});

// =========================================================================
// stopDashboard
// =========================================================================
describe("stopDashboard", () => {
  it("returns false when no process is found", async () => {
    // No PID file
    mockExistsSync.mockReturnValue(false);
    // No process on port
    mockLsofReturnsEmpty();

    const result = await stopDashboard("/tmp/logs", 3000);

    expect(result).toBe(false);
  });

  it("kills process found via PID file and returns true", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("1234\n");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    // After kill, lsof should find nothing (port released)
    let lsofCallCount = 0;
    mockExecFile.mockImplementation(
      (
        cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd === "lsof") {
          lsofCallCount++;
          // First call in findPidOnPort from stopDashboard returns the PID,
          // subsequent calls from waitForPortFree return nothing (port freed)
          if (lsofCallCount <= 1) {
            cb(null, "1234\n", "");
          } else {
            cb(new Error("exit code 1"), "", "");
          }
        }
      },
    );

    const result = await stopDashboard("/tmp/logs", 3000);

    expect(result).toBe(true);
    // Check that SIGTERM was sent (call 0 is the kill(pid,0) check, call 1 is SIGTERM)
    expect(killSpy).toHaveBeenCalledWith(1234, "SIGTERM");
  });

  it("kills process found via port scan when no PID file", async () => {
    mockExistsSync.mockReturnValue(false);

    let lsofCallCount = 0;
    mockExecFile.mockImplementation(
      (
        cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd === "lsof") {
          lsofCallCount++;
          // First call finds the PID, second call in waitForPortFree finds nothing
          if (lsofCallCount <= 1) {
            cb(null, "5678\n", "");
          } else {
            cb(new Error("exit code 1"), "", "");
          }
        }
      },
    );

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await stopDashboard("/tmp/logs", 3000);

    expect(result).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(5678, "SIGTERM");
  });

  it("handles process already exited when sending SIGTERM", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("1234\n");

    let killCallCount = 0;
    vi.spyOn(process, "kill").mockImplementation((..._args: unknown[]) => {
      killCallCount++;
      if (killCallCount === 1) {
        // kill(pid, 0) — alive check succeeds
        return true;
      }
      // kill(pid, SIGTERM) — process already gone
      throw new Error("ESRCH");
    });

    // Port is already free (process already exited)
    mockLsofReturnsEmpty();

    const result = await stopDashboard("/tmp/logs", 3000);

    expect(result).toBe(true);
  });

  it("removes PID file after stopping", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("1234\n");
    vi.spyOn(process, "kill").mockImplementation(() => true);
    mockLsofReturnsEmpty();

    await stopDashboard("/tmp/logs", 3000);

    // removePidFile checks existsSync and calls unlinkSync
    expect(mockUnlinkSync).toHaveBeenCalled();
  });
});

// =========================================================================
// restartDashboard
// =========================================================================
describe("restartDashboard", () => {
  function makeOpts(overrides: Partial<DashboardRestartOpts> = {}): DashboardRestartOpts {
    return {
      webDir: "/app/packages/web",
      logDir: "/tmp/ao-logs",
      ...overrides,
    };
  }

  /** Set up mocks for a fresh start (no existing process). */
  function setupFreshStart(spawnPid: number = 12345): void {
    // No PID file
    mockExistsSync.mockReturnValue(false);
    // No process on port
    mockLsofReturnsEmpty();
    // openSync returns file descriptors
    mockOpenSync.mockReturnValueOnce(10).mockReturnValueOnce(11);
    // spawn returns a child with a PID
    mockSpawn.mockReturnValue(makeFakeChild(spawnPid));
  }

  it("spawns a new process when no existing process is running", async () => {
    setupFreshStart(42);

    const result = await restartDashboard(makeOpts());

    expect(result).toEqual({ pid: 42, killed: false, cleaned: false });
    expect(mockSpawn).toHaveBeenCalledWith(
      "npx",
      ["next", "dev", "-p", "3000"],
      expect.objectContaining({
        cwd: "/app/packages/web",
        detached: true,
      }),
    );
  });

  it("uses specified port instead of default 3000", async () => {
    setupFreshStart(100);

    const result = await restartDashboard(makeOpts({ port: 8080 }));

    expect(result.pid).toBe(100);
    expect(mockSpawn).toHaveBeenCalledWith(
      "npx",
      ["next", "dev", "-p", "8080"],
      expect.objectContaining({
        cwd: "/app/packages/web",
      }),
    );
  });

  it("kills existing process found via PID file", async () => {
    // PID file says process 999 is running
    const existsSyncImpl = (path: string) => {
      if ((path as string).endsWith("dashboard.pid")) return true;
      if ((path as string).endsWith(".next")) return false;
      return false;
    };
    mockExistsSync.mockImplementation(existsSyncImpl);
    mockReadFileSync.mockReturnValue("999\n");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    // lsof: first call for initial findPidOnPort (in restartDashboard),
    // subsequent calls for waitForPortFree should find nothing
    let lsofCallCount = 0;
    mockExecFile.mockImplementation(
      (
        cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd === "lsof") {
          lsofCallCount++;
          if (lsofCallCount <= 1) {
            cb(null, "999\n", "");
          } else {
            cb(new Error("exit code 1"), "", "");
          }
        }
      },
    );

    mockOpenSync.mockReturnValueOnce(10).mockReturnValueOnce(11);
    mockSpawn.mockReturnValue(makeFakeChild(1000));

    const result = await restartDashboard(makeOpts());

    expect(result.killed).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(999, "SIGTERM");
  });

  it("kills existing process found via port scan when no PID file", async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if ((path as string).endsWith("dashboard.pid")) return false;
      return false;
    });

    let lsofCallCount = 0;
    mockExecFile.mockImplementation(
      (
        cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd === "lsof") {
          lsofCallCount++;
          if (lsofCallCount <= 1) {
            cb(null, "888\n", "");
          } else {
            cb(new Error("exit code 1"), "", "");
          }
        }
      },
    );

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    mockOpenSync.mockReturnValueOnce(10).mockReturnValueOnce(11);
    mockSpawn.mockReturnValue(makeFakeChild(2000));

    const result = await restartDashboard(makeOpts());

    expect(result.killed).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(888, "SIGTERM");
    expect(result.pid).toBe(2000);
  });

  it("cleans .next directory when clean: true and .next exists", async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if ((path as string).endsWith("dashboard.pid")) return false;
      if ((path as string).endsWith(".next")) return true;
      // logDir exists
      return true;
    });
    mockLsofReturnsEmpty();
    mockOpenSync.mockReturnValueOnce(10).mockReturnValueOnce(11);
    mockSpawn.mockReturnValue(makeFakeChild(500));

    const result = await restartDashboard(makeOpts({ clean: true }));

    expect(result.cleaned).toBe(true);
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining(".next"),
      { recursive: true, force: true },
    );
  });

  it("does not clean when clean: true but .next does not exist", async () => {
    // All existsSync calls return false (no PID, no .next)
    mockExistsSync.mockReturnValue(false);
    mockLsofReturnsEmpty();
    mockOpenSync.mockReturnValueOnce(10).mockReturnValueOnce(11);
    mockSpawn.mockReturnValue(makeFakeChild(500));

    const result = await restartDashboard(makeOpts({ clean: true }));

    expect(result.cleaned).toBe(false);
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("does not clean when clean option is not set", async () => {
    setupFreshStart(500);

    const result = await restartDashboard(makeOpts());

    expect(result.cleaned).toBe(false);
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("creates log directory if it does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    mockLsofReturnsEmpty();
    mockOpenSync.mockReturnValueOnce(10).mockReturnValueOnce(11);
    mockSpawn.mockReturnValue(makeFakeChild(123));

    await restartDashboard(makeOpts({ logDir: "/new/logs" }));

    expect(mockMkdirSync).toHaveBeenCalledWith("/new/logs", { recursive: true });
  });

  it("opens log files for stdout and stderr", async () => {
    setupFreshStart(123);

    await restartDashboard(makeOpts({ logDir: "/tmp/ao-logs" }));

    expect(mockOpenSync).toHaveBeenCalledWith("/tmp/ao-logs/dashboard.out.log", "a");
    expect(mockOpenSync).toHaveBeenCalledWith("/tmp/ao-logs/dashboard.err.log", "a");
  });

  it("closes file descriptors after spawn", async () => {
    mockExistsSync.mockReturnValue(false);
    mockLsofReturnsEmpty();
    mockOpenSync.mockReturnValueOnce(42).mockReturnValueOnce(43);
    mockSpawn.mockReturnValue(makeFakeChild(100));

    await restartDashboard(makeOpts());

    expect(mockCloseSync).toHaveBeenCalledWith(42);
    expect(mockCloseSync).toHaveBeenCalledWith(43);
  });

  it("unrefs the child process so parent can exit", async () => {
    setupFreshStart(100);
    const fakeChild = makeFakeChild(100);
    mockSpawn.mockReturnValue(fakeChild);

    await restartDashboard(makeOpts());

    expect(fakeChild.unref).toHaveBeenCalled();
  });

  it("writes PID file after successful spawn", async () => {
    setupFreshStart(7777);

    await restartDashboard(makeOpts({ logDir: "/tmp/ao-logs" }));

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/ao-logs/dashboard.pid",
      "7777",
      "utf-8",
    );
  });

  it("does not write PID file when spawn returns no PID", async () => {
    mockExistsSync.mockReturnValue(false);
    mockLsofReturnsEmpty();
    mockOpenSync.mockReturnValueOnce(10).mockReturnValueOnce(11);
    mockSpawn.mockReturnValue(makeFakeChild(undefined));

    const result = await restartDashboard(makeOpts());

    expect(result.pid).toBeNull();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("calls onStatus with progress messages for fresh start", async () => {
    setupFreshStart(555);
    const messages: string[] = [];

    await restartDashboard(
      makeOpts({ onStatus: (msg) => messages.push(msg) }),
    );

    // Fresh start: only "Dashboard started" message
    expect(messages.some((m) => m.includes("Dashboard started"))).toBe(true);
    expect(messages.some((m) => m.includes("555"))).toBe(true);
  });

  it("calls onStatus with stop and start messages when killing existing", async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if ((path as string).endsWith("dashboard.pid")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue("100\n");
    vi.spyOn(process, "kill").mockImplementation(() => true);

    let lsofCallCount = 0;
    mockExecFile.mockImplementation(
      (
        cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd === "lsof") {
          lsofCallCount++;
          if (lsofCallCount <= 1) {
            cb(null, "100\n", "");
          } else {
            cb(new Error("exit code 1"), "", "");
          }
        }
      },
    );
    mockOpenSync.mockReturnValueOnce(10).mockReturnValueOnce(11);
    mockSpawn.mockReturnValue(makeFakeChild(200));

    const messages: string[] = [];

    await restartDashboard(
      makeOpts({ onStatus: (msg) => messages.push(msg) }),
    );

    expect(messages.some((m) => m.includes("Stopping"))).toBe(true);
    expect(messages.some((m) => m.includes("stopped"))).toBe(true);
    expect(messages.some((m) => m.includes("started"))).toBe(true);
  });

  it("calls onStatus with clean messages when cleaning", async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if ((path as string).endsWith("dashboard.pid")) return false;
      if ((path as string).endsWith(".next")) return true;
      return true;
    });
    mockLsofReturnsEmpty();
    mockOpenSync.mockReturnValueOnce(10).mockReturnValueOnce(11);
    mockSpawn.mockReturnValue(makeFakeChild(300));

    const messages: string[] = [];

    await restartDashboard(
      makeOpts({ clean: true, onStatus: (msg) => messages.push(msg) }),
    );

    expect(messages.some((m) => m.includes("Cleaning"))).toBe(true);
    expect(messages.some((m) => m.includes("cleaned"))).toBe(true);
  });

  it("passes AO_CONFIG_PATH to the spawned process env", async () => {
    setupFreshStart(100);

    await restartDashboard(
      makeOpts({ configPath: "/path/to/config.yaml" }),
    );

    const spawnCall = mockSpawn.mock.calls[0];
    const spawnOpts = spawnCall[2];
    expect(spawnOpts.env["AO_CONFIG_PATH"]).toBe("/path/to/config.yaml");
  });

  it("sets PORT in spawned process env", async () => {
    setupFreshStart(100);

    await restartDashboard(makeOpts({ port: 9999 }));

    const spawnCall = mockSpawn.mock.calls[0];
    const spawnOpts = spawnCall[2];
    expect(spawnOpts.env["PORT"]).toBe("9999");
  });

  it("spawns process with stdio pointing to file descriptors", async () => {
    mockExistsSync.mockReturnValue(false);
    mockLsofReturnsEmpty();
    mockOpenSync.mockReturnValueOnce(77).mockReturnValueOnce(88);
    mockSpawn.mockReturnValue(makeFakeChild(100));

    await restartDashboard(makeOpts());

    const spawnCall = mockSpawn.mock.calls[0];
    const spawnOpts = spawnCall[2];
    expect(spawnOpts.stdio).toEqual(["ignore", 77, 88]);
  });

  it("returns full result with killed, cleaned, and pid", async () => {
    // Existing process to kill
    mockExistsSync.mockImplementation((path: string) => {
      if ((path as string).endsWith("dashboard.pid")) return true;
      if ((path as string).endsWith(".next")) return true;
      return true;
    });
    mockReadFileSync.mockReturnValue("111\n");
    vi.spyOn(process, "kill").mockImplementation(() => true);

    let lsofCallCount = 0;
    mockExecFile.mockImplementation(
      (
        cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd === "lsof") {
          lsofCallCount++;
          if (lsofCallCount <= 1) {
            cb(null, "111\n", "");
          } else {
            cb(new Error("exit code 1"), "", "");
          }
        }
      },
    );
    mockOpenSync.mockReturnValueOnce(10).mockReturnValueOnce(11);
    mockSpawn.mockReturnValue(makeFakeChild(222));

    const result = await restartDashboard(
      makeOpts({ clean: true }),
    );

    expect(result).toEqual({ pid: 222, killed: true, cleaned: true });
  });
});
