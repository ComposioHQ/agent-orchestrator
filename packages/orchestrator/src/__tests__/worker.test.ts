import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildExecutionOrder,
  buildWorkerPrompt,
  resolveWorkerCli,
  dispatchWorkers,
  executeWorker,
} from "../worker.js";
import type { Subtask, WorkerResult } from "../types.js";
import { getDefaultConfig } from "../config.js";
import { EventEmitter } from "node:events";

// =============================================================================
// buildExecutionOrder tests
// =============================================================================

function makeSubtask(
  id: string,
  deps: string[] = [],
): Subtask {
  return { id, description: `Task ${id}`, dependencies: deps, status: "pending" };
}

describe("buildExecutionOrder", () => {
  it("returns single wave for no dependencies", () => {
    const subtasks = [makeSubtask("1"), makeSubtask("2"), makeSubtask("3")];
    const waves = buildExecutionOrder(subtasks);
    expect(waves).toHaveLength(1);
    expect(waves[0].map((s) => s.id).sort()).toEqual(["1", "2", "3"]);
  });

  it("returns sequential waves for chain dependencies", () => {
    const subtasks = [
      makeSubtask("1"),
      makeSubtask("2", ["1"]),
      makeSubtask("3", ["2"]),
    ];
    const waves = buildExecutionOrder(subtasks);
    expect(waves).toHaveLength(3);
    expect(waves[0].map((s) => s.id)).toEqual(["1"]);
    expect(waves[1].map((s) => s.id)).toEqual(["2"]);
    expect(waves[2].map((s) => s.id)).toEqual(["3"]);
  });

  it("groups independent tasks with mixed dependencies", () => {
    const subtasks = [
      makeSubtask("1"),
      makeSubtask("2"),
      makeSubtask("3", ["1", "2"]),
      makeSubtask("4", ["1"]),
    ];
    const waves = buildExecutionOrder(subtasks);
    expect(waves).toHaveLength(2);
    expect(waves[0].map((s) => s.id).sort()).toEqual(["1", "2"]);
    expect(waves[1].map((s) => s.id).sort()).toEqual(["3", "4"]);
  });

  it("detects cycles and throws", () => {
    const subtasks = [
      makeSubtask("1", ["2"]),
      makeSubtask("2", ["1"]),
    ];
    expect(() => buildExecutionOrder(subtasks)).toThrow(/cycle/i);
  });

  it("detects self-dependency cycle", () => {
    const subtasks = [makeSubtask("1", ["1"])];
    expect(() => buildExecutionOrder(subtasks)).toThrow(/cycle/i);
  });

  it("returns empty array for empty input", () => {
    expect(buildExecutionOrder([])).toEqual([]);
  });

  it("handles diamond dependency pattern", () => {
    // 1 -> 2, 1 -> 3, 2+3 -> 4
    const subtasks = [
      makeSubtask("1"),
      makeSubtask("2", ["1"]),
      makeSubtask("3", ["1"]),
      makeSubtask("4", ["2", "3"]),
    ];
    const waves = buildExecutionOrder(subtasks);
    expect(waves).toHaveLength(3);
    expect(waves[0].map((s) => s.id)).toEqual(["1"]);
    expect(waves[1].map((s) => s.id).sort()).toEqual(["2", "3"]);
    expect(waves[2].map((s) => s.id)).toEqual(["4"]);
  });
});

// =============================================================================
// buildWorkerPrompt tests
// =============================================================================

describe("buildWorkerPrompt", () => {
  it("includes subtask description", () => {
    const subtask = makeSubtask("1");
    subtask.description = "Create REST API endpoints";
    const prompt = buildWorkerPrompt(subtask);
    expect(prompt).toContain("Create REST API endpoints");
    expect(prompt).toContain("Your Task");
  });

  it("includes upstream results when provided", () => {
    const subtask = makeSubtask("2", ["1"]);
    const upstreamResults: WorkerResult[] = [
      {
        subtaskId: "1",
        exitCode: 0,
        stdout: "Created auth module",
        stderr: "",
        durationMs: 5000,
        timedOut: false,
      },
    ];
    const prompt = buildWorkerPrompt(subtask, upstreamResults);
    expect(prompt).toContain("Context from Upstream");
    expect(prompt).toContain("Created auth module");
  });

  it("works with no upstream results", () => {
    const subtask = makeSubtask("1");
    const prompt = buildWorkerPrompt(subtask);
    expect(prompt).not.toContain("Upstream");
  });
});

// =============================================================================
// resolveWorkerCli tests
// =============================================================================

