import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockLoadConfig,
  mockCreateProjectObserver,
  mockCreateCorrelationId,
  mockGetLifecycleManager,
  mockClearLifecycleWorkerPid,
  mockGetLifecycleWorkerStatus,
  mockWriteLifecycleWorkerPid,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockCreateProjectObserver: vi.fn(),
  mockCreateCorrelationId: vi.fn(),
  mockGetLifecycleManager: vi.fn(),
  mockClearLifecycleWorkerPid: vi.fn(),
  mockGetLifecycleWorkerStatus: vi.fn(),
  mockWriteLifecycleWorkerPid: vi.fn(),
}));

vi.mock("@composio/ao-core", () => ({
  loadConfig: mockLoadConfig,
  createProjectObserver: mockCreateProjectObserver,
  createCorrelationId: mockCreateCorrelationId,
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getLifecycleManager: mockGetLifecycleManager,
}));

vi.mock("../../src/lib/lifecycle-service.js", () => ({
  clearLifecycleWorkerPid: mockClearLifecycleWorkerPid,
  getLifecycleWorkerStatus: mockGetLifecycleWorkerStatus,
  writeLifecycleWorkerPid: mockWriteLifecycleWorkerPid,
}));

vi.mock("chalk", () => ({
  default: { red: (s: string) => s },
}));

import { registerLifecycleWorker } from "../../src/commands/lifecycle-worker.js";

function createMockProgram() {
  let registeredAction: ((projectId: string, opts: Record<string, string>) => Promise<void>) | null = null;
  const commandObj = {
    description: vi.fn().mockReturnThis(),
    argument: vi.fn().mockReturnThis(),
    option: vi.fn().mockReturnThis(),
    action: vi.fn((fn: (projectId: string, opts: Record<string, string>) => Promise<void>) => {
      registeredAction = fn;
      return commandObj;
    }),
  };
  const program = {
    command: vi.fn(() => commandObj),
    getAction: () => registeredAction,
  };
  return program;
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockCreateCorrelationId.mockReturnValue("test-correlation-id");
});

