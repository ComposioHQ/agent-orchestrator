/**
 * Simple in-memory TTL cache for SCM API data.
 *
 * Reduces GitHub API rate limit exhaustion by caching PR enrichment data.
 * Default TTL: 60 seconds (data is fresh enough for dashboard refresh).
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000; // 60 seconds

/**
 * Simple TTL cache backed by a Map.
 * Automatically evicts stale entries on get().
 */
export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Get a cached value if it exists and isn't stale */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  /** Set a cache entry with TTL */
  set(key: string, value: T): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Clear all entries */
  clear(): void {
    this.cache.clear();
  }

  /** Get cache size (includes stale entries) */
  size(): number {
    return this.cache.size;
  }
}

/**
 * Enrichment data for a single PR.
 * Cached by PR number (key: `owner/repo#123`).
 */
export interface PREnrichmentData {
  state: "open" | "merged" | "closed";
  title: string;
  additions: number;
  deletions: number;
  ciStatus: string;
  ciChecks: Array<{ name: string; status: string; url?: string }>;
  reviewDecision: string;
  mergeability: {
    mergeable: boolean;
    ciPassing: boolean;
    approved: boolean;
    noConflicts: boolean;
    blockers: string[];
  };
  unresolvedThreads: number;
  unresolvedComments: Array<{
    url: string;
    path: string;
    author: string;
    body: string;
  }>;
}

/** Global PR enrichment cache (60s TTL) */
export const prCache = new TTLCache<PREnrichmentData>();

/** Generate cache key for a PR: `owner/repo#123` */
export function prCacheKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}
