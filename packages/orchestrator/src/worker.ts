import { spawn, type ChildProcess } from "node:child_process";
import type { Subtask, WorkerResult } from "./types.js";
import type { OrchestratorTomlConfig } from "./config.js";

const MAX_OUTPUT_LINES = 1000;
const KILL_GRACE_MS = 5000;

// =============================================================================
// TOPOLOGICAL SORT — group subtasks into execution waves
// =============================================================================

/**
 * Group subtasks into waves where each wave can run in parallel.
 * Wave 0: subtasks with no dependencies.
 * Wave N: subtasks whose dependencies are all in waves 0..N-1.
 * Throws if a cycle is detected.
 */
export function buildExecutionOrder(subtasks: Subtask[]): Subtask[][] {
  if (subtasks.length === 0) return [];

  const idToSubtask = new Map(subtasks.map((s) => [s.id, s]));
  const assigned = new Map<string, number>(); // id -> wave index
  const waves: Subtask[][] = [];

  let remaining = subtasks.length;
  let waveIndex = 0;

  while (remaining > 0) {
    const wave: Subtask[] = [];

    for (const subtask of subtasks) {
      if (assigned.has(subtask.id)) continue;

      // Check if all dependencies are assigned to previous waves
      const depsResolved = subtask.dependencies.every((depId) => {
        const depWave = assigned.get(depId);
        return depWave !== undefined && depWave < waveIndex;
      });

      if (depsResolved) {
        wave.push(subtask);
      }
    }

    if (wave.length === 0) {
      // No progress — cycle detected
      const unresolved = subtasks
        .filter((s) => !assigned.has(s.id))
        .map((s) => `${s.id} (deps: ${s.dependencies.join(", ")})`)
        .join("; ");
      throw new Error(
        `Dependency cycle detected. Unresolved subtasks: ${unresolved}`,
      );
    }

    for (const subtask of wave) {
      assigned.set(subtask.id, waveIndex);
    }
    waves.push(wave);
    remaining -= wave.length;
    waveIndex++;
  }

  return waves;
}

// =============================================================================
// WORKER PROMPT
// =============================================================================

/**
 * Build the prompt for a worker agent.
 */
export function buildWorkerPrompt(
  subtask: Subtask,
  upstreamResults?: WorkerResult[],
): string {
  const sections: string[] = [];

  sections.push(
    `You are a worker agent executing a specific subtask. Focus only on the described task.`,
  );
  sections.push(`\n## Your Task\n${subtask.description}`);

  if (upstreamResults && upstreamResults.length > 0) {
    sections.push(`\n## Context from Upstream Tasks`);
    for (const result of upstreamResults) {
      const stdout =
        result.stdout.length > 2000
          ? result.stdout.slice(0, 2000) + "\n... (truncated)"
          : result.stdout;
      sections.push(`\n### Subtask ${result.subtaskId}`);
      sections.push(`Exit code: ${result.exitCode}`);
      if (stdout) sections.push(`Output:\n\`\`\`\n${stdout}\n\`\`\``);
    }
  }

  sections.push(`\n## Instructions
- Focus only on the described task
- Output your work directly — code changes, explanations, test results
- If you encounter a blocker, explain it clearly`);

  return sections.join("\n");
}

// =============================================================================
// CLI RESOLUTION
// =============================================================================

/**
 * Resolve which CLI to use for a subtask.
 * Priority: subtask.workerCli > config.workers.overrides > config.workers.cli
 */
export function resolveWorkerCli(
  subtask: Subtask,
  config: OrchestratorTomlConfig,
): string {
  if (subtask.workerCli) return subtask.workerCli;
  // No automatic override matching in Phase 1 — overrides are for future use
  return config.workers.cli;
}

// =============================================================================
// SINGLE WORKER EXECUTION
// =============================================================================

/**
 * Execute a single worker agent as a subprocess.
 * Uses spawn with rolling output buffer and timeout.
 */
