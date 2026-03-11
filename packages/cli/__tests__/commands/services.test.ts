import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockConfigRef,
  mockInstallManagedServices,
  mockStartManagedServices,
  mockStopManagedServices,
  mockGetManagedServicesStatus,
  mockRunSupervisorLoop,
} = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockInstallManagedServices: vi.fn(),
  mockStartManagedServices: vi.fn(),
  mockStopManagedServices: vi.fn(),
  mockGetManagedServicesStatus: vi.fn(),
  mockRunSupervisorLoop: vi.fn(),
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
  };
});

vi.mock("../../src/lib/services.js", () => ({
  installManagedServices: (...args: unknown[]) => mockInstallManagedServices(...args),
  startManagedServices: (...args: unknown[]) => mockStartManagedServices(...args),
  stopManagedServices: (...args: unknown[]) => mockStopManagedServices(...args),
  getManagedServicesStatus: (...args: unknown[]) => mockGetManagedServicesStatus(...args),
  runSupervisorLoop: (...args: unknown[]) => mockRunSupervisorLoop(...args),
}));

import { Command } from "commander";
import { registerServices } from "../../src/commands/services.js";

let program: Command;

beforeEach(() => {
  mockConfigRef.current = {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {},
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as Record<string, unknown>;

  mockInstallManagedServices.mockReset();
  mockStartManagedServices.mockReset();
  mockStopManagedServices.mockReset();
  mockGetManagedServicesStatus.mockReset();
  mockRunSupervisorLoop.mockReset();

  const readyStatus = {
    manager: "systemd",
    managerRunning: true,
    managerDetail: "mock",
    processStates: {
      dashboard: "active",
      "terminal-ws": "active",
      "direct-terminal-ws": "active",
    },
    services: [
      { id: "dashboard", port: 3000, listening: true, healthy: true, httpStatus: 200, details: "ready" },
      { id: "terminal-ws", port: 14800, listening: true, healthy: true, httpStatus: 200, details: "ready" },
      {
        id: "direct-terminal-ws",
        port: 14801,
        listening: true,
        healthy: true,
        httpStatus: 200,
        details: "ready",
      },
    ],
    allReady: true,
  };

  mockInstallManagedServices.mockResolvedValue({
    manager: "systemd",
    detail: "installed",
  });
  mockStartManagedServices.mockResolvedValue({
    manager: "systemd",
    started: true,
    ready: true,
    status: readyStatus,
  });
  mockStopManagedServices.mockResolvedValue({
    manager: "systemd",
    stopped: true,
    status: readyStatus,
  });
  mockGetManagedServicesStatus.mockResolvedValue(readyStatus);
  mockRunSupervisorLoop.mockResolvedValue(undefined);

  program = new Command();
  program.exitOverride();
  registerServices(program);

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});

describe("services command", () => {
  it("prints status as JSON", async () => {
    const logSpy = vi.spyOn(console, "log");
    await program.parseAsync(["node", "test", "services", "status", "--json"]);
    expect(mockGetManagedServicesStatus).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("\"manager\": \"systemd\""));
  });

  it("returns non-zero in strict mode when not ready", async () => {
    mockGetManagedServicesStatus.mockResolvedValue({
      manager: "systemd",
      managerRunning: false,
      managerDetail: "mock",
      processStates: {
        dashboard: "failed",
        "terminal-ws": "inactive",
        "direct-terminal-ws": "inactive",
      },
      services: [
        {
          id: "dashboard",
          port: 3000,
          listening: false,
          healthy: false,
          httpStatus: null,
          details: "no listener",
        },
      ],
      allReady: false,
    });

    await expect(
      program.parseAsync(["node", "test", "services", "status", "--strict"]),
    ).rejects.toThrow("process.exit(1)");
  });
});
