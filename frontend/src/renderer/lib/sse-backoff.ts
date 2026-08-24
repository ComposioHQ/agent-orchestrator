// Reconnect backoff for the workspace-file-events SSE stream.
//
// Previously the stream retried on a fixed 5s interval with no backoff, no
// ceiling, and no reset — so a session whose stream keeps failing (e.g. the
// daemon is momentarily returning 5xx during DB contention) reconnected every
// 5s forever, and many such streams hit the daemon in lockstep. Exponential
// backoff with jitter spreads and slows those reconnects; the caller resets the
// failure count on a successful open so a healthy stream returns to a fast
// first retry.
//
// Kept dependency-free so it is trivially unit-testable in isolation.

export const SSE_RETRY_BASE_MS = 5_000;
export const SSE_RETRY_MAX_MS = 60_000;

/**
 * Delay before the next reconnect attempt, given how many consecutive failures
 * have occurred (0 for the first retry). Grows exponentially from
 * `baseMs` to a `maxMs` ceiling, with jitter in [0.5, 1.0] of the computed step
 * so concurrent streams do not reconnect in a thundering herd.
 *
 * `rand` is injectable for deterministic tests; defaults to Math.random.
 */
export function computeBackoffDelayMs(
	failures: number,
	baseMs: number = SSE_RETRY_BASE_MS,
	maxMs: number = SSE_RETRY_MAX_MS,
	rand: () => number = Math.random,
): number {
	const safeFailures = Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0;
	// Cap the exponent so 2 ** n cannot overflow before the min() clamps it.
	const exponent = Math.min(safeFailures, 30);
	const step = Math.min(baseMs * 2 ** exponent, maxMs);
	const jitter = 0.5 + rand() * 0.5;
	return Math.round(step * jitter);
}
