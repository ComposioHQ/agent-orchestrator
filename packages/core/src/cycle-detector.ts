/**
 * Cycle Detector — Loop/Cycle Detection Service
 *
 * Detects when agent sessions get stuck in repeating patterns:
 * 1. Same-status loops: session stays in "ci_failed" for N consecutive polls
 * 2. Multi-status cycles: "working → ci_failed → working → ci_failed" repeating
 *
 * Provides a rule-based AI judge that assesses whether a detected cycle
 * is productive (agent is making progress) or stuck (should be broken).
 *
 * This is a core lifecycle enhancement, not a plugin.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface CycleDetectorConfig {
  /** Max consecutive same-status polls before flagging (default: 5) */
  maxConsecutiveSameStatus?: number;
  /** Max cycle repetitions before flagging (default: 3) */
  maxCycleRepetitions?: number;
  /** Max history entries to keep per session (default: 50) */
  maxHistorySize?: number;
}

export interface CycleInfo {
  /** The repeating pattern, e.g. ["working", "ci_failed"] */
  pattern: string[];
  /** How many times the pattern has repeated */
  repetitions: number;
  /** When the cycle was first detected */
  detectedAt: Date;
}

export interface LoopInfo {
  /** The status that is repeating */
  status: string;
  /** How many consecutive times it's been seen */
  count: number;
  /** When the loop was first detected */
  detectedAt: Date;
}

export type CycleVerdict = "productive" | "stuck" | "uncertain";

export interface CycleJudgment {
  verdict: CycleVerdict;
  reason: string;
  recommendation: "continue" | "break" | "escalate";
  /** Suggested action if breaking the cycle */
  suggestedAction?: string;
}

export interface CycleDetector {
  /** Record a status transition for a session */
  recordTransition(sessionId: string, status: string): void;
  /** Check if a session is stuck in a loop (same status) */
  detectLoop(sessionId: string): LoopInfo | null;
  /** Check if a session is stuck in a cycle (multi-status pattern) */
  detectCycle(sessionId: string): CycleInfo | null;
  /** Get the status history for a session */
  getHistory(sessionId: string): string[];
  /** Generate an AI judge assessment (rule-based, no LLM needed) */
  judgeCycle(sessionId: string): CycleJudgment | null;
  /** Clear history for a session */
  clearSession(sessionId: string): void;
  /** Clear all state */
  clear(): void;
}

// =============================================================================
// DEFAULTS
// =============================================================================

const DEFAULT_MAX_CONSECUTIVE_SAME_STATUS = 5;
const DEFAULT_MAX_CYCLE_REPETITIONS = 3;
const DEFAULT_MAX_HISTORY_SIZE = 50;

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Find the shortest repeating cycle pattern in a status history.
 * Scans for patterns of length 2..floor(history.length/2) and returns
 * the shortest one that repeats at least `minRepetitions` times at
 * the tail of the history.
 */
function findCyclePattern(
  history: string[],
  minRepetitions: number,
): { pattern: string[]; repetitions: number } | null {
  const len = history.length;
  if (len < 2) return null;

  // Try pattern lengths from 2 up to half the history length
  const maxPatternLen = Math.floor(len / 2);

  for (let patternLen = 2; patternLen <= maxPatternLen; patternLen++) {
    // Extract the candidate pattern from the end of the history
    const candidate = history.slice(len - patternLen);

    // Check that the pattern actually contains different statuses
    // (a pattern of all the same status is a loop, not a cycle)
    const unique = new Set(candidate);
    if (unique.size < 2) continue;

    // Count how many times this pattern repeats going backwards
    let reps = 1;
    let pos = len - patternLen;

    while (pos >= patternLen) {
      const segment = history.slice(pos - patternLen, pos);
      if (segment.every((s, i) => s === candidate[i])) {
        reps++;
        pos -= patternLen;
      } else {
        break;
      }
    }

    if (reps >= minRepetitions) {
      return { pattern: candidate, repetitions: reps };
    }
  }

  return null;
}

/**
 * Rule-based AI judge: assess whether a cycle pattern is productive or stuck.
 */
