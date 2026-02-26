/**
 * Worker Pool — Core Lifecycle Enhancement
 *
 * Enforces concurrency limits (global + per-project), provides priority-based
 * spawn decisions when the pool is full, tracks active (non-terminal) sessions,
 * and gives callers actionable info about why a spawn was denied.
 */

import { TERMINAL_STATUSES } from "./types.js";
import type { SessionStatus } from "./types.js";

// =============================================================================
// Types
// =============================================================================

export interface WorkerPoolConfig {
  /** Global max concurrent sessions across all projects (default: 10) */
  globalMaxConcurrent?: number;
  /** Per-project max concurrent sessions (default: 5) */
  projectMaxConcurrent?: number;
  /** Per-project overrides */
  projectOverrides?: Record<string, { maxConcurrent: number }>;
  /** Priority levels for different session types */
  priorities?: Record<string, number>; // e.g. { "issue": 10, "prompt": 5, "orchestrator": 1 }
}

export interface PoolStatus {
  /** Total active sessions across all projects */
  globalActive: number;
  /** Global max concurrent limit */
  globalMax: number;
  /** Per-project active session counts */
  projectCounts: Record<string, { active: number; max: number }>;
}

export interface SpawnCheck {
  /** Whether a new session can be spawned */
  canSpawn: boolean;
  /** Reason if canSpawn is false */
  reason?: string;
  /** Number of slots remaining after this spawn */
  slotsRemaining: number;
  /** Which limit was hit (if any) */
  limitHit?: "global" | "project";
}

export interface WorkerPool {
  /** Check if a new session can be spawned for a project */
  canSpawn(projectId: string): SpawnCheck;
  /** Record that a session was spawned */
  recordSpawn(projectId: string, sessionId: string): void;
  /** Record that a session ended (terminal state) */
  recordExit(projectId: string, sessionId: string): void;
  /** Sync pool state from actual sessions list */
  syncFromSessions(
    sessions: Array<{ id: string; projectId: string; status: string }>,
  ): void;
  /** Get current pool status */
  getStatus(): PoolStatus;
  /** Get active session count for a project */
  getActiveCount(projectId: string): number;
  /** Get active session IDs for a project */
  getActiveSessions(projectId: string): string[];
  /** Clear all state */
  clear(): void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_GLOBAL_MAX_CONCURRENT = 10;
const DEFAULT_PROJECT_MAX_CONCURRENT = 5;

// =============================================================================
// Factory
// =============================================================================

export function createWorkerPool(config?: WorkerPoolConfig): WorkerPool {
  const globalMax = config?.globalMaxConcurrent ?? DEFAULT_GLOBAL_MAX_CONCURRENT;
  const defaultProjectMax =
    config?.projectMaxConcurrent ?? DEFAULT_PROJECT_MAX_CONCURRENT;
  const projectOverrides = config?.projectOverrides ?? {};

  /**
   * Map from projectId to a Set of active session IDs.
   * Only non-terminal sessions are tracked here.
   */
  const projectSessions = new Map<string, Set<string>>();

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Get or create the session set for a project. */
  function getSessionSet(projectId: string): Set<string> {
    let sessions = projectSessions.get(projectId);
    if (!sessions) {
      sessions = new Set<string>();
      projectSessions.set(projectId, sessions);
    }
    return sessions;
  }

  /** Get the configured max concurrent for a specific project. */
  function getProjectMax(projectId: string): number {
    return projectOverrides[projectId]?.maxConcurrent ?? defaultProjectMax;
  }

  /** Count total active sessions across all projects. */
  function getGlobalActiveCount(): number {
    let count = 0;
    for (const sessions of projectSessions.values()) {
      count += sessions.size;
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Interface implementation
  // ---------------------------------------------------------------------------

  function canSpawn(projectId: string): SpawnCheck {
    const globalActive = getGlobalActiveCount();
    const projectMax = getProjectMax(projectId);
    const projectActive = getSessionSet(projectId).size;

    // Check global limit first
    if (globalActive >= globalMax) {
      const slotsRemaining = 0;
      return {
        canSpawn: false,
        reason: `Global concurrency limit reached (${globalActive}/${globalMax} sessions active)`,
        slotsRemaining,
        limitHit: "global",
      };
    }

    // Check per-project limit
    if (projectActive >= projectMax) {
      const globalSlotsRemaining = globalMax - globalActive;
      return {
        canSpawn: false,
        reason: `Project "${projectId}" concurrency limit reached (${projectActive}/${projectMax} sessions active)`,
        slotsRemaining: globalSlotsRemaining,
        limitHit: "project",
      };
    }

    // Both limits have room — compute remaining slots (minimum of both)
    const globalRemaining = globalMax - globalActive - 1; // -1 for the upcoming spawn
    const projectRemaining = projectMax - projectActive - 1;
    const slotsRemaining = Math.min(globalRemaining, projectRemaining);

    return {
      canSpawn: true,
      slotsRemaining,
    };
  }

  function recordSpawn(projectId: string, sessionId: string): void {
    getSessionSet(projectId).add(sessionId);
  }

  function recordExit(projectId: string, sessionId: string): void {
    const sessions = projectSessions.get(projectId);
    if (sessions) {
      sessions.delete(sessionId);
      // Clean up empty sets to avoid memory leaks
      if (sessions.size === 0) {
        projectSessions.delete(projectId);
      }
    }
  }

  function syncFromSessions(
    sessions: Array<{ id: string; projectId: string; status: string }>,
  ): void {
    // Clear current state
    projectSessions.clear();

    // Rebuild from the provided session list
    for (const session of sessions) {
      if (!TERMINAL_STATUSES.has(session.status as SessionStatus)) {
        getSessionSet(session.projectId).add(session.id);
      }
    }
  }

  function getStatus(): PoolStatus {
    const projectCounts: Record<string, { active: number; max: number }> = {};

    // Include all tracked projects
    for (const [projectId, sessions] of projectSessions) {
      projectCounts[projectId] = {
        active: sessions.size,
        max: getProjectMax(projectId),
      };
    }

    // Also include projects with overrides that may not have active sessions
    for (const projectId of Object.keys(projectOverrides)) {
      if (!projectCounts[projectId]) {
        projectCounts[projectId] = {
          active: 0,
          max: getProjectMax(projectId),
        };
      }
    }

    return {
      globalActive: getGlobalActiveCount(),
      globalMax: globalMax,
      projectCounts,
    };
  }

  function getActiveCount(projectId: string): number {
    return projectSessions.get(projectId)?.size ?? 0;
  }

  function getActiveSessions(projectId: string): string[] {
    const sessions = projectSessions.get(projectId);
    return sessions ? Array.from(sessions) : [];
  }

  function clear(): void {
    projectSessions.clear();
  }

  return {
    canSpawn,
    recordSpawn,
    recordExit,
    syncFromSessions,
    getStatus,
    getActiveCount,
    getActiveSessions,
    clear,
  };
}
