/**
 * Session Reaper — nightly cleanup of orphaned/stale tmux sessions.
 *
 * Scheduled job (daily 3am): poll sessions, kill those that are:
 * - orphaned (activity=exited or process dead) for > orphanedThresholdMs
 * - have no PR for > noPrThresholdMs
 * - idle for > orphanedThresholdMs
 *
 * Respects maxKillsPerRun cap per execution.
 */

import { TERMINAL_STATUSES } from "./types.js";
import type { SessionManager } from "./types.js";

// =============================================================================
// Types
// =============================================================================

export interface ReaperConfig {
  /** ms before an orphaned session is killed (default: 2h) */
  orphanedThresholdMs: number;
  /** ms before a session with no PR is killed (default: 4h) */
  noPrThresholdMs: number;
  /** max sessions to kill per run (default: 5) */
  maxKillsPerRun: number;
  /** if true, log what would be killed but don't actually kill */
  dryRun?: boolean;
}

export interface ReapedSession {
  sessionId: string;
  reason: string;
}

export interface SkippedSession {
  sessionId: string;
  reason: string;
}

export interface ReaperError {
  sessionId: string;
  error: string;
}

export interface ReaperResult {
  killed: ReapedSession[];
  skipped: SkippedSession[];
  errors: ReaperError[];
  dryRun: boolean;
}

export interface ReaperDeps {
  sessionManager: SessionManager;
  /** Override current time (for testing) */
  now?: Date;
}

// =============================================================================
// Default config
// =============================================================================

export const DEFAULT_REAPER_CONFIG: ReaperConfig = {
  orphanedThresholdMs: 7_200_000, // 2h
  noPrThresholdMs: 14_400_000, // 4h
  maxKillsPerRun: 5,
};

// =============================================================================
// Core reaper logic
// =============================================================================

/**
 * Reap stale/orphaned sessions according to the given config.
 */
export async function reapStaleSessions(
  config: ReaperConfig,
  deps: ReaperDeps,
): Promise<ReaperResult> {
  const now = deps.now ?? new Date();
  const dryRun = config.dryRun ?? false;

  const killed: ReapedSession[] = [];
  const skipped: SkippedSession[] = [];
  const errors: ReaperError[] = [];

  const sessions = await deps.sessionManager.list();

  for (const session of sessions) {
    // Stop if we hit the kill cap — count attempts (killed + errors), not just successes
    if (killed.length + errors.length >= config.maxKillsPerRun) {
      skipped.push({ sessionId: session.id, reason: "kill cap reached" });
      continue;
    }

    // Skip sessions already in terminal status (not activity — exited activity is reaped)
    if (TERMINAL_STATUSES.has(session.status)) {
      skipped.push({ sessionId: session.id, reason: "terminal state" });
      continue;
    }

    const ageMs = now.getTime() - session.createdAt.getTime();
    const idleMs = now.getTime() - session.lastActivityAt.getTime();

    // Determine kill reason (priority order)
    let killReason: string | null = null;

    if (session.pr === null && ageMs > config.noPrThresholdMs) {
      // No PR after threshold
      killReason = "no PR after threshold";
    } else if (session.activity === "exited" && idleMs > config.orphanedThresholdMs) {
      // Orphaned: process exited
      killReason = "orphaned (process exited)";
    } else if (session.activity === "idle" && idleMs > config.orphanedThresholdMs) {
      // Stale idle
      killReason = "stale idle";
    }

    if (killReason === null) {
      skipped.push({ sessionId: session.id, reason: "no reap condition met" });
      continue;
    }

    // Kill (or dry-run)
    if (!dryRun) {
      try {
        await deps.sessionManager.kill(session.id);
        killed.push({ sessionId: session.id, reason: killReason });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ sessionId: session.id, error: msg });
      }
    } else {
      // dryRun: record what would have been killed without actually killing
      killed.push({ sessionId: session.id, reason: killReason });
    }
  }

  return { killed, skipped, errors, dryRun };
}
