/**
 * GhClient — Centralized gatekeeper for all `gh` CLI interactions.
 *
 * Every GitHub API call in AO goes through this singleton so that
 * rate limits, concurrency, and error recovery are managed in one place.
 *
 * Components (applied in order):
 *   1. Request deduplication — coalesces identical in-flight requests
 *   2. Circuit breaker — fails fast when GitHub is rejecting us
 *   3. Concurrency semaphore — caps parallel `gh` processes to 20
 *   4. Exponential backoff with retry — retries transient errors
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  GhClientError,
  CircuitOpenError,
  RateLimitError,
  SemaphoreTimeoutError,
  GhCliError,
} from "./gh-client-errors.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 20;
const ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const CONSECUTIVE_FAILURE_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GhExecOptions {
  /** Working directory for the `gh` process. */
  cwd?: string;
  /** Timeout in milliseconds for `execFileAsync`. Defaults to 30 000. */
  timeout?: number;
  /** Skip retry logic (use for write operations to prevent double-execution). */
  noRetry?: boolean;
  /** Skip deduplication (use for write operations where each call must execute). */
  noDedup?: boolean;
}

type CircuitState = "closed" | "open" | "half-open";

export interface GhClientStats {
  calls: number;
  dedup: number;
  queued: number;
  retries: number;
  circuitState: CircuitState;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Classify an error message from the `gh` CLI. */
function isRateLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("http 429") ||
    lower.includes("rate limit") ||
    lower.includes("abuse detection") ||
    (lower.includes("http 403") &&
      (lower.includes("rate") || lower.includes("abuse")))
  );
}

function isRetryableError(message: string): boolean {
  // Rate limit errors are NOT retried — they should trip the circuit breaker
  // immediately rather than consuming quota with retry attempts (F-11).
  if (isRateLimitError(message)) return false;

  const lower = message.toLowerCase();
  return (
    lower.includes("http 502") ||
    lower.includes("http 503") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("socket hang up")
  );
}

function isNonRetryableError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("http 401") ||
    lower.includes("http 404") ||
    lower.includes("http 422") ||
    lower.includes("not logged in") ||
    lower.includes("authentication")
  );
}

/** Try to extract Retry-After seconds from an error message. */
function parseRetryAfter(message: string): number | undefined {
  // gh CLI sometimes includes "Retry-After: <seconds>" in stderr
  const match = message.match(/retry-after:\s*(\d+)/i);
  if (match) return parseInt(match[1], 10);
  return undefined;
}

function getErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  const withIo = err as Error & { stderr?: string };
  if (typeof withIo.stderr === "string") parts.push(withIo.stderr);
  return parts.join("\n");
}

