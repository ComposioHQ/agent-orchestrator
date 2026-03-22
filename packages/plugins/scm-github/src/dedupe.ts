/**
 * Request deduplication for gh CLI calls.
 *
 * When multiple concurrent requests are made for the same gh CLI command,
 * only the first request executes the command. Subsequent requests share
 * the same Promise result.
 *
 * This reduces GitHub API usage by eliminating duplicate concurrent calls.
 */

export class RequestDeduplicator {
  private pendingRequests = new Map<string, Promise<unknown>>();

  /**
   * Generate a unique key from gh CLI arguments.
   */
  key(args: string[]): string {
    return `gh:${args.join(":")}`;
  }

  /**
   * Deduplicate concurrent requests for the same command.
   *
   * If a request is already in progress for the same key,
   * return the existing Promise. Otherwise, execute the function
   * and store the Promise.
   *
   * @param key - Key generated from CLI arguments
   * @param fn - Function that performs the API call
   * @returns Result from the first execution, shared by all callers
   *
   * @example
   * // 5 agents request PR #123 simultaneously
   * // Only 1 gh CLI call is made, all 5 get the same result
   * await deduper.dedupe("gh:pr:view:123", () => gh(["pr", "view", "123"]))
   */
  async dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pendingRequests.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = fn().finally(() => this.pendingRequests.delete(key));
    this.pendingRequests.set(key, promise);
    return promise;
  }

  /**
   * Get statistics for monitoring.
   */
  getStats() {
    return {
      pending: this.pendingRequests.size,
    };
  }

  /**
   * Clear all pending requests (useful for testing).
   */
  clear(): void {
    this.pendingRequests.clear();
  }
}

/** Global deduplicator instance */
export const ghDeduplicator = new RequestDeduplicator();
