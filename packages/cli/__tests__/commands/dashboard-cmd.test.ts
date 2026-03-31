/**
 * Tests for the `ao dashboard` command registration.
 *
 * Separated from dashboard.test.ts which tests the dashboard-rebuild utility
 * functions directly (without mocking the modules they import).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockLoadConfig,
  mockFindWebDir,
  mockBuildDashboardEnv,
  mockWaitForPortAndOpen,
  mockSpawn,
  mockCleanNextCache,
  mockFindRunningDashboardPid,
  mockFindProcessWebDir,
  mockWaitForPortFree,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockFindWebDir: vi.fn(),
  mockBuildDashboardEnv: vi.fn(),
  mockWaitForPortAndOpen: vi.fn(),
  mockSpawn: vi.fn(),
  mockCleanNextCache: vi.fn(),
  mockFindRunningDashboardPid: vi.fn(),
  mockFindProcessWebDir: vi.fn(),
  mockWaitForPortFree: vi.fn(),
}));

vi.mock("@composio/ao-core", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock("../../src/lib/web-dir.js", () => ({
  findWebDir: (...args: unknown[]) => mockFindWebDir(...args),
  buildDashboardEnv: (...args: unknown[]) => mockBuildDashboardEnv(...args),
  waitForPortAndOpen: (...args: unknown[]) => mockWaitForPortAndOpen(...args),
}));

vi.mock("../../src/lib/dashboard-rebuild.js", () => ({
  cleanNextCache: (...args: unknown[]) => mockCleanNextCache(...args),
  findRunningDashboardPid: (...args: unknown[]) => mockFindRunningDashboardPid(...args),
  findProcessWebDir: (...args: unknown[]) => mockFindProcessWebDir(...args),
  waitForPortFree: (...args: unknown[]) => mockWaitForPortFree(...args),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

import { registerDashboard } from "../../src/commands/dashboard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChildProcess() {
  const child = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(child, { stderr, stdin: null, stdout: null, pid: 1234 });
  return child;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dashboard command", () => {
  let program: Command;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerDashboard(program);

    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Don't throw on process.exit — just capture the call
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 3000,
      terminalPort: 14800,
      directTerminalPort: 14801,
    });
    mockFindWebDir.mockReturnValue("/fake/web");
    mockBuildDashboardEnv.mockResolvedValue({ NODE_ENV: "development" });
    mockWaitForPortAndOpen.mockResolvedValue(undefined);
    mockCleanNextCache.mockResolvedValue(undefined);
    mockFindRunningDashboardPid.mockResolvedValue(null);
    mockFindProcessWebDir.mockResolvedValue(null);
    mockWaitForPortFree.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts dashboard on default port and opens browser", async () => {
    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "npx",
      ["next", "dev", "-p", "3000"],
      expect.objectContaining({
        cwd: "/fake/web",
      }),
    );
    expect(mockWaitForPortAndOpen).toHaveBeenCalledWith(
      3000,
      "http://localhost:3000",
      expect.any(AbortSignal),
    );

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Starting dashboard");
    expect(output).toContain("3000");
  });

  it("uses custom port from --port flag", async () => {
    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard", "--port", "4000"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "npx",
      ["next", "dev", "-p", "4000"],
      expect.objectContaining({ cwd: "/fake/web" }),
    );
  });

  it("uses port from config when no --port flag", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 5555,
      terminalPort: 14800,
      directTerminalPort: 14801,
    });

    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "npx",
      ["next", "dev", "-p", "5555"],
      expect.objectContaining({ cwd: "/fake/web" }),
    );
  });

  it("skips browser open with --no-open", async () => {
    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard", "--no-open"]);

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
  });

  it("exits with error for invalid port (> 65535)", async () => {
    // Make exit throw for this specific test
    exitSpy.mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      program.parseAsync(["node", "test", "dashboard", "--port", "99999"]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("exits with error for NaN port", async () => {
    exitSpy.mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      program.parseAsync(["node", "test", "dashboard", "--port", "abc"]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error for port 0", async () => {
    exitSpy.mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      program.parseAsync(["node", "test", "dashboard", "--port", "0"]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("handles --rebuild by cleaning cache and restarting", async () => {
    mockFindRunningDashboardPid.mockResolvedValue(null);

    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard", "--rebuild"]);

    expect(mockCleanNextCache).toHaveBeenCalledWith("/fake/web");
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("kills existing dashboard process on --rebuild", async () => {
    mockFindRunningDashboardPid.mockResolvedValue("12345");
    mockFindProcessWebDir.mockResolvedValue("/fake/web");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard", "--rebuild"]);

    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(mockWaitForPortFree).toHaveBeenCalledWith(3000, 5000);
    expect(mockCleanNextCache).toHaveBeenCalled();
  });

  it("handles already-exited process on --rebuild gracefully", async () => {
    mockFindRunningDashboardPid.mockResolvedValue("99999");
    mockFindProcessWebDir.mockResolvedValue(null);

    // process.kill throws ESRCH when process already exited
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });

    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    // Should not throw — ESRCH is caught
    await program.parseAsync(["node", "test", "dashboard", "--rebuild"]);
    expect(mockCleanNextCache).toHaveBeenCalled();
  });

  it("handles spawn error event", async () => {
    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard"]);

    // Emit error on the child process
    child.emit("error", new Error("ENOENT"));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("collects stderr output and writes to process.stderr", async () => {
    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);
    const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await program.parseAsync(["node", "test", "dashboard"]);

    // Emit stderr data
    (child as unknown as { stderr: EventEmitter }).stderr.emit(
      "data",
      Buffer.from("some warning"),
    );

    expect(stderrWriteSpy).toHaveBeenCalled();
  });

  it("passes buildDashboardEnv result to spawn", async () => {
    mockBuildDashboardEnv.mockResolvedValue({
      NODE_ENV: "development",
      CUSTOM_VAR: "test",
    });

    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "npx",
      expect.any(Array),
      expect.objectContaining({
        env: { NODE_ENV: "development", CUSTOM_VAR: "test" },
      }),
    );
  });

  it("defaults to port 3000 when config has no port", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/agent-orchestrator.yaml",
    });

    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "npx",
      ["next", "dev", "-p", "3000"],
      expect.anything(),
    );
  });

  it("uses running process webDir for cache clean on --rebuild", async () => {
    mockFindRunningDashboardPid.mockResolvedValue("12345");
    mockFindProcessWebDir.mockResolvedValue("/running/web");

    vi.spyOn(process, "kill").mockImplementation(() => true);

    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard", "--rebuild"]);

    // Should clean the running process's web dir, not localWebDir
    expect(mockCleanNextCache).toHaveBeenCalledWith("/running/web");
  });

  it("calls buildDashboardEnv with correct arguments", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/my/config.yaml",
      port: 4000,
      terminalPort: 15000,
      directTerminalPort: 15001,
    });

    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard"]);

    expect(mockBuildDashboardEnv).toHaveBeenCalledWith(4000, "/my/config.yaml", 15000, 15001);
  });

  it("calls process.exit with child exit code", async () => {
    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard"]);

    child.emit("exit", 42);

    expect(exitSpy).toHaveBeenCalledWith(42);
  });

  it("calls process.exit(0) when child exits with null code", async () => {
    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard"]);

    child.emit("exit", null);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("spawns with stdio configuration", async () => {
    const child = makeChildProcess();
    mockSpawn.mockReturnValue(child);

    await program.parseAsync(["node", "test", "dashboard"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "npx",
      expect.any(Array),
      expect.objectContaining({
        stdio: ["inherit", "inherit", "pipe"],
      }),
    );
  });
});
