/**
 * In-process lifecycle worker management.
 *
 * Instead of spawning a detached subprocess, the lifecycle manager runs
 * directly in the `ao start` process. This keeps `ao lifecycle-worker`
 * out of the CLI surface area.
 */

import type { LifecycleManager, OrchestratorConfig } from "@composio/ao-core";
import { getLifecycleManager } from "./create-session-manager.js";

export interface LifecycleWorkerStatus {
  running: boolean;
  started: boolean;
  pid: number | null;
}

/** Active in-process lifecycle managers keyed by projectId (or "__all__") */
const activeManagers = new Map<string, LifecycleManager>();

/**
 * In-flight creation promises keyed by projectId.
 *
 * Guards the async TOCTOU window between `activeManagers.has(key)` and
 * `activeManagers.set(key, lifecycle)`. Without this, two concurrent calls for
 * the same projectId can both pass the `has` guard, create two managers, and
 * the second `set` silently overwrites the first — leaking the first manager's
 * polling timer with no way to stop it.
 */
const pendingManagers = new Map<string, Promise<LifecycleManager>>();

/**
 * Ensure a lifecycle manager is running for the given project.
 * Creates one in-process if not already active.
 */
export async function ensureLifecycleWorker(
  config: OrchestratorConfig,
  projectId: string,
): Promise<LifecycleWorkerStatus> {
  const key = projectId;

  // Already running in-process
  if (activeManagers.has(key)) {
    return { running: true, started: false, pid: process.pid };
  }

  // If a creation is already in flight for this key, wait for it rather than
  // starting a second manager that would overwrite the first.
  if (pendingManagers.has(key)) {
    await pendingManagers.get(key);
    return { running: true, started: false, pid: process.pid };
  }

  const promise = getLifecycleManager(config, projectId);
  pendingManagers.set(key, promise);
  try {
    const lifecycle = await promise;
    try {
      lifecycle.start(30_000);
    } catch (startErr) {
      // start() failed — stop the manager to release any partially-initialized
      // state (timers, connections) before propagating the error.
      try { lifecycle.stop(); } catch { /* best effort */ }
      throw startErr;
    }
    activeManagers.set(key, lifecycle);
  } finally {
    pendingManagers.delete(key);
  }

  return { running: true, started: true, pid: process.pid };
}

/**
 * Stop the lifecycle manager for a project.
 */
export async function stopLifecycleWorker(
  _config: OrchestratorConfig,
  projectId: string,
): Promise<boolean> {
  const key = projectId;
  const manager = activeManagers.get(key);
  if (!manager) return false;

  manager.stop();
  activeManagers.delete(key);
  return true;
}

/**
 * Check if a lifecycle manager is running for a project.
 */
export function getLifecycleWorkerStatus(
  _config: OrchestratorConfig,
  projectId: string,
): LifecycleWorkerStatus {
  const running = activeManagers.has(projectId);
  return { running, started: false, pid: running ? process.pid : null };
}

/**
 * Pin the lifecycle worker for a project so the process stays alive.
 *
 * By default, lifecycle timers are unref'd so the process can exit naturally
 * once the foreground work is done. Calling pinLifecycleWorker re-refs the
 * underlying timer so the process stays alive as long as the lifecycle manager
 * is active.
 *
 * Used in `attachToRunning` mode when the existing daemon doesn't cover the
 * new project: this process must stay alive to poll it.
 */
export function pinLifecycleWorker(projectId: string): void {
  const manager = activeManagers.get(projectId);
  if (manager) {
    manager.pin();
  }
}
