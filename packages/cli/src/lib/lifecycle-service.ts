import {
  createCorrelationId,
  createProjectObserver,
  type LifecycleManager,
  type OrchestratorConfig,
} from "@aoagents/ao-core";
import { getLifecycleManager } from "./create-session-manager.js";

const DEFAULT_INTERVAL_MS = 30_000;

interface ActiveLoop {
  lifecycle: LifecycleManager;
  stop: () => void;
}

const active = new Map<string, ActiveLoop>();
let signalsRegistered = false;

function registerSignalsOnce(): void {
  if (signalsRegistered) return;
  signalsRegistered = true;

  const shutdown = (): void => {
    for (const projectId of Array.from(active.keys())) {
      const entry = active.get(projectId);
      if (entry) {
        try {
          entry.stop();
        } catch {
          // Best-effort shutdown: one project's failure must not block others.
        }
      }
      active.delete(projectId);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("beforeExit", shutdown);
}

export interface LifecycleWorkerStatus {
  running: boolean;
  started: boolean;
}

export async function ensureLifecycleWorker(
  config: OrchestratorConfig,
  projectId: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<LifecycleWorkerStatus> {
  if (!config.projects[projectId]) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  if (active.has(projectId)) {
    return { running: true, started: false };
  }

  registerSignalsOnce();

  const observer = createProjectObserver(config, "lifecycle-service");
  const lifecycle = await getLifecycleManager(config, projectId);

  lifecycle.start(intervalMs);

  observer.setHealth({
    surface: "lifecycle.worker",
    status: "ok",
    projectId,
    correlationId: createCorrelationId("lifecycle-service"),
    details: { projectId, intervalMs, inProcess: true },
  });

  active.set(projectId, {
    lifecycle,
    stop: () => {
      try {
        lifecycle.stop();
      } finally {
        observer.setHealth({
          surface: "lifecycle.worker",
          status: "warn",
          projectId,
          correlationId: createCorrelationId("lifecycle-service"),
          reason: "Lifecycle polling stopped",
          details: { projectId },
        });
      }
    },
  });

  return { running: true, started: true };
}

export async function stopLifecycleWorker(
  _config: OrchestratorConfig,
  projectId: string,
): Promise<boolean> {
  const entry = active.get(projectId);
  if (!entry) return false;

  try {
    entry.stop();
  } catch {
    // Best-effort cleanup
  }
  active.delete(projectId);
  return true;
}

export function stopAllLifecycleWorkers(): void {
  for (const projectId of Array.from(active.keys())) {
    const entry = active.get(projectId);
    if (entry) {
      try {
        entry.stop();
      } catch {
        // Best-effort
      }
    }
    active.delete(projectId);
  }
}

export function isLifecycleWorkerRunning(projectId: string): boolean {
  return active.has(projectId);
}

export function listLifecycleWorkers(): string[] {
  return Array.from(active.keys());
}
