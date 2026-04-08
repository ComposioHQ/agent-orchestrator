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

vi.mock("@composio/ao-core", () => ({
  getShell: vi.fn(() => ({ cmd: "sh", args: (c: string) => ["-c", c] })),
  isWindows: vi.fn(() => false),
}));

import * as childProcess from "node:child_process";
import * as core from "@composio/ao-core";
import { runRepoScript } from "../../src/lib/script-runner.js";

const mockGetShell = core.getShell as ReturnType<typeof vi.fn>;
const mockIsWindows = core.isWindows as ReturnType<typeof vi.fn>;
const mockSpawn = childProcess.spawn as ReturnType<typeof vi.fn>;

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
});

afterEach(() => {
  delete process.env["AO_BASH_PATH"];
});

describe("runRepoScript", () => {
  it("uses getShell().cmd as fallback when AO_BASH_PATH not set", async () => {
    mockGetShell.mockReturnValue({ cmd: "sh", args: (c: string) => ["-c", c] });
    const child = makeSpawnEventEmitter(0);
    mockSpawn.mockReturnValue(child);

    await runRepoScript("test-script.sh", []);

    expect(mockSpawn).toHaveBeenCalledWith(
      "sh",
      expect.any(Array),
      expect.any(Object),
    );
    expect(mockGetShell).toHaveBeenCalled();
  });

  it("uses AO_BASH_PATH override when set", async () => {
    process.env["AO_BASH_PATH"] = "/custom/bash";
    const child = makeSpawnEventEmitter(0);
    mockSpawn.mockReturnValue(child);

    await runRepoScript("test-script.sh", []);

    expect(mockSpawn).toHaveBeenCalledWith(
      "/custom/bash",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("passes extra args to script in file mode on Unix (not dropped by -c)", async () => {
    mockIsWindows.mockReturnValue(false);
    mockGetShell.mockReturnValue({ cmd: "bash", args: (c: string) => ["-c", c] });
    const child = makeSpawnEventEmitter(0);
    mockSpawn.mockReturnValue(child);

    await runRepoScript("test-script.sh", ["--fix", "--verbose"]);

    const spawnCall = mockSpawn.mock.calls[0];
    // File mode: [scriptPath, ...args] — extra args must NOT be preceded by -c
    expect(spawnCall[1]).not.toContain("-c");
    expect(spawnCall[1]).toContain("--fix");
    expect(spawnCall[1]).toContain("--verbose");
    // args must follow scriptPath directly, not as shell $0/$1
    const scriptIdx = (spawnCall[1] as string[]).findIndex((a: string) => a.includes("test-script.sh"));
    expect((spawnCall[1] as string[])[scriptIdx + 1]).toBe("--fix");
  });

  it("uses getShell().args() flags on Windows (no AO_BASH_PATH override)", async () => {
    mockIsWindows.mockReturnValue(true);
    mockGetShell.mockReturnValue({
      cmd: "pwsh",
      args: (c: string) => ["-NoLogo", "-NonInteractive", "-Command", c],
    });
    const child = makeSpawnEventEmitter(0);
    mockSpawn.mockReturnValue(child);

    await runRepoScript("test-script.sh", []);

    const spawnCall = mockSpawn.mock.calls[0];
    expect(spawnCall[0]).toBe("pwsh");
    expect(spawnCall[1]).toEqual(
      expect.arrayContaining(["-NoLogo", "-NonInteractive", "-Command"]),
    );
  });
});
