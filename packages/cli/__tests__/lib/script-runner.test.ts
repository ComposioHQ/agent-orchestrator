import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("node:path", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    resolve: vi.fn((...args: string[]) => actual.resolve(...args)),
    dirname: vi.fn((...args: [string]) => actual.dirname(...args)),
  };
});

vi.mock("node:url", () => ({
  fileURLToPath: vi.fn(() => "/mock/cli/src/lib/script-runner.ts"),
}));

vi.mock("@aoagents/ao-core", () => ({
  isWindows: vi.fn(() => false),
}));

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as core from "@aoagents/ao-core";
import { runRepoScript } from "../../src/lib/script-runner.js";

const mockIsWindows = core.isWindows as ReturnType<typeof vi.fn>;
const mockSpawn = childProcess.spawn as ReturnType<typeof vi.fn>;
const mockExistsSync = fs.existsSync as ReturnType<typeof vi.fn>;

function makeSpawnEventEmitter(exitCode = 0) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const child = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      return child;
    }),
    emit: (event: string, ...args: unknown[]) => {
      (listeners[event] ?? []).forEach((cb) => cb(...args));
    },
  };

  // Simulate async exit
  setTimeout(() => child.emit("exit", exitCode, null), 0);

  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["AO_BASH_PATH"];
  mockIsWindows.mockReturnValue(false);
  mockExistsSync.mockReturnValue(true);
});

afterEach(() => {
  delete process.env["AO_BASH_PATH"];
});

describe("runRepoScript", () => {
  it("uses bash on Unix when AO_BASH_PATH not set (scripts have #!/bin/bash shebangs)", async () => {
    mockIsWindows.mockReturnValue(false);
    const child = makeSpawnEventEmitter(0);
    mockSpawn.mockReturnValue(child);

    await runRepoScript("test-script.sh", []);

    expect(mockSpawn).toHaveBeenCalledWith("bash", expect.any(Array), expect.any(Object));
  });

  it("uses AO_BASH_PATH override when set on Unix", async () => {
    process.env["AO_BASH_PATH"] = "/custom/bash";
    const child = makeSpawnEventEmitter(0);
    mockSpawn.mockReturnValue(child);

    await runRepoScript("test-script.sh", []);

    expect(mockSpawn).toHaveBeenCalledWith("/custom/bash", expect.any(Array), expect.any(Object));
  });

  it("passes extra args to script directly (not via -c)", async () => {
    mockIsWindows.mockReturnValue(false);
    const child = makeSpawnEventEmitter(0);
    mockSpawn.mockReturnValue(child);

    await runRepoScript("test-script.sh", ["--fix", "--verbose"]);

    const spawnCall = mockSpawn.mock.calls[0];
    expect(spawnCall[1]).not.toContain("-c");
    expect(spawnCall[1]).toContain("--fix");
    expect(spawnCall[1]).toContain("--verbose");
    const scriptIdx = (spawnCall[1] as string[]).findIndex((a: string) =>
      a.includes("test-script.sh"),
    );
    expect((spawnCall[1] as string[])[scriptIdx + 1]).toBe("--fix");
  });

  it("throws a clear error on Windows when AO_BASH_PATH is not set and Git Bash is not installed", async () => {
    mockIsWindows.mockReturnValue(true);
    // No bash anywhere — auto-detect fails.
    mockExistsSync.mockImplementation((p: string) => !p.endsWith("bash.exe"));

    await expect(runRepoScript("test-script.sh", [])).rejects.toThrow(
      /Cannot run repo scripts on Windows without bash.*Git for Windows.*AO_BASH_PATH/s,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("auto-detects Git Bash on Windows when AO_BASH_PATH is not set", async () => {
    mockIsWindows.mockReturnValue(true);
    mockExistsSync.mockImplementation(
      (p: string) => p === "C:\\Program Files\\Git\\bin\\bash.exe" || p.endsWith(".sh"),
    );
    const child = makeSpawnEventEmitter(0);
    mockSpawn.mockReturnValue(child);

    await runRepoScript("test-script.sh", []);

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\Program Files\\Git\\bin\\bash.exe",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("uses AO_BASH_PATH override on Windows and does not throw", async () => {
    process.env["AO_BASH_PATH"] = "C:\\Program Files\\Git\\bin\\bash.exe";
    mockIsWindows.mockReturnValue(true);
    const child = makeSpawnEventEmitter(0);
    mockSpawn.mockReturnValue(child);

    await runRepoScript("test-script.sh", ["--fix"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\Program Files\\Git\\bin\\bash.exe",
      expect.any(Array),
      expect.any(Object),
    );
  });
});