export async function executeWorker(
  subtask: Subtask,
  config: OrchestratorTomlConfig,
  repoPath: string,
  upstreamResults?: WorkerResult[],
): Promise<WorkerResult> {
  const cli = resolveWorkerCli(subtask, config);
  const prompt = buildWorkerPrompt(subtask, upstreamResults);
  const args = ["--print", "-p", prompt];

  if (config.planner.model) {
    args.push("--model", config.planner.model);
  }

  const startTime = Date.now();
  const timeoutMs = config.workers.timeout_minutes * 60 * 1000;

  return new Promise<WorkerResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cli, args, {
        cwd: repoPath,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
        detached: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({
        subtaskId: subtask.id,
        exitCode: 1,
        stdout: "",
        stderr: `Failed to spawn ${cli}: ${msg}`,
        durationMs: Date.now() - startTime,
        timedOut: false,
      });
      return;
    }

    const stdoutBuffer: string[] = [];
    const stderrBuffer: string[] = [];
    let timedOut = false;

    // Rolling buffer — same pattern as runtime-process plugin
    function makeAppendOutput(buffer: string[]): (data: Buffer) => void {
      let partial = "";
      return (data: Buffer) => {
        const text = partial + data.toString("utf-8");
        const lines = text.split("\n");
        partial = lines.pop()!;
        for (const line of lines) {
          buffer.push(line);
        }
        if (buffer.length > MAX_OUTPUT_LINES) {
          buffer.splice(0, buffer.length - MAX_OUTPUT_LINES);
        }
      };
    }

    child.stdout?.on("data", makeAppendOutput(stdoutBuffer));
    child.stderr?.on("data", makeAppendOutput(stderrBuffer));

    // Timeout handling
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, timeoutMs);

    child.on("error", () => {
      // Prevent unhandled error crash — captured in close handler
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        subtaskId: subtask.id,
        exitCode: code ?? 1,
        stdout: stdoutBuffer.join("\n"),
        stderr: stderrBuffer.join("\n"),
        durationMs: Date.now() - startTime,
        timedOut,
      });
    });
  });
}

/**
 * Kill a process group: SIGTERM, wait grace period, then SIGKILL.
 */
function killProcessGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Process may already be dead
    return;
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already dead
    }
  }, KILL_GRACE_MS);
}

// =============================================================================
// DISPATCH — run waves with concurrency limit
// =============================================================================

/**
 * Dispatch all subtasks respecting dependencies and max_parallel.
 * Returns WorkerResult for all subtasks (including skipped ones).
 */
export async function dispatchWorkers(
  subtasks: Subtask[],
  config: OrchestratorTomlConfig,
  repoPath: string,
): Promise<WorkerResult[]> {
  const waves = buildExecutionOrder(subtasks);
  const allResults: WorkerResult[] = [];
  const failedIds = new Set<string>();

  for (const wave of waves) {
    // Filter out subtasks whose dependencies failed
    const runnable: Subtask[] = [];
    const skipped: Subtask[] = [];

    for (const subtask of wave) {
      const depFailed = subtask.dependencies.some((depId) =>
        failedIds.has(depId),
      );
      if (depFailed) {
        skipped.push(subtask);
      } else {
        runnable.push(subtask);
      }
    }

    // Record skipped results
    for (const subtask of skipped) {
      subtask.status = "skipped";
      allResults.push({
        subtaskId: subtask.id,
        exitCode: -1,
        stdout: "",
        stderr: "Skipped: upstream dependency failed",
        durationMs: 0,
        timedOut: false,
      });
    }

    // Get upstream results for this wave's subtasks
    const upstreamResults = allResults.filter((r) =>
      wave.some((s) => s.dependencies.includes(r.subtaskId)),
    );

    // Execute with concurrency limit
    const waveResults = await executeWithLimit(
      runnable,
      config.workers.max_parallel,
      async (subtask) => {
        subtask.status = "running";
        const result = await executeWorker(
          subtask,
          config,
          repoPath,
          upstreamResults.length > 0 ? upstreamResults : undefined,
        );
        subtask.status = result.exitCode === 0 ? "done" : "failed";
        subtask.result = result;
        if (result.exitCode !== 0) {
          failedIds.add(subtask.id);
        }
        return result;
      },
    );

    allResults.push(...waveResults);
  }

  return allResults;
}

/**
 * Execute items with a concurrency limit using a simple semaphore.
 */
async function executeWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results: R[] = [];
  let index = 0;

  async function runNext(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await fn(items[currentIndex]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runNext(),
  );
  await Promise.all(workers);
  return results;
}
