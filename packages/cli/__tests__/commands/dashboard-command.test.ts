import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSpawn,
  mockLoadConfig,
  mockFindWebDir,
  mockBuildDashboardEnv,
  mockFindRunningDashboardPid,
  mockFindProcessWebDir,
  mockWaitForPortFree,
  mockWaitForPortsFree,
  mockTerminateListenersOnPorts,
  mockTryAcquireLifecycleLock,
  mockReleaseLifecycleLock,
  mockCreateLifecycleRunner,
  mockLifecycleRunner,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockFindWebDir: vi.fn(),
  mockBuildDashboardEnv: vi.fn(),
  mockFindRunningDashboardPid: vi.fn(),
  mockFindProcessWebDir: vi.fn(),
  mockWaitForPortFree: vi.fn(),
  mockWaitForPortsFree: vi.fn(),
  mockTerminateListenersOnPorts: vi.fn(),
  mockTryAcquireLifecycleLock: vi.fn(),
  mockReleaseLifecycleLock: vi.fn(),
  mockCreateLifecycleRunner: vi.fn(),
  mockLifecycleRunner: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    loadConfig: mockLoadConfig,
  };
});

vi.mock("../../src/lib/web-dir.js", () => ({
  findWebDir: mockFindWebDir,
  buildDashboardEnv: mockBuildDashboardEnv,
}));

vi.mock("../../src/lib/dashboard-rebuild.js", () => ({
  cleanNextCache: vi.fn(),
  findRunningDashboardPid: mockFindRunningDashboardPid,
  findProcessWebDir: mockFindProcessWebDir,
  waitForPortFree: mockWaitForPortFree,
  waitForPortsFree: mockWaitForPortsFree,
  terminateListenersOnPorts: mockTerminateListenersOnPorts,
}));

vi.mock("../../src/lib/lifecycle-runner.js", () => ({
  DEFAULT_LIFECYCLE_POLL_INTERVAL_MS: 10_000,
  createLifecycleRunner: mockCreateLifecycleRunner,
}));

vi.mock("../../src/lib/lifecycle-lock.js", () => ({
  tryAcquireLifecycleLock: mockTryAcquireLifecycleLock,
  releaseLifecycleLock: mockReleaseLifecycleLock,
}));

let tmpDir: string;
let webDir: string;
let program: Command;

function createMockChild(): EventEmitter & { stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  child.stderr = new EventEmitter();
  return child;
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-dashboard-command-test-"));
  webDir = join(tmpDir, "web");
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, "package.json"), "{}", { encoding: "utf-8", flag: "w" });

  mockLoadConfig.mockReset().mockReturnValue({
    configPath: join(tmpDir, "agent-orchestrator.yaml"),
    port: 3000,
    projects: {
      "test-project": {
        name: "Test Project",
      },
    },
  });
  mockFindWebDir.mockReset().mockReturnValue(webDir);
  mockBuildDashboardEnv.mockReset().mockResolvedValue({
    PORT: "3000",
    AO_CONFIG_PATH: join(tmpDir, "agent-orchestrator.yaml"),
    NEXT_PUBLIC_DIRECT_TERMINAL_PORT: "14801",
  });
  mockFindRunningDashboardPid.mockReset().mockResolvedValue(null);
  mockFindProcessWebDir.mockReset().mockResolvedValue(null);
  mockWaitForPortFree.mockReset().mockResolvedValue(undefined);
  mockWaitForPortsFree.mockReset().mockResolvedValue(undefined);
  mockTerminateListenersOnPorts.mockReset().mockResolvedValue([]);
  mockSpawn.mockReset().mockReturnValue(createMockChild());
  mockTryAcquireLifecycleLock.mockReset().mockReturnValue({
    acquired: false,
    lockPath: "/tmp/lifecycle.lock",
    existingPid: 4321,
  });
  mockReleaseLifecycleLock.mockReset().mockReturnValue(true);
  mockLifecycleRunner.start.mockReset().mockResolvedValue(undefined);
  mockLifecycleRunner.stop.mockReset().mockResolvedValue(undefined);
  mockCreateLifecycleRunner.mockReset().mockReturnValue(mockLifecycleRunner);

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  program = new Command();
  program.exitOverride();
  const { registerDashboard } = await import("../../src/commands/dashboard.js");
  registerDashboard(program);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("dashboard command", () => {
  it("starts full web dev stack so terminal websocket servers are available", async () => {
    await program.parseAsync(["node", "test", "dashboard", "--no-open"]);

    expect(mockSpawn).toHaveBeenCalledWith("pnpm", ["run", "dev"], {
      cwd: webDir,
      stdio: ["inherit", "inherit", "pipe"],
      env: expect.objectContaining({
        PORT: "3000",
        NEXT_PUBLIC_DIRECT_TERMINAL_PORT: "14801",
      }),
    });
  });

  it("does not start a second dashboard when port is already occupied by dashboard", async () => {
    mockFindRunningDashboardPid.mockResolvedValue("12345");
    mockFindProcessWebDir.mockResolvedValue(webDir);

    await program.parseAsync(["node", "test", "dashboard", "--no-open"]);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockBuildDashboardEnv).not.toHaveBeenCalled();
    expect(mockTryAcquireLifecycleLock).not.toHaveBeenCalled();
  });

  it("starts lifecycle poller when lock is acquired", async () => {
    mockTryAcquireLifecycleLock.mockReturnValue({
      acquired: true,
      lockPath: "/tmp/lifecycle.lock",
      lock: {
        lockPath: "/tmp/lifecycle.lock",
        pid: 1234,
        projectId: "test-project",
      },
      staleRecovered: false,
    });

    await program.parseAsync(["node", "test", "dashboard", "--no-open"]);

    expect(mockCreateLifecycleRunner).toHaveBeenCalledWith({
      config: expect.objectContaining({
        configPath: expect.any(String),
      }),
      intervalMs: 10_000,
    });
    expect(mockLifecycleRunner.start).toHaveBeenCalledTimes(1);
  });

  it("skips lifecycle startup with --no-lifecycle", async () => {
    await program.parseAsync(["node", "test", "dashboard", "--no-open", "--no-lifecycle"]);

    expect(mockTryAcquireLifecycleLock).not.toHaveBeenCalled();
    expect(mockCreateLifecycleRunner).not.toHaveBeenCalled();
  });
});