function getExitCode(err: unknown): number | undefined {
  const e = err as Record<string, unknown>;
  if (typeof e["code"] === "number") return e["code"];
  if (typeof e["exitCode"] === "number") return e["exitCode"];
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// GhClient
// ---------------------------------------------------------------------------

export class GhClient {
  // -- Dedup --
  private readonly inflight = new Map<string, Promise<string>>();

  // -- Semaphore --
  private running = 0;
  private readonly queue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  // -- Circuit breaker --
  private circuitState: CircuitState = "closed";
  private reopenAt = 0;
  private consecutiveFailures = 0;
  private halfOpenProbeInFlight = false;

  // -- Stats --
  private stats: GhClientStats = {
    calls: 0,
    dedup: 0,
    queued: 0,
    retries: 0,
    circuitState: "closed",
  };

  /**
   * Execute a `gh` CLI command through all protection layers.
   * Returns trimmed stdout on success.
   */
  async exec(args: string[], opts?: GhExecOptions): Promise<string> {
    this.stats.calls++;

    // 1. Dedup
    if (!opts?.noDedup) {
      const key = JSON.stringify([args, opts?.cwd ?? ""]);
      const existing = this.inflight.get(key);
      if (existing) {
        this.stats.dedup++;
        return existing;
      }
      const promise = this._protectedExec(args, opts).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, promise);
      return promise;
    }

    return this._protectedExec(args, opts);
  }

  /** Get current stats snapshot. */
  getStats(): GhClientStats {
    return { ...this.stats, circuitState: this.circuitState };
  }

  /** Reset stats counters (call between poll cycles). */
  resetStats(): void {
    this.stats = {
      calls: 0,
      dedup: 0,
      queued: 0,
      retries: 0,
      circuitState: this.circuitState,
    };
  }

  /** Graceful shutdown: trip circuit, reject queued waiters. */
  shutdown(): void {
    this.circuitState = "open";
    this.reopenAt = Infinity;

    // Reject all queued semaphore waiters
    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      entry.reject(new SemaphoreTimeoutError());
    }
    this.queue.length = 0;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async _protectedExec(
    args: string[],
    opts?: GhExecOptions,
  ): Promise<string> {
    // 2. Circuit breaker check
    this._checkCircuit();

    // 3 + 4. Retry loop with per-attempt semaphore acquisition.
    // The semaphore is released before backoff sleep so sleeping retries
    // don't block concurrency slots for other requests.
    return this._retryExec(args, opts);
  }

  // -- Circuit breaker --

  private _checkCircuit(): void {
    if (this.circuitState === "closed") return;

    if (this.circuitState === "open") {
      if (Date.now() >= this.reopenAt) {
        // Transition to half-open: allow exactly one probe request
        this.circuitState = "half-open";
        this.halfOpenProbeInFlight = true;
        // eslint-disable-next-line no-console
        console.warn("[GhClient] circuit half-open — probing");
        return;
      }
      throw new CircuitOpenError(this.reopenAt);
    }

    // half-open: only the single probe is allowed through; reject others
    if (this.halfOpenProbeInFlight) {
      throw new CircuitOpenError(this.reopenAt);
    }
  }

  private _recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.circuitState === "half-open") {
      this.circuitState = "closed";
      this.halfOpenProbeInFlight = false;
      // eslint-disable-next-line no-console
      console.info("[GhClient] circuit recovered — closed");
    }
  }

  private _recordFailure(err: unknown): void {
    this.consecutiveFailures++;
    const msg = getErrorMessage(err);

    if (this.circuitState === "half-open") {
      // Probe failed — back to open
      this.halfOpenProbeInFlight = false;
      const cooldown = this._cooldownMs(msg);
      this._tripCircuit(cooldown);
      // eslint-disable-next-line no-console
      console.warn(`[GhClient] circuit probe failed — open for ${cooldown}ms`);
      return;
    }

    const isRL = isRateLimitError(msg);
    if (
      isRL ||
      this.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD
    ) {
      const cooldown = this._cooldownMs(msg);
      this._tripCircuit(cooldown);
      const reason = isRL ? "rate limit" : `${this.consecutiveFailures} consecutive failures`;
      // eslint-disable-next-line no-console
      console.warn(`[GhClient] circuit tripped (${reason}) — open for ${cooldown}ms`);
    }
  }

  private _tripCircuit(cooldownMs: number): void {
    this.circuitState = "open";
    this.reopenAt = Date.now() + cooldownMs;
    this.consecutiveFailures = 0;
  }

  private _cooldownMs(errorMsg: string): number {
    const retryAfter = parseRetryAfter(errorMsg);
    if (retryAfter !== undefined && retryAfter > 0) {
      return retryAfter * 1000;
    }
    return DEFAULT_COOLDOWN_MS;
  }

  // -- Semaphore --

  private async _acquireSemaphore(): Promise<void> {
    if (this.running < MAX_CONCURRENT) {
      this.running++;
      return;
    }

    this.stats.queued++;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new SemaphoreTimeoutError());
      }, ACQUIRE_TIMEOUT_MS);

      this.queue.push({ resolve, reject, timer });
    });
  }

  private _releaseSemaphore(): void {
    if (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      clearTimeout(entry.timer);
      // Don't decrement running — transfer the slot to the waiter
      entry.resolve();
    } else {
      this.running--;
    }
  }

  // -- Retry --

  private async _retryExec(
    args: string[],
    opts?: GhExecOptions,
  ): Promise<string> {
    const maxAttempts = opts?.noRetry ? 1 : MAX_RETRIES + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Acquire semaphore per attempt so backoff sleep doesn't hold a slot
      await this._acquireSemaphore();
      try {
        const result = await this._rawExec(args, opts);
        this._recordSuccess();
        return result;
      } catch (err) {
        this._recordFailure(err);
        const msg = getErrorMessage(err);

        // Last attempt or non-retryable — throw
        if (attempt === maxAttempts - 1 || isNonRetryableError(msg)) {
          throw this._wrapError(err);
        }

        if (!isRetryableError(msg)) {
          throw this._wrapError(err);
        }

        // Backoff — semaphore is released, slot is free for other requests
        const retryAfter = parseRetryAfter(msg);
        const baseDelay = retryAfter
          ? retryAfter * 1000
          : BASE_DELAY_MS * Math.pow(2, attempt);
        const jitter = Math.random() * baseDelay * 0.3;
        this.stats.retries++;

        await sleep(baseDelay + jitter);
      } finally {
        this._releaseSemaphore();
      }
    }

    // Should never reach here
    throw new GhClientError("Retry loop exhausted unexpectedly");
  }

  private async _rawExec(
    args: string[],
    opts?: GhExecOptions,
  ): Promise<string> {
    const { stdout } = await execFileAsync("gh", args, {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      maxBuffer: 10 * 1024 * 1024,
      timeout: opts?.timeout ?? 30_000,
    });
    return stdout.trim();
  }

  private _wrapError(err: unknown): GhClientError {
    if (err instanceof GhClientError) return err;

    const msg = getErrorMessage(err);

    if (isRateLimitError(msg)) {
      return new RateLimitError(msg, parseRetryAfter(msg), err);
    }

    return new GhCliError(
      `gh ${msg.slice(0, 200)}`,
      {
        exitCode: getExitCode(err),
        stderr: (err as Record<string, unknown>)["stderr"] as string | undefined ?? "",
        cause: err,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: GhClient | null = null;

/**
 * Get the GhClient singleton. Creates one on first call.
 */
export function getGhClient(): GhClient {
  if (!instance) {
    instance = new GhClient();
  }
  return instance;
}

/**
 * Initialize the GhClient singleton and verify `gh` CLI availability.
 * Call once at startup before polling begins.
 */
export async function initGhClient(): Promise<GhClient> {
  const client = getGhClient();

  // Verify gh CLI is available
  try {
    await client.exec(["--version"], { noRetry: true, noDedup: true });
  } catch (err) {
    throw new GhClientError(
      "gh CLI not available or not authenticated. Install gh and run `gh auth login`.",
      { cause: err },
    );
  }

  return client;
}

/**
 * Reset the singleton (for testing only).
 */
export function resetGhClient(): void {
  if (instance) {
    instance.shutdown();
  }
  instance = null;
}
