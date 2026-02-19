/**
 * Simple in-memory TTL cache for SCM API data.
 *
 * Reduces GitHub API rate limit exhaustion by caching PR enrichment data.
 * Default TTL: 60 seconds (data is fresh enough for dashboard refresh).
 */

interface CacheEntry<T> {
  value: T;
  cachedAt: number; // timestamp when cached (for age calculation)
  expiresAt: number; // timestamp when expires
}

/** Cache entry with metadata (age, staleness) */
export interface CachedValue<T> {
  value: T;
  cachedAt: Date;
  ageMs: number; // milliseconds since cached
  ttlMs: number; // total TTL
  stale: boolean; // whether nearing expiry (>75% of TTL)
}

const DEFAULT_TTL_MS = 60_000; // 60 seconds

/**
 * Simple TTL cache backed by a Map.
 * Automatically evicts stale entries on get() and periodically cleans up.
 */
export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    // Run cleanup every TTL period to prevent memory leaks from unread keys
    this.cleanupInterval = setInterval(() => this.evictExpired(), ttlMs);
    // Ensure cleanup interval doesn't prevent Node process from exiting
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /** Get a cached value if it exists and isn't expired (backwards compatible) */
  get(key: string): T | null {
    const cached = this.getWithMetadata(key);
    return cached ? cached.value : null;
  }

  /**
   * Get a cached value with metadata (age, staleness, TTL).
   * Returns null if not found or expired.
   */
  getWithMetadata(key: string): CachedValue<T> | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();

    // Evict if expired
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    const ageMs = now - entry.cachedAt;
    const stale = ageMs > this.ttlMs * 0.75; // consider stale if >75% of TTL

    return {
      value: entry.value,
      cachedAt: new Date(entry.cachedAt),
      ageMs,
      ttlMs: this.ttlMs,
      stale,
    };
  }

  /** Set a cache entry with TTL */
  set(key: string, value: T): void {
    const now = Date.now();
    this.cache.set(key, {
      value,
      cachedAt: now,
      expiresAt: now + this.ttlMs,
    });
  }

  /** Evict all expired entries */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear all entries and stop cleanup interval */
  clear(): void {
    this.cache.clear();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
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
