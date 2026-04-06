import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSessionManager } from "../session-manager.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import type { OrchestratorConfig, PluginRegistry, Agent } from "../types.js";
import { setupTestContext, teardownTestContext, makeHandle, type TestContext } from "./test-utils.js";

// Mock child_process module with custom promisify
vi.mock("node:child_process", () => {
  const execFileMock = vi.fn() as any;
  // Implement custom promisify to return { stdout, stderr } objects
  execFileMock[Symbol.for("nodejs.util.promisify.custom")] = (...args: any[]) => {
    return new Promise((resolve, reject) => {
      execFileMock(...args, (error: any, stdout: string, stderr: string) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  };
  return {
    execFile: execFileMock,
  };
});

let ctx: TestContext;
let sessionsDir: string;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

beforeEach(() => {
  ctx = setupTestContext();
  ({ sessionsDir, mockRegistry, config } = ctx);

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
    return (originalGet as any)(slot, name);
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
        cb(mockError, "", "");
      } else if (argsArray[1] === "list") {
        cb(null, "[]", "");
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
        cb(mockError, "", "");
      } else if (argsArray[1] === "list") {
        cb(null, "[]", "");
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

  it("verifies all retries are attempted when deletion fails", async () => {
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
        cb(error, "", "");
      } else if (argsArray[1] === "list") {
        cb(null, "[]", "");
      }
      return null as any;
    }) as any);

    const sm = createSessionManager({ config, registry: mockRegistry });

    // The kill function catches and ignores deleteOpenCodeSession() failures,
    // so this test verifies that all retry attempts are made despite errors
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
          cb(new Error("First attempt failed"), "", "");
        } else {
          // Second attempt succeeds
          cb(null, "", "");
        }
      } else if (argsArray[1] === "list") {
        cb(null, "[]", "");
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
        cb(notFoundError, "", "");
      } else if (argsArray[1] === "list") {
        cb(null, "[]", "");
      }
      return null as any;
    }) as any);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-5", { purgeOpenCode: true });

    // Verify delete was called only once - no retries for "not found" errors
    expect(deleteCallCount).toBe(1);
  });
});

describe("prOwnership duplicate PR repair", () => {
  it("duplicate PR dedup sets prOwnership='stale' on non-owner session", async () => {
    const prUrl = "https://github.com/org/my-app/pull/99";

    // Session app-1 has pr_open status — should be the owner
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws1",
      branch: "feat/a",
      status: "pr_open",
      project: "my-app",
      agent: "opencode",
      pr: prUrl,
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    // Session app-2 has working status and same PR — should become stale
    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws2",
      branch: "feat/b",
      status: "working",
      project: "my-app",
      agent: "opencode",
      pr: prUrl,
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list("my-app");

    // The stale session (app-2) should have prOwnership='stale' in metadata
    const staleSession = sessions.find((s) => s.id === "app-2");
    expect(staleSession).toBeDefined();
    expect(staleSession!.metadata["prOwnership"]).toBe("stale");

    // Also verify on disk
    const rawOnDisk = readMetadataRaw(sessionsDir, "app-2");
    expect(rawOnDisk).not.toBeNull();
    expect(rawOnDisk!["prOwnership"]).toBe("stale");

    // The owner session (app-1) should NOT have prOwnership set
    const ownerSession = sessions.find((s) => s.id === "app-1");
    expect(ownerSession).toBeDefined();
    expect(ownerSession!.metadata["prOwnership"]).toBeUndefined();
  });

  it("stale session preserves pr URL in metadata after dedup", async () => {
    const prUrl = "https://github.com/org/my-app/pull/100";

    // Session app-1 has pr_open status — owner
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws1",
      branch: "feat/a",
      status: "pr_open",
      project: "my-app",
      agent: "opencode",
      pr: prUrl,
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    // Session app-2 has working status and same PR — will become stale
    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws2",
      branch: "feat/b",
      status: "working",
      project: "my-app",
      agent: "opencode",
      pr: prUrl,
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.list("my-app");

    // The stale session's PR URL must be preserved (not erased)
    const rawOnDisk = readMetadataRaw(sessionsDir, "app-2");
    expect(rawOnDisk).not.toBeNull();
    expect(rawOnDisk!["pr"]).toBe(prUrl);
  });

  it("sole session with prOwnership='stale' gets promoted", async () => {
    const prUrl = "https://github.com/org/my-app/pull/101";

    // A single session that has a PR URL but was previously marked stale
    // (the original owner was killed/cleaned up)
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws1",
      branch: "feat/a",
      status: "working",
      project: "my-app",
      agent: "opencode",
      pr: prUrl,
      prOwnership: "stale",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list("my-app");

    // The sole session should have prOwnership cleared (promoted)
    const session = sessions.find((s) => s.id === "app-1");
    expect(session).toBeDefined();
    expect(session!.metadata["prOwnership"]).toBeUndefined();

    // Verify on disk: prOwnership key should be removed
    const rawOnDisk = readMetadataRaw(sessionsDir, "app-1");
    expect(rawOnDisk).not.toBeNull();
    expect(rawOnDisk!["prOwnership"]).toBeUndefined();
  });

  it("status reset to working for stale sessions in tracking statuses", async () => {
    const prUrl = "https://github.com/org/my-app/pull/102";

    // Session app-1 has pr_open and more recent timestamp — should be owner
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws1",
      branch: "feat/a",
      status: "pr_open",
      project: "my-app",
      agent: "opencode",
      pr: prUrl,
      createdAt: new Date().toISOString(),
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    // Session app-2 also has pr_open and same PR — the stale one should be
    // reset to "working" since pr_open is a PR tracking status
    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws2",
      branch: "feat/b",
      status: "pr_open",
      project: "my-app",
      agent: "opencode",
      pr: prUrl,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list("my-app");

    // Find the stale session (the one with prOwnership='stale')
    const staleSession = sessions.find((s) => s.metadata["prOwnership"] === "stale");
    expect(staleSession).toBeDefined();

    // The stale session's status should have been reset to "working"
    expect(staleSession!.status).toBe("working");

    // Verify on disk
    const rawOnDisk = readMetadataRaw(sessionsDir, staleSession!.id);
    expect(rawOnDisk).not.toBeNull();
    expect(rawOnDisk!["status"]).toBe("working");
    expect(rawOnDisk!["prOwnership"]).toBe("stale");
  });
});
