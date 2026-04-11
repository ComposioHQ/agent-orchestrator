import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

const {
  mockCreateProjectObserver,
  mockGetLifecycleManager,
  mockGetLifecycleWorkerStatus,
  mockLoadConfig,
} = vi.hoisted(() => ({
  mockCreateProjectObserver: vi.fn(),
  mockGetLifecycleManager: vi.fn(),
  mockGetLifecycleWorkerStatus: vi.fn(),
  mockLoadConfig: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = (await importOriginal()) as typeof import("@aoagents/ao-core");
  return {
    ...actual,
    loadConfig: () => mockLoadConfig(),
    createProjectObserver: (...args: unknown[]) => mockCreateProjectObserver(...args),
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getLifecycleManager: (...args: unknown[]) => mockGetLifecycleManager(...args),
}));

vi.mock("../../src/lib/lifecycle-service.js", () => ({
  getLifecycleWorkerStatus: (...args: unknown[]) => mockGetLifecycleWorkerStatus(...args),
  clearLifecycleWorkerPid: vi.fn(),
  writeLifecycleWorkerPid: vi.fn(),
}));

import { registerLifecycleWorker } from "../../src/commands/lifecycle-worker.js";

describe("lifecycle-worker command", () => {
  let tempDir: string;
  let configPath: string;
  let mockLifecycleManager: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    recoverDeadSessions: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    // Reset mocks without clearing them completely
    mockLoadConfig.mockReset();
    mockCreateProjectObserver.mockReset();
    mockGetLifecycleManager.mockReset();
    mockGetLifecycleWorkerStatus.mockReset();
    const baseDir = tmpdir();
    tempDir = mkdtempSync(join(baseDir, "ao-lifecycle-worker-test-"));
    configPath = join(tempDir, "agent-orchestrator.yaml");

    writeFileSync(
      configPath,
      `
port: 3000
defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
projects:
  my-app:
    name: my-app
    repo: owner/repo
    path: ${join(tempDir, "my-app")}
`.trim(),
    );

    mockLifecycleManager = {
      start: vi.fn(),
      stop: vi.fn(),
      recoverDeadSessions: vi.fn().mockResolvedValue([]),
    };

    mockLoadConfig.mockReturnValue({
      configPath,
      projects: {
        "my-app": {
          path: join(tempDir, "my-app"),
        },
      },
    });

    mockCreateProjectObserver.mockReturnValue({
      setHealth: vi.fn(),
      recordOperation: vi.fn(),
    });

    mockGetLifecycleWorkerStatus.mockReturnValue({ running: false, pid: null });
    mockGetLifecycleManager.mockResolvedValue(mockLifecycleManager);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  it("starts the lifecycle worker and recovers dead sessions on boot", async () => {
    const program = new Command();
    registerLifecycleWorker(program);

    mockLifecycleManager.recoverDeadSessions.mockResolvedValue([
      { sessionId: "app-1", projectId: "my-app", archived: true, respawned: true },
      { sessionId: "app-2", projectId: "my-app", archived: true, respawned: false, respawnError: "conflict" },
    ]);

    // This will start the worker but we need to stop it manually since it runs forever
    const workerPromise = program.parseAsync(["node", "test", "lifecycle-worker", "my-app", "--interval-ms", "5000"]);

    // Wait a bit for the startup recovery to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The lifecycle worker should have started
    expect(mockLifecycleManager.start).toHaveBeenCalledWith(5000);
    expect(mockLifecycleManager.recoverDeadSessions).toHaveBeenCalled();

    // Clean up by stopping the worker
    mockLifecycleManager.start.mockImplementation(() => {
      // Don't actually start an interval in tests
      return;
    });

    // Trigger cleanup
    process.emit("SIGTERM");

    try {
      await workerPromise;
    } catch {
      // Expected - process.exit throws
    }
  });

  it("exits when another worker is already running", async () => {
    const program = new Command();
    registerLifecycleWorker(program);

    mockGetLifecycleWorkerStatus.mockReturnValue({ running: true, pid: 12345 });

    // This should exit silently
    await program.parseAsync(["node", "test", "lifecycle-worker", "my-app"]);

    // Should not start the lifecycle manager
    expect(mockGetLifecycleManager).not.toHaveBeenCalled();
    expect(mockLifecycleManager.start).not.toHaveBeenCalled();
  });

  it("exits with error when project is not found", async () => {
    const program = new Command();
    registerLifecycleWorker(program);

    mockLoadConfig.mockReturnValue({
      configPath,
      projects: {
        "other-app": { path: "/other" },
      },
    });

    await expect(
      program.parseAsync(["node", "test", "lifecycle-worker", "unknown-app"]),
    ).rejects.toThrow("process.exit called");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown project: unknown-app"),
    );
  });

  it("handles recovery errors gracefully", async () => {
    const program = new Command();
    registerLifecycleWorker(program);

    mockLifecycleManager.recoverDeadSessions.mockRejectedValue(new Error("recovery failed"));

    mockLifecycleManager.start.mockImplementation(() => {
      return;
    });

    await program.parseAsync(["node", "test", "lifecycle-worker", "my-app"]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Dead session recovery failed"),
    );

    // Should still start the polling loop
    expect(mockLifecycleManager.start).toHaveBeenCalled();
  });

  it("uses default interval when not specified", async () => {
    const program = new Command();
    registerLifecycleWorker(program);

    mockLifecycleManager.start.mockImplementation(() => {
      return;
    });

    await program.parseAsync(["node", "test", "lifecycle-worker", "my-app"]);

    expect(mockLifecycleManager.start).toHaveBeenCalledWith(30000);
  });
});
