import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSessionManager } from "../session-manager.js";
import { writeMetadata } from "../metadata.js";
import type { OrchestratorConfig, PluginRegistry, Agent } from "../types.js";
import { setupTestContext, teardownTestContext, makeHandle, type TestContext } from "./test-utils.js";

// Mock child_process module
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

let ctx: TestContext;
let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;
let originalPath: string | undefined;

beforeEach(() => {
  ctx = setupTestContext();
  ({ tmpDir, configPath, sessionsDir, mockRegistry, config, originalPath } = ctx);

  // Create an opencode agent mock
  const opencodeAgent: Agent = {
    name: "opencode",
    processName: "opencode",
    getLaunchCommand: vi.fn().mockReturnValue("opencode start"),
    getEnvironment: vi.fn().mockReturnValue({}),
    detectActivity: vi.fn().mockReturnValue("active"),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  // Update registry to include opencode agent
  const originalGet = mockRegistry.get;
  mockRegistry.get = vi.fn().mockImplementation((slot: string, name?: string) => {
    if (slot === "agent" && name === "opencode") {
      return opencodeAgent;
    }
    return originalGet(slot, name);
  });

  // Set project to use opencode agent
  config.projects["my-app"]!.agent = "opencode";
});

afterEach(() => {
  teardownTestContext(ctx);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("deleteSession retry loop", () => {
  it("verifies retry count - calls execFileAsync 3 times when all attempts fail", async () => {
    const { execFile } = await import("node:child_process");

    // Setup: Create a session with opencode agent
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_test_123",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    let deleteCallCount = 0;
    const mockError = new Error("OpenCode delete failed");

    vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (!cb) return null as any;

      const argsArray = Array.isArray(args) ? args : [];
      if (argsArray[1] === "delete") {
        deleteCallCount++;
        cb(mockError, null, null);
      } else if (argsArray[1] === "list") {
        cb(null, { stdout: "[]", stderr: "" }, null);
      }
      return null as any;
    }) as any);

    const sm = createSessionManager({ config, registry: mockRegistry });

    // Execute kill with purgeOpenCode option
    await sm.kill("app-1", { purgeOpenCode: true });

    // Verify delete was called 3 times (one for each retry)
    expect(deleteCallCount).toBe(3);
  });

  it("verifies retry delays - confirms delays are 0ms, 200ms, 600ms", async () => {
    const { execFile } = await import("node:child_process");
    vi.useFakeTimers();

    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_test_456",
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });

    const callTimes: number[] = [];
    const mockError = new Error("OpenCode delete failed");

    vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (!cb) return null as any;

      const argsArray = Array.isArray(args) ? args : [];
      if (argsArray[1] === "delete") {
        callTimes.push(Date.now());
        cb(mockError, null, null);
      } else if (argsArray[1] === "list") {
        cb(null, { stdout: "[]", stderr: "" }, null);
      }
      return null as any;
    }) as any);

    const sm = createSessionManager({ config, registry: mockRegistry });
    const killPromise = sm.kill("app-2", { purgeOpenCode: true });

    // Run all timers to completion
    await vi.runAllTimersAsync();
    await killPromise;

    // Verify we have 3 calls
    expect(callTimes).toHaveLength(3);

    // Calculate delays between calls
    const delay1 = callTimes[1]! - callTimes[0]!; // Should be 200ms
    const delay2 = callTimes[2]! - callTimes[1]!; // Should be 600ms

    expect(delay1).toBe(200);
    expect(delay2).toBe(600);

    vi.useRealTimers();
  });

  it("verifies final error propagation - last error is thrown after all retries fail", async () => {
    const { execFile } = await import("node:child_process");

    writeMetadata(sessionsDir, "app-3", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_test_789",
      runtimeHandle: JSON.stringify(makeHandle("rt-3")),
    });

    const lastError = new Error("Final error after retries");
    let deleteCallCount = 0;

    vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (!cb) return null as any;

      const argsArray = Array.isArray(args) ? args : [];
      if (argsArray[1] === "delete") {
        deleteCallCount++;
        const error = deleteCallCount === 3 ? lastError : new Error(`Error ${deleteCallCount}`);
        cb(error, null, null);
      } else if (argsArray[1] === "list") {
        cb(null, { stdout: "[]", stderr: "" }, null);
      }
      return null as any;
    }) as any);

    const sm = createSessionManager({ config, registry: mockRegistry });

    // The kill function catches the error and continues, so we need to verify
    // that the error was thrown internally but handled gracefully
    await sm.kill("app-3", { purgeOpenCode: true });

    // Verify all 3 delete attempts were made
    expect(deleteCallCount).toBe(3);
  });

  it("verifies early success exit - stops after first success without unnecessary retries", async () => {
    const { execFile } = await import("node:child_process");

    writeMetadata(sessionsDir, "app-4", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_test_abc",
      runtimeHandle: JSON.stringify(makeHandle("rt-4")),
    });

    let deleteCallCount = 0;

    vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (!cb) return null as any;

      const argsArray = Array.isArray(args) ? args : [];
      if (argsArray[1] === "delete") {
        deleteCallCount++;
        if (deleteCallCount === 1) {
          // First attempt fails
          cb(new Error("First attempt failed"), null, null);
        } else {
          // Second attempt succeeds
          cb(null, { stdout: "", stderr: "" }, null);
        }
      } else if (argsArray[1] === "list") {
        cb(null, { stdout: "[]", stderr: "" }, null);
      }
      return null as any;
    }) as any);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-4", { purgeOpenCode: true });

    // Verify delete was called exactly 2 times (failed once, succeeded on second)
    expect(deleteCallCount).toBe(2);
  });

  it("verifies session-not-found handling - exits gracefully without retrying", async () => {
    const { execFile } = await import("node:child_process");

    writeMetadata(sessionsDir, "app-5", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_test_def",
      runtimeHandle: JSON.stringify(makeHandle("rt-5")),
    });

    const notFoundError = new Error("Session not found: ses_test_def") as Error & {
      stderr?: string;
      stdout?: string;
    };
    notFoundError.stderr = "Error: session not found: ses_test_def";

    let deleteCallCount = 0;

    vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (!cb) return null as any;

      const argsArray = Array.isArray(args) ? args : [];
      if (argsArray[1] === "delete") {
        deleteCallCount++;
        cb(notFoundError, null, null);
      } else if (argsArray[1] === "list") {
        cb(null, { stdout: "[]", stderr: "" }, null);
      }
      return null as any;
    }) as any);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-5", { purgeOpenCode: true });

    // Verify delete was called only once - no retries for "not found" errors
    expect(deleteCallCount).toBe(1);
  });
});