function judgePattern(
  pattern: string[],
  repetitions: number,
  maxCycleRepetitions: number,
): CycleJudgment {
  const patternKey = pattern.join(" -> ");

  // spawning -> killed: always stuck (agent can't start)
  if (pattern.includes("spawning") && pattern.includes("killed")) {
    return {
      verdict: "stuck",
      reason: `Agent is repeatedly failing to start: ${patternKey}`,
      recommendation: "break",
      suggestedAction:
        "Check agent configuration, runtime availability, and workspace setup",
    };
  }

  // working -> ci_failed: productive if under threshold, stuck if over
  if (pattern.includes("working") && pattern.includes("ci_failed")) {
    if (repetitions < maxCycleRepetitions) {
      return {
        verdict: "productive",
        reason: `Agent is actively fixing CI failures (${repetitions} attempts so far): ${patternKey}`,
        recommendation: "continue",
      };
    }
    return {
      verdict: "stuck",
      reason: `Agent has failed to fix CI after ${repetitions} attempts: ${patternKey}`,
      recommendation: "break",
      suggestedAction:
        "Review CI logs manually; the agent may need human guidance on the failing tests",
    };
  }

  // working -> changes_requested: productive if under threshold, stuck if over
  if (pattern.includes("working") && pattern.includes("changes_requested")) {
    if (repetitions < maxCycleRepetitions) {
      return {
        verdict: "productive",
        reason: `Agent is addressing review feedback (${repetitions} rounds so far): ${patternKey}`,
        recommendation: "continue",
      };
    }
    return {
      verdict: "stuck",
      reason: `Agent has failed to satisfy reviewer after ${repetitions} rounds: ${patternKey}`,
      recommendation: "break",
      suggestedAction:
        "Review the PR comments; the reviewer and agent may be talking past each other",
    };
  }

  // Default: uncertain
  return {
    verdict: "uncertain",
    reason: `Detected repeating pattern (${repetitions} repetitions): ${patternKey}`,
    recommendation: "escalate",
    suggestedAction: "Human review recommended to determine if this cycle is productive",
  };
}

/**
 * Rule-based AI judge for same-status loops.
 */
function judgeLoop(status: string, count: number): CycleJudgment {
  // All same-status loops are considered stuck after hitting the threshold
  return {
    verdict: "stuck",
    reason: `Session has been in "${status}" for ${count} consecutive polls without transitioning`,
    recommendation: "break",
    suggestedAction: `Investigate why the session is stuck in "${status}" and consider restarting or sending new instructions`,
  };
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a CycleDetector instance.
 *
 * Uses closures (no classes) per project convention.
 */
export function createCycleDetector(config?: CycleDetectorConfig): CycleDetector {
  const maxConsecutive = config?.maxConsecutiveSameStatus ?? DEFAULT_MAX_CONSECUTIVE_SAME_STATUS;
  const maxCycleReps = config?.maxCycleRepetitions ?? DEFAULT_MAX_CYCLE_REPETITIONS;
  const maxHistory = config?.maxHistorySize ?? DEFAULT_MAX_HISTORY_SIZE;

  // Per-session state
  const histories = new Map<string, string[]>();
  const loopDetectedAt = new Map<string, Date>();
  const cycleDetectedAt = new Map<string, Date>();

  function getOrCreateHistory(sessionId: string): string[] {
    let history = histories.get(sessionId);
    if (!history) {
      history = [];
      histories.set(sessionId, history);
    }
    return history;
  }

  function recordTransition(sessionId: string, status: string): void {
    const history = getOrCreateHistory(sessionId);
    history.push(status);

    // Prune to maxHistorySize
    if (history.length > maxHistory) {
      const excess = history.length - maxHistory;
      history.splice(0, excess);
    }
  }

  function detectLoop(sessionId: string): LoopInfo | null {
    const history = histories.get(sessionId);
    if (!history || history.length < maxConsecutive) return null;

    // Check if the last N entries are all the same status
    const lastStatus = history[history.length - 1];
    let count = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i] === lastStatus) {
        count++;
      } else {
        break;
      }
    }

    if (count >= maxConsecutive) {
      // Track when we first detected this loop
      const key = sessionId;
      if (!loopDetectedAt.has(key)) {
        loopDetectedAt.set(key, new Date());
      }

      return {
        status: lastStatus,
        count,
        detectedAt: loopDetectedAt.get(key)!,
      };
    }

    // No loop — clear any stale detection timestamp
    loopDetectedAt.delete(sessionId);
    return null;
  }

  function detectCycle(sessionId: string): CycleInfo | null {
    const history = histories.get(sessionId);
    if (!history || history.length < 4) return null; // Need at least 2*2 entries for a 2-element pattern

    const result = findCyclePattern(history, maxCycleReps);
    if (!result) {
      cycleDetectedAt.delete(sessionId);
      return null;
    }

    if (!cycleDetectedAt.has(sessionId)) {
      cycleDetectedAt.set(sessionId, new Date());
    }

    return {
      pattern: result.pattern,
      repetitions: result.repetitions,
      detectedAt: cycleDetectedAt.get(sessionId)!,
    };
  }

  function getHistory(sessionId: string): string[] {
    return histories.get(sessionId)?.slice() ?? [];
  }

  function judgeCycle(sessionId: string): CycleJudgment | null {
    // Check for cycle first (more specific), then loop
    const cycle = detectCycle(sessionId);
    if (cycle) {
      return judgePattern(cycle.pattern, cycle.repetitions, maxCycleReps);
    }

    const loop = detectLoop(sessionId);
    if (loop) {
      return judgeLoop(loop.status, loop.count);
    }

    return null;
  }

  function clearSession(sessionId: string): void {
    histories.delete(sessionId);
    loopDetectedAt.delete(sessionId);
    cycleDetectedAt.delete(sessionId);
  }

  function clear(): void {
    histories.clear();
    loopDetectedAt.clear();
    cycleDetectedAt.clear();
  }

  return {
    recordTransition,
    detectLoop,
    detectCycle,
    getHistory,
    judgeCycle,
    clearSession,
    clear,
  };
}
