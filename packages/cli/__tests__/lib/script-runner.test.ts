import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSpawn, mockExistsSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

import {
  resolveRepoRoot,
  resolveScriptPath,
  runRepoScript,
  executeScriptCommand,
} from "../../src/lib/script-runner.js";

let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  vi.restoreAllMocks();
  mockExistsSync.mockReturnValue(true);
  envBackup = {
    AO_REPO_ROOT: process.env["AO_REPO_ROOT"],
    AO_BASH_PATH: process.env["AO_BASH_PATH"],
  };
});

afterEach(() => {
  // Restore environment variables
  if (envBackup.AO_REPO_ROOT === undefined) {
    delete process.env["AO_REPO_ROOT"];
  } else {
    process.env["AO_REPO_ROOT"] = envBackup.AO_REPO_ROOT;
  }
  if (envBackup.AO_BASH_PATH === undefined) {
    delete process.env["AO_BASH_PATH"];
  } else {
    process.env["AO_BASH_PATH"] = envBackup.AO_BASH_PATH;
  }
});

describe("resolveRepoRoot", () => {
  it("returns AO_REPO_ROOT when set", () => {
    process.env["AO_REPO_ROOT"] = "/custom/repo/root";
    const result = resolveRepoRoot();
    expect(result).toBe("/custom/repo/root");
  });

  it("returns default repo root when AO_REPO_ROOT is not set", () => {
    delete process.env["AO_REPO_ROOT"];
    const result = resolveRepoRoot();
    // Default is resolved from import.meta.url going up 4 levels
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("resolves relative AO_REPO_ROOT to absolute path", () => {
    process.env["AO_REPO_ROOT"] = "./relative/path";
    const result = resolveRepoRoot();
    // resolve() should make it absolute
    expect(result).toMatch(/^\//);
  });
});

describe("resolveScriptPath", () => {
  it("returns full script path when script exists", () => {
    mockExistsSync.mockReturnValue(true);
    process.env["AO_REPO_ROOT"] = "/repo";
    const result = resolveScriptPath("deploy.sh");
    expect(result).toBe("/repo/scripts/deploy.sh");
  });

  it("throws when script does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    process.env["AO_REPO_ROOT"] = "/repo";
    expect(() => resolveScriptPath("missing.sh")).toThrow("Script not found:");
  });

  it("includes script path in the error message", () => {
    mockExistsSync.mockReturnValue(false);
    process.env["AO_REPO_ROOT"] = "/repo";
    expect(() => resolveScriptPath("foo.sh")).toThrow("/repo/scripts/foo.sh");
  });
});

describe("runRepoScript", () => {
  function makeChildProcess(exitCode: number | null, signal: string | null = null) {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const child = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(cb);
        return child;
      }),
      _emit(event: string, ...args: unknown[]) {
        for (const cb of handlers[event] ?? []) cb(...args);
      },
    };
    // Schedule emit after mock setup
    setTimeout(() => child._emit("exit", exitCode, signal), 10);
    return child;
  }

  it("resolves with exit code 0 on success", async () => {
    mockExistsSync.mockReturnValue(true);
    process.env["AO_REPO_ROOT"] = "/repo";
    const child = makeChildProcess(0);
    mockSpawn.mockReturnValue(child);

    const code = await runRepoScript("test.sh", ["--flag"]);
    expect(code).toBe(0);
    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      ["/repo/scripts/test.sh", "--flag"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("resolves with exit code on failure", async () => {
    mockExistsSync.mockReturnValue(true);
    process.env["AO_REPO_ROOT"] = "/repo";
    const child = makeChildProcess(42);
    mockSpawn.mockReturnValue(child);

    const code = await runRepoScript("test.sh", []);
    expect(code).toBe(42);
  });

  it("resolves with 1 on signal termination", async () => {
    mockExistsSync.mockReturnValue(true);
    process.env["AO_REPO_ROOT"] = "/repo";
    const child = makeChildProcess(null, "SIGTERM");
    mockSpawn.mockReturnValue(child);

    const code = await runRepoScript("test.sh", []);
    expect(code).toBe(1);
  });

  it("resolves with 1 when exit code is null and no signal", async () => {
    mockExistsSync.mockReturnValue(true);
    process.env["AO_REPO_ROOT"] = "/repo";
    const child = makeChildProcess(null, null);
    mockSpawn.mockReturnValue(child);

    const code = await runRepoScript("test.sh", []);
    expect(code).toBe(1);
  });

  it("rejects on spawn error", async () => {
    mockExistsSync.mockReturnValue(true);
    process.env["AO_REPO_ROOT"] = "/repo";
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const child = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(cb);
        return child;
      }),
    };
    mockSpawn.mockReturnValue(child);

    const promise = runRepoScript("test.sh", []);
    // Emit error
    setTimeout(() => {
      for (const cb of handlers["error"] ?? []) cb(new Error("ENOENT"));
    }, 10);
    await expect(promise).rejects.toThrow("ENOENT");
  });

  it("uses AO_BASH_PATH when set", async () => {
    mockExistsSync.mockReturnValue(true);
    process.env["AO_REPO_ROOT"] = "/repo";
    process.env["AO_BASH_PATH"] = "/usr/local/bin/bash5";
    const child = makeChildProcess(0);
    mockSpawn.mockReturnValue(child);

    await runRepoScript("test.sh", []);
    expect(mockSpawn).toHaveBeenCalledWith(
      "/usr/local/bin/bash5",
      expect.any(Array),
      expect.any(Object),
    );
  });
});

describe("executeScriptCommand", () => {
  function makeChildProcess(exitCode: number) {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const child = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(cb);
        return child;
      }),
    };
    setTimeout(() => {
      for (const cb of handlers["exit"] ?? []) cb(exitCode, null);
    }, 10);
    return child;
  }

  it("does not exit on success (exit code 0)", async () => {
    mockExistsSync.mockReturnValue(true);
    process.env["AO_REPO_ROOT"] = "/repo";
    const child = makeChildProcess(0);
    mockSpawn.mockReturnValue(child);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await executeScriptCommand("test.sh", []);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("calls process.exit with non-zero exit code on failure", async () => {
    mockExistsSync.mockReturnValue(true);
    process.env["AO_REPO_ROOT"] = "/repo";
    const child = makeChildProcess(2);
    mockSpawn.mockReturnValue(child);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await executeScriptCommand("test.sh", []);
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
  });

  it("calls process.exit(1) and logs error when script throws", async () => {
    mockExistsSync.mockReturnValue(false);
    process.env["AO_REPO_ROOT"] = "/repo";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await executeScriptCommand("missing.sh", []);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalled();
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("logs non-Error thrown values as strings", async () => {
    mockExistsSync.mockReturnValue(true);
    process.env["AO_REPO_ROOT"] = "/repo";
    // Make spawn throw a non-Error
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const child = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(cb);
        return child;
      }),
    };
    mockSpawn.mockReturnValue(child);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const promise = executeScriptCommand("test.sh", []);
    setTimeout(() => {
      for (const cb of handlers["error"] ?? []) cb("string error");
    }, 10);
    await promise;

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalledWith("string error");
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
