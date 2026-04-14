/**
 * GhClient error hierarchy.
 *
 * Structured error types so callers can distinguish failure modes
 * (circuit open, rate limit, semaphore timeout, CLI error) without
 * parsing error message strings.
 */

/**
 * Base error for all GhClient failures.
 * Callers can `instanceof GhClientError` to catch any GhClient-originated error.
 */
export class GhClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GhClientError";
  }
}

/**
 * Thrown when the circuit breaker is OPEN and rejects the call without
 * spawning a `gh` process. Callers should degrade gracefully (e.g. keep
 * the session's current status).
 */
export class CircuitOpenError extends GhClientError {
  /** Epoch ms when the circuit will transition to HALF-OPEN. */
  readonly reopenAt: number;

  constructor(reopenAt: number) {
    const waitSec = Math.max(0, Math.ceil((reopenAt - Date.now()) / 1000));
    super(`Circuit breaker is open — retry in ~${waitSec}s`);
    this.name = "CircuitOpenError";
    this.reopenAt = reopenAt;
  }
}

/**
 * Thrown when GitHub returns a rate-limit response (HTTP 429, or 403 with
 * "abuse detection" / "rate limit" in the body).
 */
export class RateLimitError extends GhClientError {
  /** Seconds until the rate limit resets, if parseable from the response. */
  readonly retryAfterSec: number | undefined;

  constructor(message: string, retryAfterSec?: number, cause?: unknown) {
    super(message, { cause });
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Thrown when a request times out waiting for a concurrency slot.
 */
export class SemaphoreTimeoutError extends GhClientError {
  constructor() {
    super("Timed out waiting for a gh concurrency slot");
    this.name = "SemaphoreTimeoutError";
  }
}

/**
 * Wraps all other `gh` CLI execution failures.
 * Carries structured fields so callers can branch without string parsing.
 */
export class GhCliError extends GhClientError {
  readonly exitCode: number | undefined;
  readonly stderr: string;
  /** True when the error indicates an authentication problem (HTTP 401). */
  readonly isAuth: boolean;
  /** True when the resource was not found (HTTP 404). */
  readonly isNotFound: boolean;

  constructor(
    message: string,
    opts: {
      exitCode?: number;
      stderr?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "GhCliError";
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr ?? "";

    const lower = `${message} ${this.stderr}`.toLowerCase();
    this.isAuth = lower.includes("401") || lower.includes("authentication") || lower.includes("not logged in");
    this.isNotFound = lower.includes("404") || lower.includes("not found");
  }
}
