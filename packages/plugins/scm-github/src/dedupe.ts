/**
 * Request deduplication for GitHub CLI calls.
 *
 * Shares concurrent identical requests to reduce API calls.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Deduplication key for a gh command */
function key(args: string[]): string {
  // Use JSON.stringify to avoid key collisions when args contain ":"
  // e.g., ["a:b", "c"] and ["a", "b:c"] would both become "a:b:c" with join(":")
  return `gh:${JSON.stringify(args)}`;
}

/**
 * Deduplicates concurrent identical requests.
 *
 * When multiple calls are made for the same gh command simultaneously,
 * only one actual API call is made and the result is shared.
 */
export class RequestDeduplicator {
  private pendingRequests = new Map<string, Promise<unknown>>();

  async dedupe<T>(args: string[], fn: () => Promise<T>): Promise<T> {
    const dedupeKey = key(args);
    const existing = this.pendingRequests.get(dedupeKey);
    if (existing) return existing as Promise<T>;

    const promise = fn()
      .finally(() => this.pendingRequests.delete(dedupeKey));
    this.pendingRequests.set(dedupeKey, promise);
    return promise;
  }
}

/** Global deduplicator for gh CLI calls */
export const ghDeduplicator = new RequestDeduplicator();

/**
 * Execute gh CLI with request deduplication.
 *
 * This wrapper ensures that concurrent calls for identical gh commands
 * share a single API call instead of making duplicate requests.
 */
export async function dedupeGh(args: string[]): Promise<string> {
  return ghDeduplicator.dedupe(args, async () => {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  });
}
