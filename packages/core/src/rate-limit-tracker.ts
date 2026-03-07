/**
 * Rate Limit Tracker — Core Lifecycle Enhancement
 *
 * Tracks rate-limited agent executables with reset timestamps,
 * auto-expires stale entries, walks fallback chains to find available
 * executables, and detects rate limits from agent output via regex patterns.
 */

// =============================================================================
// Types
// =============================================================================

export interface RateLimitEntry {
  executable: string;
  rateLimitedAt: Date;
  resetAt: Date;
  reason: string;
}

export interface RateLimitTrackerConfig {
  /** Minimum floor for reset times (default: 15 min) */
  minResetFloorMs?: number;
  /** Fallback chains: map from executable to ordered alternatives */
  fallbackChains?: Record<string, string[]>;
  /** Rapid exit threshold in milliseconds (default: 10 seconds) */
  rapidExitThresholdMs?: number;
}

export interface RateLimitDetection {
  detected: boolean;
  resetAt?: Date;
  reason?: string;
}

export interface RateLimitTracker {
  /** Record a rate limit for an executable */
  recordRateLimit(executable: string, resetAt: Date, reason: string): void;
  /** Check if an executable is currently rate limited */
  isRateLimited(executable: string): boolean;
  /** Get the best available executable, walking fallback chain */
  getAvailableExecutable(preferred: string): string;
  /** Detect rate limit from agent output text */
  detectFromOutput(output: string): RateLimitDetection;
  /** Detect rate limit from rapid session exit */
  detectRapidExit(sessionStartTime: Date, sessionEndTime: Date): boolean;
  /** Get all current rate limit entries */
  getEntries(): RateLimitEntry[];
  /** Clear expired entries */
  pruneExpired(): void;
  /** Clear all entries */
  clear(): void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MIN_RESET_FLOOR_MS = 15 * 60 * 1_000; // 15 minutes
const DEFAULT_RAPID_EXIT_THRESHOLD_MS = 10 * 1_000; // 10 seconds

// =============================================================================
// Rate limit detection patterns
// =============================================================================

/**
 * Patterns that indicate a rate limit was hit.
 * Tested against lowercased output.
 */
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[_\s-]?limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota exceeded/i,
  /\bthrottled\b/i,
];

/**
 * Patterns that extract a reset duration from output.
 * Capture group 1 = numeric value, capture group 2 = unit.
 */
const RESET_TIME_PATTERNS: RegExp[] = [
  /try again in\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i,
  /retry after\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i,
  /wait\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i,
  /resets?\s+in\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i,
];

/**
 * Pattern that extracts an absolute reset timestamp from output.
 * Matches ISO 8601-like date strings: "resets at 2024-01-15T10:30:00"
 */
const ABSOLUTE_RESET_PATTERN =
  /resets?\s+at\s+(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?(?:[.\d]*Z?)?)/i;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse a time unit string into milliseconds.
 */
function unitToMs(unit: string): number {
  const lower = unit.toLowerCase();
  if (lower.startsWith("sec")) return 1_000;
  if (lower.startsWith("min")) return 60 * 1_000;
  if (lower.startsWith("hour") || lower.startsWith("hr")) return 60 * 60 * 1_000;
  return 60 * 1_000; // default to minutes
}

/**
 * Try to extract a reset time from output text.
 * Returns a Date if found, undefined otherwise.
 */
function extractResetTime(output: string): Date | undefined {
  // Try absolute timestamp first
  const absoluteMatch = ABSOLUTE_RESET_PATTERN.exec(output);
  if (absoluteMatch) {
    const parsed = new Date(absoluteMatch[1]);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  // Try relative duration patterns
  for (const pattern of RESET_TIME_PATTERNS) {
    const match = pattern.exec(output);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      if (!Number.isNaN(value) && value > 0) {
        return new Date(Date.now() + value * unitToMs(unit));
      }
    }
  }

  return undefined;
}

/**
 * Build a human-readable reason from the matched pattern.
 */
function extractReason(output: string): string {
  // Try to find the most specific matching line
  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    for (const pattern of RATE_LIMIT_PATTERNS) {
      if (pattern.test(trimmed)) {
        // Return first 200 chars of the matching line
        return trimmed.length > 200 ? trimmed.slice(0, 200) + "..." : trimmed;
      }
    }
  }
  return "Rate limit detected";
}

// =============================================================================
// Factory
// =============================================================================

export function createRateLimitTracker(
  config?: RateLimitTrackerConfig,
): RateLimitTracker {
  const minResetFloorMs = config?.minResetFloorMs ?? DEFAULT_MIN_RESET_FLOOR_MS;
  const fallbackChains = config?.fallbackChains ?? {};
  const rapidExitThresholdMs =
    config?.rapidExitThresholdMs ?? DEFAULT_RAPID_EXIT_THRESHOLD_MS;

  /** Map from executable name to its rate limit entry */
  const entries = new Map<string, RateLimitEntry>();

  /**
   * Enforce minimum reset floor: if the provided resetAt is too soon,
   * push it out to at least minResetFloorMs from now.
   */
  function enforceFloor(resetAt: Date): Date {
    const floor = new Date(Date.now() + minResetFloorMs);
    return resetAt.getTime() < floor.getTime() ? floor : resetAt;
  }

  function recordRateLimit(
    executable: string,
    resetAt: Date,
    reason: string,
  ): void {
    entries.set(executable, {
      executable,
      rateLimitedAt: new Date(),
      resetAt: enforceFloor(resetAt),
      reason,
    });
  }

  function isRateLimited(executable: string): boolean {
    const entry = entries.get(executable);
    if (!entry) return false;

    // Auto-expire if reset time has passed
    if (entry.resetAt.getTime() <= Date.now()) {
      entries.delete(executable);
      return false;
    }

    return true;
  }

  function getAvailableExecutable(preferred: string): string {
    // If the preferred executable is not rate limited, use it
    if (!isRateLimited(preferred)) {
      return preferred;
    }

    // Walk the fallback chain
    const chain = fallbackChains[preferred];
    if (chain) {
      for (const alt of chain) {
        if (!isRateLimited(alt)) {
          return alt;
        }
      }
    }

    // All alternatives are rate limited (or no chain configured).
    // Return the preferred executable anyway — caller can decide what to do.
    return preferred;
  }

  function detectFromOutput(output: string): RateLimitDetection {
    for (const pattern of RATE_LIMIT_PATTERNS) {
      if (pattern.test(output)) {
        const resetAt = extractResetTime(output);
        const reason = extractReason(output);
        return {
          detected: true,
          resetAt,
          reason,
        };
      }
    }

    return { detected: false };
  }

  function detectRapidExit(
    sessionStartTime: Date,
    sessionEndTime: Date,
  ): boolean {
    const durationMs =
      sessionEndTime.getTime() - sessionStartTime.getTime();
    return durationMs >= 0 && durationMs < rapidExitThresholdMs;
  }

  function getEntries(): RateLimitEntry[] {
    return Array.from(entries.values());
  }

  function pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.resetAt.getTime() <= now) {
        entries.delete(key);
      }
    }
  }

  function clear(): void {
    entries.clear();
  }

  return {
    recordRateLimit,
    isRateLimited,
    getAvailableExecutable,
    detectFromOutput,
    detectRapidExit,
    getEntries,
    pruneExpired,
    clear,
  };
}
