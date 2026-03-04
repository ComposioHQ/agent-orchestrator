/**
 * Pipeline Integration Tests
 *
 * Tests the full pipeline flow end-to-end with realistic mocks:
 * - checks -> test -> review -> approved
 * - retry loops on failure
 * - maxIterations enforcement
 * - role-based skipping
 * - config-based disabling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createPipelineManager } from "../pipeline-manager.js";
import type {
  Session,
  SessionManager,
  OrchestratorConfig,
  PluginRegistry,
  PipelineConfig,
  CleanupResult,
} from "../types.js";

// =============================================================================
// MOCK child_process — prevent real commands from running
// =============================================================================

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout: "", stderr: "" });
    },
  );
  return {
    execFile: mockExecFile,
  };
});

// Import the mocked module
import { execFile } from "node:child_process";
const mockedExecFile = vi.mocked(execFile);

// =============================================================================
// TEST HELPERS
// =============================================================================

let tmpDir: string;
let configPath: string;

function makePipelineConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    enabled: true,
    checkCommands: ["echo ok"],
    testAgent: { agent: "mock-agent", model: "test-model", maxRetries: 2 },
    reviewAgent: { agent: "mock-agent", model: "test-model", maxRetries: 2 },
    maxIterations: 3,
    ...overrides,
  };
}

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: "app-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: tmpDir,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: { role: "coder" },
    ...overrides,
  };
}

function makeConfig(pipeline?: PipelineConfig): OrchestratorConfig {
  return {
    configPath,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: [],
    },
    projects: {
      "test-project": {
        name: "Test Project",
        repo: "owner/repo",
        path: tmpDir,
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
    pipeline,
  };
}

function makeSessionManager(overrides?: Partial<SessionManager>): SessionManager {
  return {
    spawn: vi.fn().mockResolvedValue(makeSession({ id: "app-2", status: "spawning" })),
    spawnOrchestrator: vi.fn().mockResolvedValue(makeSession()),
    restore: vi.fn().mockResolvedValue(makeSession()),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue({ killed: [], skipped: [], errors: [] } satisfies CleanupResult),
    send: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeRegistry(): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn().mockResolvedValue(undefined),
    loadFromConfig: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Helper to configure the mocked execFile for check commands.
 * By default, all calls succeed. Pass a list of results to control per-call behavior.
 */
