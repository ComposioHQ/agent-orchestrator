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

  const lifecycle = await getLifecycleManager(config, projectId);
  lifecycle.start(30_000);
  activeManagers.set(key, lifecycle);

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