describe("resolveWorkerCli", () => {
  it("uses subtask workerCli when present", () => {
    const subtask = makeSubtask("1");
    subtask.workerCli = "codex";
    const config = getDefaultConfig();
    expect(resolveWorkerCli(subtask, config)).toBe("codex");
  });

  it("falls back to config default", () => {
    const subtask = makeSubtask("1");
    const config = getDefaultConfig();
    expect(resolveWorkerCli(subtask, config)).toBe("claude");
  });
});

// =============================================================================
// executeWorker tests (mocked subprocess)
// =============================================================================

describe("executeWorker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns process and captures output", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    // Create a mock child process
    const mockChild = new EventEmitter() as unknown as ReturnType<typeof spawn>;
    const mockStdout = new EventEmitter();
    const mockStderr = new EventEmitter();
    Object.assign(mockChild, {
      stdout: mockStdout,
      stderr: mockStderr,
      stdin: { write: vi.fn(), end: vi.fn() },
      pid: 12345,
    });

    mockSpawn.mockReturnValue(mockChild);

    const subtask = makeSubtask("1");
    const config = getDefaultConfig();
    const resultPromise = executeWorker(subtask, config, "/tmp/repo");

    // Simulate output
    mockStdout.emit("data", Buffer.from("Hello world\n"));
    mockStdout.emit("data", Buffer.from("Done\n"));
    mockChild.emit("close", 0);

    const result = await resultPromise;
    expect(result.subtaskId).toBe("1");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Hello world");
    expect(result.stdout).toContain("Done");
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures stderr", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const mockChild = new EventEmitter() as unknown as ReturnType<typeof spawn>;
    const mockStdout = new EventEmitter();
    const mockStderr = new EventEmitter();
    Object.assign(mockChild, {
      stdout: mockStdout,
      stderr: mockStderr,
      stdin: { write: vi.fn(), end: vi.fn() },
      pid: 12345,
    });

    mockSpawn.mockReturnValue(mockChild);

    const subtask = makeSubtask("1");
    const config = getDefaultConfig();
    const resultPromise = executeWorker(subtask, config, "/tmp/repo");

    mockStderr.emit("data", Buffer.from("Error occurred\n"));
    mockChild.emit("close", 1);

    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error occurred");
  });
});

// =============================================================================
// dispatchWorkers tests (mocked execution)
// =============================================================================

import { spawn as actualSpawn } from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

function createMockChild(exitCode: number, output: string, delay: number = 10) {
  const mockChild = new EventEmitter() as unknown as ReturnType<typeof actualSpawn>;
  const mockStdout = new EventEmitter();
  const mockStderr = new EventEmitter();
  Object.assign(mockChild, {
    stdout: mockStdout,
    stderr: mockStderr,
    stdin: { write: vi.fn(), end: vi.fn() },
    pid: Math.floor(Math.random() * 10000),
  });

  setTimeout(() => {
    mockStdout.emit("data", Buffer.from(output + "\n"));
    mockChild.emit("close", exitCode);
  }, delay);

  return mockChild;
}

describe("dispatchWorkers", () => {
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const cp = await import("node:child_process");
    mockSpawn = vi.mocked(cp.spawn);
  });

  it("runs independent tasks in parallel", async () => {
    mockSpawn.mockImplementation(() => createMockChild(0, "done"));

    const subtasks = [
      makeSubtask("1"),
      makeSubtask("2"),
      makeSubtask("3"),
    ];
    const config = getDefaultConfig();
    const results = await dispatchWorkers(subtasks, config, "/tmp/repo");

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.exitCode === 0)).toBe(true);
  });

  it("skips dependents of failed workers", async () => {
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      return createMockChild(callCount === 1 ? 1 : 0, callCount === 1 ? "failed" : "ok");
    });

    const subtasks = [
      makeSubtask("1"), // will fail
      makeSubtask("2", ["1"]), // should be skipped
    ];
    const config = getDefaultConfig();
    const results = await dispatchWorkers(subtasks, config, "/tmp/repo");

    expect(results).toHaveLength(2);
    expect(results[0].exitCode).toBe(1); // task 1 failed
    expect(results[1].subtaskId).toBe("2");
    expect(results[1].exitCode).toBe(-1); // skipped
    expect(results[1].stderr).toContain("Skipped");
  });

  it("handles empty subtask list", async () => {
    const config = getDefaultConfig();
    const results = await dispatchWorkers([], config, "/tmp/repo");
    expect(results).toEqual([]);
  });
});
