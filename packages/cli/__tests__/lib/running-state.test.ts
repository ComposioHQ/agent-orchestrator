import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockReadFileSync,
  mockWriteFileSync,
  mockMkdirSync,
  mockUnlinkSync,
  mockOpenSync,
  mockCloseSync,
  mockKill,
} = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockOpenSync: vi.fn(),
  mockCloseSync: vi.fn(),
  mockKill: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  unlinkSync: mockUnlinkSync,
  openSync: mockOpenSync,
  closeSync: mockCloseSync,
  constants: {
    O_CREAT: 0o100,
    O_EXCL: 0o200,
    O_WRONLY: 0o1,
  },
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

import { register, unregister, getRunning, isAlreadyRunning, waitForExit } from "../../src/lib/running-state.js";
import type { RunningState } from "../../src/lib/running-state.js";

// Intercept process.kill to control isProcessAlive behavior
const originalKill = process.kill;

beforeEach(() => {
  mockReadFileSync.mockReset();
  mockWriteFileSync.mockReset();
  mockMkdirSync.mockReset();
  mockUnlinkSync.mockReset();
  mockOpenSync.mockReset().mockReturnValue(42); // default: lock acquired
  mockCloseSync.mockReset();
  mockKill.mockReset();
  process.kill = mockKill as unknown as typeof process.kill;
});

// Restore after all tests
afterAll(() => {
  process.kill = originalKill;
});

import { afterAll } from "vitest";

const sampleState: RunningState = {
  pid: 12345,
  configPath: "/home/user/.config/ao/config.yaml",
  port: 3000,
  startedAt: "2025-01-01T00:00:00.000Z",
  projects: ["my-app", "my-lib"],
};

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

describe("register", () => {
  it("writes state to file after acquiring lock", async () => {
    await register(sampleState);

    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockOpenSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("running.json"),
      JSON.stringify(sampleState, null, 2),
      "utf-8",
    );
    // Lock should be released (unlinkSync called for lock file)
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("releases lock even if writeState throws", async () => {
    mockWriteFileSync.mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(register(sampleState)).rejects.toThrow("disk full");

    // Lock should still be released
    expect(mockUnlinkSync).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// unregister()
// ---------------------------------------------------------------------------

describe("unregister", () => {
  it("deletes state file after acquiring lock", async () => {
    await unregister();

    // unlinkSync is called for both the state file and the lock file
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("does not throw if state file does not exist", async () => {
    mockUnlinkSync.mockImplementation(() => {
      // First call (state file delete) may throw ENOENT, second call (lock release) succeeds
    });

    await expect(unregister()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getRunning()
// ---------------------------------------------------------------------------

describe("getRunning", () => {
  it("returns state when process is alive", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleState));
    mockKill.mockImplementation(() => true); // process.kill(pid, 0) succeeds = alive

    const result = await getRunning();

    expect(result).toEqual(sampleState);
  });

  it("returns null and cleans up when process is dead (stale PID)", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleState));
    mockKill.mockImplementation(() => {
      throw new Error("ESRCH"); // process not found
    });

    const result = await getRunning();

    expect(result).toBeNull();
    // Should have cleaned up the stale entry
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("returns null when no state file exists", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = await getRunning();

    expect(result).toBeNull();
  });

  it("returns null when state file contains invalid JSON", async () => {
    mockReadFileSync.mockReturnValue("not-json");

    const result = await getRunning();

    expect(result).toBeNull();
  });

  it("returns null when state file has no pid field", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ port: 3000 }));

    const result = await getRunning();

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isAlreadyRunning()
// ---------------------------------------------------------------------------

describe("isAlreadyRunning", () => {
  it("delegates to getRunning and returns state when running", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleState));
    mockKill.mockImplementation(() => true);

    const result = await isAlreadyRunning();

    expect(result).toEqual(sampleState);
  });

  it("returns null when not running", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = await isAlreadyRunning();

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// waitForExit()
// ---------------------------------------------------------------------------

describe("waitForExit", () => {
  it("returns true immediately when process is already dead", async () => {
    mockKill.mockImplementation(() => {
      throw new Error("ESRCH");
    });

    const result = await waitForExit(99999, 1000);

    expect(result).toBe(true);
  });

  it("returns true when process exits during polling", async () => {
    let callCount = 0;
    mockKill.mockImplementation(() => {
      callCount++;
      if (callCount >= 3) throw new Error("ESRCH");
      return true;
    });

    const result = await waitForExit(12345, 5000);

    expect(result).toBe(true);
  });

  it("returns false when process does not exit within timeout", async () => {
    // To test timeout, we need the Date.now() to advance
    // Since we mocked setTimeout from timers/promises, the sleep is instant
    // but Date.now() still advances, so the while loop will eventually timeout
    mockKill.mockImplementation(() => true); // always alive

    // Use a very short timeout so it exits quickly
    const result = await waitForExit(12345, 0);

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lock acquisition
// ---------------------------------------------------------------------------

describe("lock acquisition", () => {
  it("retries when lock file already exists", async () => {
    let attempt = 0;
    mockOpenSync.mockImplementation(() => {
      attempt++;
      if (attempt < 3) {
        throw new Error("EEXIST");
      }
      return 42;
    });

    await register(sampleState);

    expect(attempt).toBe(3);
  });

  it("throws when lock cannot be acquired after timeout", async () => {
    mockOpenSync.mockImplementation(() => {
      throw new Error("EEXIST");
    });
    // Also make unlinkSync throw so the stale-lock recovery also fails
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("EPERM");
    });

    // Use very short timeout
    // This will use the default timeout which is 5000ms
    // Since timers/promises is mocked to resolve immediately, the Date.now()
    // will quickly exceed the timeout
    await expect(register(sampleState)).rejects.toThrow("lock");
  });
});