function mockExecFileResults(
  results: Array<{ success: boolean; stdout?: string; stderr?: string }>,
): void {
  let callIndex = 0;
  mockedExecFile.mockImplementation(
    (
      _cmd: unknown,
      _args: unknown,
      _opts: unknown,
      cb: unknown,
    ) => {
      const result = results[callIndex] ?? { success: true };
      callIndex++;
      const callback = cb as (err: Error | null, result: { stdout: string; stderr: string }) => void;
      if (result.success) {
        callback(null, { stdout: result.stdout ?? "", stderr: "" });
      } else {
        const err = new Error("Command failed") as Error & { stdout: string; stderr: string };
        err.stdout = result.stdout ?? "";
        err.stderr = result.stderr ?? "check failed";
        callback(err, { stdout: "", stderr: "" });
      }
      // Return a fake ChildProcess-like object for type compatibility
      return undefined as unknown as ReturnType<typeof execFile>;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();

  tmpDir = join(tmpdir(), `ao-test-pipeline-int-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  // Default: all execFile calls succeed
  mockExecFileResults([
    { success: true },
    { success: true },
    { success: true },
    { success: true },
    { success: true },
    { success: true },
  ]);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe("Pipeline Integration", () => {
  it("should run full pipeline: checks -> test -> review -> approved", async () => {
    // Write a verdict file that approves
    const verdictPath = join(tmpDir, ".ao-review-app-1.json");
    const approveVerdict = {
      verdict: "approve",
      summary: "Code looks good",
      comments: [],
    };
    writeFileSync(verdictPath, JSON.stringify(approveVerdict));

    // Mock sessionManager.get to return terminal status for spawned agents
    // (so pollUntilTerminal exits quickly)
    const getCallCount = { count: 0 };
    const sm = makeSessionManager({
      get: vi.fn().mockImplementation((id: string) => {
        getCallCount.count++;
        // When checking spawned test or review agent, return terminal state
        if (id !== "app-1") {
          return Promise.resolve(
            makeSession({ id, status: "done", activity: "exited" }),
          );
        }
        return Promise.resolve(makeSession());
      }),
    });

    const config = makeConfig(
      makePipelineConfig({
        checkCommands: ["echo ok"],
        maxIterations: 1,
      }),
    );
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(makeSession());

    expect(result.success).toBe(true);
    expect(result.stage).toBe("approved");
    expect(result.iteration).toBe(1);

    // Verify spawn was called for test agent and review agent
    expect(sm.spawn).toHaveBeenCalledTimes(2);

    // First spawn: test agent
    const testSpawnCall = vi.mocked(sm.spawn).mock.calls[0][0];
    expect(testSpawnCall.role).toBe("tester");
    expect(testSpawnCall.skipPipeline).toBe(true);
    expect(testSpawnCall.workspacePath).toBe(tmpDir);

    // Second spawn: review agent
    const reviewSpawnCall = vi.mocked(sm.spawn).mock.calls[1][0];
    expect(reviewSpawnCall.role).toBe("reviewer");
    expect(reviewSpawnCall.skipPipeline).toBe(true);
  });

  it("should loop back when checks fail then succeed", async () => {
    // First iteration: checks fail, feedback sent to coder, coder becomes idle
    // Second iteration: checks pass, test + review pass -> approved
    const verdictPath = join(tmpDir, ".ao-review-app-1.json");
    const approveVerdict = {
      verdict: "approve",
      summary: "LGTM",
      comments: [],
    };
    writeFileSync(verdictPath, JSON.stringify(approveVerdict));

    // Track execFile call count to fail first check, pass rest
    mockExecFileResults([
      { success: false, stderr: "lint error: missing semicolon" }, // iteration 1: check fails
      { success: true }, // iteration 2: check passes
      { success: true }, // iteration 2: re-check after test passes
    ]);

    let getCallCount = 0;
    const sm = makeSessionManager({
      get: vi.fn().mockImplementation((id: string) => {
        getCallCount++;
        if (id !== "app-1") {
          // Spawned agents (test/review) terminate quickly
          return Promise.resolve(
            makeSession({ id, status: "done", activity: "exited" }),
          );
        }
        // Coder session: after receiving feedback, becomes idle (fix applied)
        return Promise.resolve(
          makeSession({ activity: "idle" }),
        );
      }),
    });

    const config = makeConfig(
      makePipelineConfig({
        checkCommands: ["pnpm lint"],
        maxIterations: 3,
      }),
    );
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(makeSession());

    expect(result.success).toBe(true);
    expect(result.stage).toBe("approved");
    expect(result.iteration).toBe(2);

    // Feedback should have been sent to the coder after first failure
    expect(sm.send).toHaveBeenCalledTimes(1);
    const feedbackMessage = vi.mocked(sm.send).mock.calls[0][1];
    expect(feedbackMessage).toContain("Automated checks failed");
    expect(feedbackMessage).toContain("attempt 1/3");
  });

  it("should respect maxIterations limit", async () => {
    // All checks fail — pipeline should give up after maxIterations
    mockExecFileResults([
      { success: false, stderr: "error 1" }, // iteration 1
      { success: false, stderr: "error 2" }, // iteration 2
    ]);

    const sm = makeSessionManager({
      get: vi.fn().mockImplementation((id: string) => {
        if (id !== "app-1") {
          return Promise.resolve(
            makeSession({ id, status: "done", activity: "exited" }),
          );
        }
        // Coder becomes idle after each feedback (applies fix but it still fails)
        return Promise.resolve(makeSession({ activity: "idle" }));
      }),
    });

    const config = makeConfig(
      makePipelineConfig({
        checkCommands: ["pnpm typecheck"],
        maxIterations: 2,
      }),
    );
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(makeSession());

    expect(result.success).toBe(false);
    expect(result.iteration).toBe(2);
    expect(result.stage).toBe("checks");
    expect(result.message).toContain("Check failed");
  });

  it("should skip pipeline when role is tester", async () => {
    const sm = makeSessionManager();
    const config = makeConfig(makePipelineConfig());
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(
      makeSession({ metadata: { role: "tester" } }),
    );

    expect(result.success).toBe(true);
    expect(result.stage).toBe("approved");
    expect(result.iteration).toBe(0);
    // No spawn calls — pipeline was skipped
    expect(sm.spawn).not.toHaveBeenCalled();
    // No execFile calls — no checks ran
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("should skip pipeline when role is reviewer", async () => {
    const sm = makeSessionManager();
    const config = makeConfig(makePipelineConfig());
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(
      makeSession({ metadata: { role: "reviewer" } }),
    );

    expect(result.success).toBe(true);
    expect(result.stage).toBe("approved");
    expect(result.iteration).toBe(0);
    expect(sm.spawn).not.toHaveBeenCalled();
  });

  it("should skip when config has enabled: false", async () => {
    const sm = makeSessionManager();
    const config = makeConfig(makePipelineConfig({ enabled: false }));
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(makeSession());

    expect(result.success).toBe(true);
    expect(result.stage).toBe("approved");
    expect(result.iteration).toBe(0);
    expect(sm.spawn).not.toHaveBeenCalled();
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("should skip when pipeline config is undefined (defaults to disabled)", async () => {
    const sm = makeSessionManager();
    const config = makeConfig(undefined);
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(makeSession());

    expect(result.success).toBe(true);
    expect(result.stage).toBe("approved");
  });

  it("should skip when skipPipeline metadata flag is set", async () => {
    const sm = makeSessionManager();
    const config = makeConfig(makePipelineConfig());
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(
      makeSession({ metadata: { role: "coder", skipPipeline: "true" } }),
    );

    expect(result.success).toBe(true);
    expect(result.stage).toBe("approved");
    expect(sm.spawn).not.toHaveBeenCalled();
  });

  it("should fail when test agent spawn fails", async () => {
    const sm = makeSessionManager({
      spawn: vi.fn().mockRejectedValue(new Error("Runtime unavailable")),
    });
    const config = makeConfig(
      makePipelineConfig({
        checkCommands: ["echo ok"],
        maxIterations: 1,
      }),
    );
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(makeSession());

    expect(result.success).toBe(false);
    expect(result.stage).toBe("testing");
    expect(result.message).toContain("Failed to spawn test agent");
    expect(result.message).toContain("Runtime unavailable");
  });

  it("should fail when review agent produces request_changes verdict", async () => {
    const verdictPath = join(tmpDir, ".ao-review-app-1.json");
    const rejectVerdict = {
      verdict: "request_changes",
      summary: "Found security issues",
      comments: ["SQL injection in auth.ts", "Missing input validation"],
    };
    writeFileSync(verdictPath, JSON.stringify(rejectVerdict));

    const sm = makeSessionManager({
      get: vi.fn().mockImplementation((id: string) => {
        if (id !== "app-1") {
          return Promise.resolve(
            makeSession({ id, status: "done", activity: "exited" }),
          );
        }
        // Coder becomes idle for fix attempts
        return Promise.resolve(makeSession({ activity: "idle" }));
      }),
    });

    const config = makeConfig(
      makePipelineConfig({
        checkCommands: ["echo ok"],
        maxIterations: 1,
      }),
    );
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(makeSession());

    expect(result.success).toBe(false);
    expect(result.stage).toBe("reviewing");
    expect(result.message).toContain("Found security issues");
    expect(result.message).toContain("SQL injection in auth.ts");
    expect(result.message).toContain("Missing input validation");
  });

  it("should fail when session has no workspace path", async () => {
    const sm = makeSessionManager();
    const config = makeConfig(makePipelineConfig());
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(makeSession({ workspacePath: null }));

    expect(result.success).toBe(false);
    expect(result.stage).toBe("checks");
    expect(result.message).toContain("No workspace path");
  });

  it("should prevent concurrent pipeline runs on the same session", async () => {
    // Make the first run take some time via a slow check command
    mockExecFileResults([
      { success: true }, // Slow but we can't actually sleep in mock
    ]);

    // Use a deferred promise to control when the first run completes
    let resolveSpawn: ((value: Session) => void) | undefined;
    const sm = makeSessionManager({
      spawn: vi.fn().mockImplementation(() => {
        return new Promise<Session>((resolve) => {
          resolveSpawn = resolve;
        });
      }),
    });

    const config = makeConfig(
      makePipelineConfig({
        checkCommands: ["echo ok"],
        maxIterations: 1,
      }),
    );
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const session = makeSession();

    // Start first run (blocks at spawn)
    const run1 = pm.run(session);
    // Small delay to ensure run1 registers in the running set
    await new Promise((r) => setTimeout(r, 10));

    expect(pm.isRunning(session.id)).toBe(true);

    // Second concurrent run should fail immediately
    const result2 = await pm.run(session);
    expect(result2.success).toBe(false);
    expect(result2.message).toContain("Pipeline already running");

    // Clean up: resolve the first run's spawn so it completes
    if (resolveSpawn) {
      resolveSpawn(makeSession({ id: "app-2", status: "done", activity: "exited" }));
    }
    await run1;
  });

  it("should send feedback with iteration count when checks fail mid-pipeline", async () => {
    // Checks fail on first iteration, succeed on second
    mockExecFileResults([
      { success: false, stderr: "build error: missing module" },
      { success: true }, // iteration 2: checks pass
      { success: true }, // iteration 2: re-check after test
    ]);

    const verdictPath = join(tmpDir, ".ao-review-app-1.json");
    writeFileSync(
      verdictPath,
      JSON.stringify({ verdict: "approve", summary: "Good", comments: [] }),
    );

    const sm = makeSessionManager({
      get: vi.fn().mockImplementation((id: string) => {
        if (id !== "app-1") {
          return Promise.resolve(
            makeSession({ id, status: "done", activity: "exited" }),
          );
        }
        return Promise.resolve(makeSession({ activity: "idle" }));
      }),
    });

    const config = makeConfig(
      makePipelineConfig({
        checkCommands: ["pnpm build"],
        maxIterations: 3,
      }),
    );
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(makeSession());

    expect(result.success).toBe(true);

    // Verify feedback was sent
    expect(sm.send).toHaveBeenCalledWith(
      "app-1",
      expect.stringContaining("attempt 1/3"),
    );
  });

  it("should fail if coder exits while waiting for fix", async () => {
    // Checks fail, then coder exits (terminal state)
    mockExecFileResults([
      { success: false, stderr: "type error" },
    ]);

    const sm = makeSessionManager({
      get: vi.fn().mockImplementation((id: string) => {
        if (id !== "app-1") {
          return Promise.resolve(
            makeSession({ id, status: "done", activity: "exited" }),
          );
        }
        // Coder session has exited
        return Promise.resolve(
          makeSession({ status: "killed", activity: "exited" }),
        );
      }),
    });

    const config = makeConfig(
      makePipelineConfig({
        checkCommands: ["pnpm typecheck"],
        maxIterations: 3,
      }),
    );
    const registry = makeRegistry();

    const pm = createPipelineManager({ sessionManager: sm, config, registry });
    const result = await pm.run(makeSession());

    expect(result.success).toBe(false);
    expect(result.stage).toBe("checks");
    // Pipeline should have stopped because coder exited
    expect(result.iteration).toBe(1);
  });
});
