import type { Command } from "commander";
import chalk from "chalk";
import { createCorrelationId, createProjectObserver, loadConfig } from "@composio/ao-core";
import { getLifecycleManager } from "../lib/create-session-manager.js";
import {
  clearLifecycleWorkerPid,
  getLifecycleWorkerStatus,
  writeLifecycleWorkerPid,
} from "../lib/lifecycle-service.js";

function parseInterval(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

export function registerLifecycleWorker(program: Command): void {
  program
    .command("lifecycle-worker")
    .description("Internal lifecycle polling worker")
    .argument("<project>", "Project ID from config")
    .option("--interval-ms <ms>", "Polling interval in milliseconds", "30000")
    .action(async (projectId: string, opts: { intervalMs?: string }) => {
      const config = loadConfig();
      const observer = createProjectObserver(config, "lifecycle-worker");
      if (!config.projects[projectId]) {
        observer.setHealth({
          surface: "lifecycle.worker",
          status: "error",
          projectId,
          correlationId: createCorrelationId("lifecycle-worker"),
          reason: `Unknown project: ${projectId}`,
          details: { projectId },
        });
        console.error(chalk.red(`Unknown project: ${projectId}`));
        process.exit(1);
      }

      const existing = getLifecycleWorkerStatus(config, projectId);
      if (existing.running && existing.pid !== process.pid) {
        // Another lifecycle worker is already running for this project — exit
        // silently to avoid duplicate polling loops.
        observer.setHealth({
          surface: "lifecycle.worker",
          status: "warn",
          projectId,
          correlationId: createCorrelationId("lifecycle-worker"),
          reason: `Worker already running with pid ${existing.pid}`,
          details: { projectId, pid: existing.pid },
        });
        return;
      }

      const lifecycle = await getLifecycleManager(config, projectId);
      const intervalMs = parseInterval(opts.intervalMs ?? "30000");
      let shuttingDown = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const shutdown = (code: number): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        if (heartbeat) clearInterval(heartbeat);
        lifecycle.stop();
        clearLifecycleWorkerPid(config, projectId, process.pid);
        observer.setHealth({
          surface: "lifecycle.worker",
          status: code === 0 ? "warn" : "error",
          projectId,
          correlationId: createCorrelationId("lifecycle-worker"),
          reason: code === 0 ? "Worker stopped" : "Worker exited unexpectedly",
          details: { projectId, pid: process.pid, exitCode: code },
        });
        // Flush stdout/stderr before exiting so crash messages reach the log file
        const done = (): void => process.exit(code);
        if (process.stdout.writableFinished && process.stderr.writableFinished) {
          done();
        } else {
          let flushed = 0;
          const tryExit = (): void => {
            flushed++;
            if (flushed >= 2) done();
          };
          process.stdout.write("", tryExit);
          process.stderr.write("", tryExit);
          // Hard exit if flush hangs
          setTimeout(done, 1_000).unref();
        }
      };

      process.on("SIGINT", () => shutdown(0));
      process.on("SIGTERM", () => shutdown(0));
      process.on("uncaughtException", (err) => {
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.worker_crash",
          outcome: "failure",
          correlationId: createCorrelationId("lifecycle-worker"),
          projectId,
          reason: err instanceof Error ? err.message : String(err),
          level: "error",
        });
        shutdown(1);
      });
      process.on("unhandledRejection", (reason) => {
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.worker_rejection",
          outcome: "failure",
          correlationId: createCorrelationId("lifecycle-worker"),
          projectId,
          reason: reason instanceof Error ? reason.message : String(reason),
          level: "error",
        });
        shutdown(1);
      });

      writeLifecycleWorkerPid(config, projectId, process.pid);
      observer.setHealth({
        surface: "lifecycle.worker",
        status: "ok",
        projectId,
        correlationId: createCorrelationId("lifecycle-worker"),
        details: { projectId, pid: process.pid, intervalMs },
      });

      // Periodic heartbeat so we can verify the worker is alive from the log
      heartbeat = setInterval(() => {
        observer.setHealth({
          surface: "lifecycle.worker",
          status: "ok",
          projectId,
          correlationId: createCorrelationId("lifecycle-worker"),
          details: { projectId, pid: process.pid, intervalMs, heartbeat: true },
        });
      }, 5 * 60_000); // every 5 minutes
      heartbeat.unref();

      lifecycle.start(intervalMs);
    });
}