describe("registerLifecycleWorker", () => {
  it("registers a 'lifecycle-worker' command", () => {
    const program = createMockProgram();
    registerLifecycleWorker(program as any);
    expect(program.command).toHaveBeenCalledWith("lifecycle-worker");
  });

  it("exits with 1 for unknown project", async () => {
    const mockObserver = {
      setHealth: vi.fn(),
      recordOperation: vi.fn(),
    };
    mockCreateProjectObserver.mockReturnValue(mockObserver);
    mockLoadConfig.mockReturnValue({
      projects: {},
    });
    // Even though process.exit is called, execution continues in the mock,
    // so getLifecycleWorkerStatus will also be called. Provide a safe return.
    mockGetLifecycleWorkerStatus.mockReturnValue({
      running: false,
      pid: null,
      pidFile: "/f.pid",
      logFile: "/f.log",
    });
    mockGetLifecycleManager.mockResolvedValue({ start: vi.fn(), stop: vi.fn() });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createMockProgram();
    registerLifecycleWorker(program as any);
    const action = program.getAction()!;
    await action("unknown-proj", {});

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown project"));
    expect(mockObserver.setHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        surface: "lifecycle.worker",
      }),
    );

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("returns silently when another worker is already running", async () => {
    const mockObserver = {
      setHealth: vi.fn(),
      recordOperation: vi.fn(),
    };
    mockCreateProjectObserver.mockReturnValue(mockObserver);
    mockLoadConfig.mockReturnValue({
      projects: { proj1: { path: "/proj" } },
    });
    mockGetLifecycleWorkerStatus.mockReturnValue({
      running: true,
      pid: 9999, // Not process.pid
      pidFile: "/some/file.pid",
      logFile: "/some/file.log",
    });

    const program = createMockProgram();
    registerLifecycleWorker(program as any);
    const action = program.getAction()!;
    await action("proj1", {});

    // Should have warned and returned
    expect(mockObserver.setHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "warn",
        reason: expect.stringContaining("already running"),
      }),
    );
    expect(mockGetLifecycleManager).not.toHaveBeenCalled();
  });

  it("starts lifecycle manager with correct interval", async () => {
    const mockObserver = {
      setHealth: vi.fn(),
      recordOperation: vi.fn(),
    };
    const mockLifecycle = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    mockCreateProjectObserver.mockReturnValue(mockObserver);
    mockLoadConfig.mockReturnValue({
      projects: { proj1: { path: "/proj" } },
    });
    mockGetLifecycleWorkerStatus.mockReturnValue({
      running: false,
      pid: null,
      pidFile: "/some/file.pid",
      logFile: "/some/file.log",
    });
    mockGetLifecycleManager.mockResolvedValue(mockLifecycle);

    const program = createMockProgram();
    registerLifecycleWorker(program as any);
    const action = program.getAction()!;
    await action("proj1", { intervalMs: "10000" });

    expect(mockGetLifecycleManager).toHaveBeenCalled();
    expect(mockWriteLifecycleWorkerPid).toHaveBeenCalledWith(
      expect.any(Object),
      "proj1",
      process.pid,
    );
    expect(mockLifecycle.start).toHaveBeenCalledWith(10000);
  });

  it("parses interval with default fallback for invalid values", async () => {
    const mockObserver = {
      setHealth: vi.fn(),
      recordOperation: vi.fn(),
    };
    const mockLifecycle = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    mockCreateProjectObserver.mockReturnValue(mockObserver);
    mockLoadConfig.mockReturnValue({
      projects: { proj1: { path: "/proj" } },
    });
    mockGetLifecycleWorkerStatus.mockReturnValue({
      running: false,
      pid: null,
      pidFile: "/f.pid",
      logFile: "/f.log",
    });
    mockGetLifecycleManager.mockResolvedValue(mockLifecycle);

    const program = createMockProgram();
    registerLifecycleWorker(program as any);
    const action = program.getAction()!;
    await action("proj1", { intervalMs: "not-a-number" });

    // Should fall back to 30_000
    expect(mockLifecycle.start).toHaveBeenCalledWith(30000);
  });

  it("uses default 30000ms interval when no option provided", async () => {
    const mockObserver = {
      setHealth: vi.fn(),
      recordOperation: vi.fn(),
    };
    const mockLifecycle = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    mockCreateProjectObserver.mockReturnValue(mockObserver);
    mockLoadConfig.mockReturnValue({
      projects: { proj1: { path: "/proj" } },
    });
    mockGetLifecycleWorkerStatus.mockReturnValue({
      running: false,
      pid: null,
      pidFile: "/f.pid",
      logFile: "/f.log",
    });
    mockGetLifecycleManager.mockResolvedValue(mockLifecycle);

    const program = createMockProgram();
    registerLifecycleWorker(program as any);
    const action = program.getAction()!;
    await action("proj1", {});

    expect(mockLifecycle.start).toHaveBeenCalledWith(30000);
  });

  it("registers signal handlers on start", async () => {
    const mockObserver = {
      setHealth: vi.fn(),
      recordOperation: vi.fn(),
    };
    const mockLifecycle = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    mockCreateProjectObserver.mockReturnValue(mockObserver);
    mockLoadConfig.mockReturnValue({
      projects: { proj1: { path: "/proj" } },
    });
    mockGetLifecycleWorkerStatus.mockReturnValue({
      running: false,
      pid: null,
      pidFile: "/f.pid",
      logFile: "/f.log",
    });
    mockGetLifecycleManager.mockResolvedValue(mockLifecycle);

    const onSpy = vi.spyOn(process, "on");

    const program = createMockProgram();
    registerLifecycleWorker(program as any);
    const action = program.getAction()!;
    await action("proj1", {});

    const registeredEvents = onSpy.mock.calls.map((c) => c[0]);
    expect(registeredEvents).toContain("SIGINT");
    expect(registeredEvents).toContain("SIGTERM");
    expect(registeredEvents).toContain("uncaughtException");
    expect(registeredEvents).toContain("unhandledRejection");

    onSpy.mockRestore();
  });
});
