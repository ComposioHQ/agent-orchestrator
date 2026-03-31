/**
 * Tests for the CLI entry point (src/index.ts).
 *
 * Validates that all commands are registered on the Commander program
 * and that config-help outputs the config schema.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — capture every registration call
// ---------------------------------------------------------------------------

const {
  mockRegisterInit,
  mockRegisterStart,
  mockRegisterStop,
  mockRegisterStatus,
  mockRegisterSpawn,
  mockRegisterBatchSpawn,
  mockRegisterSession,
  mockRegisterSend,
  mockRegisterReviewCheck,
  mockRegisterDashboard,
  mockRegisterOpen,
  mockRegisterLifecycleWorker,
  mockRegisterVerify,
  mockRegisterDoctor,
  mockRegisterUpdate,
  mockRegisterSetup,
  mockGetConfigInstruction,
  mockProgramParse,
} = vi.hoisted(() => ({
  mockRegisterInit: vi.fn(),
  mockRegisterStart: vi.fn(),
  mockRegisterStop: vi.fn(),
  mockRegisterStatus: vi.fn(),
  mockRegisterSpawn: vi.fn(),
  mockRegisterBatchSpawn: vi.fn(),
  mockRegisterSession: vi.fn(),
  mockRegisterSend: vi.fn(),
  mockRegisterReviewCheck: vi.fn(),
  mockRegisterDashboard: vi.fn(),
  mockRegisterOpen: vi.fn(),
  mockRegisterLifecycleWorker: vi.fn(),
  mockRegisterVerify: vi.fn(),
  mockRegisterDoctor: vi.fn(),
  mockRegisterUpdate: vi.fn(),
  mockRegisterSetup: vi.fn(),
  mockGetConfigInstruction: vi.fn().mockReturnValue("# Config help text"),
  mockProgramParse: vi.fn(),
}));

vi.mock("commander", () => {
  const commandActions: Record<string, (...args: unknown[]) => void> = {};
  const fakeCommand = {
    name: vi.fn().mockReturnThis(),
    description: vi.fn().mockReturnThis(),
    version: vi.fn().mockReturnThis(),
    command: vi.fn().mockImplementation((name: string) => {
      const sub = {
        description: vi.fn().mockReturnThis(),
        action: vi.fn().mockImplementation((fn: (...args: unknown[]) => void) => {
          commandActions[name] = fn;
          return sub;
        }),
      };
      return sub;
    }),
    parse: mockProgramParse,
    __commandActions: commandActions,
  };
  return {
    Command: vi.fn().mockImplementation(() => fakeCommand),
  };
});

vi.mock("../src/commands/init.js", () => ({
  registerInit: mockRegisterInit,
}));

vi.mock("../src/commands/start.js", () => ({
  registerStart: mockRegisterStart,
  registerStop: mockRegisterStop,
}));

vi.mock("../src/commands/status.js", () => ({
  registerStatus: mockRegisterStatus,
}));

vi.mock("../src/commands/spawn.js", () => ({
  registerSpawn: mockRegisterSpawn,
  registerBatchSpawn: mockRegisterBatchSpawn,
}));

vi.mock("../src/commands/session.js", () => ({
  registerSession: mockRegisterSession,
}));

vi.mock("../src/commands/send.js", () => ({
  registerSend: mockRegisterSend,
}));

vi.mock("../src/commands/review-check.js", () => ({
  registerReviewCheck: mockRegisterReviewCheck,
}));

vi.mock("../src/commands/dashboard.js", () => ({
  registerDashboard: mockRegisterDashboard,
}));

vi.mock("../src/commands/open.js", () => ({
  registerOpen: mockRegisterOpen,
}));

vi.mock("../src/commands/lifecycle-worker.js", () => ({
  registerLifecycleWorker: mockRegisterLifecycleWorker,
}));

vi.mock("../src/commands/verify.js", () => ({
  registerVerify: mockRegisterVerify,
}));

vi.mock("../src/commands/doctor.js", () => ({
  registerDoctor: mockRegisterDoctor,
}));

vi.mock("../src/commands/update.js", () => ({
  registerUpdate: mockRegisterUpdate,
}));

vi.mock("../src/commands/setup.js", () => ({
  registerSetup: mockRegisterSetup,
}));

vi.mock("../src/lib/config-instruction.js", () => ({
  getConfigInstruction: mockGetConfigInstruction,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI entry point", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers all command modules", async () => {
    await import("../src/index.js");

    expect(mockRegisterInit).toHaveBeenCalledTimes(1);
    expect(mockRegisterStart).toHaveBeenCalledTimes(1);
    expect(mockRegisterStop).toHaveBeenCalledTimes(1);
    expect(mockRegisterStatus).toHaveBeenCalledTimes(1);
    expect(mockRegisterSpawn).toHaveBeenCalledTimes(1);
    expect(mockRegisterBatchSpawn).toHaveBeenCalledTimes(1);
    expect(mockRegisterSession).toHaveBeenCalledTimes(1);
    expect(mockRegisterSend).toHaveBeenCalledTimes(1);
    expect(mockRegisterReviewCheck).toHaveBeenCalledTimes(1);
    expect(mockRegisterDashboard).toHaveBeenCalledTimes(1);
    expect(mockRegisterOpen).toHaveBeenCalledTimes(1);
    expect(mockRegisterLifecycleWorker).toHaveBeenCalledTimes(1);
    expect(mockRegisterVerify).toHaveBeenCalledTimes(1);
    expect(mockRegisterDoctor).toHaveBeenCalledTimes(1);
    expect(mockRegisterUpdate).toHaveBeenCalledTimes(1);
    expect(mockRegisterSetup).toHaveBeenCalledTimes(1);
  });

  it("calls program.parse()", async () => {
    const callsBefore = mockProgramParse.mock.calls.length;
    await import("../src/index.js");

    expect(mockProgramParse.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("registers a config-help command", async () => {
    const { Command } = await import("commander");
    const instance = new Command();

    await import("../src/index.js");

    expect(instance.command).toHaveBeenCalledWith("config-help");
  });
});

describe("config-help action", () => {
  it("calls getConfigInstruction and logs the result", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await import("../src/index.js");

    // Get the action that was registered for config-help
    const { Command } = await import("commander");
    const instance = new Command();
    const actions = (instance as unknown as { __commandActions: Record<string, () => void> })
      .__commandActions;

    if (actions["config-help"]) {
      actions["config-help"]();
      expect(mockGetConfigInstruction).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("# Config help text");
    }

    logSpy.mockRestore();
  });
});
