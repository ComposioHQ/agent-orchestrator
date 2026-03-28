/**
 * REST API Parallel PR Enrichment with 2-Guard ETag Strategy
 *
 * Uses two ETag guards to detect when data needs refreshing:
 * 1. PR List ETag (per repo) - Detects PR metadata changes
 * 2. Commit Status ETag (per PR) - Detects CI status changes
 *
 * This reduces GitHub API calls from N×6 to ~N×2 per polling cycle.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CI_STATUS,
  type PREnrichmentData,
  type PRInfo,
  type PRState,
  type CICheck,
  type CIStatus,
  type ReviewDecision,
  type MergeReadiness,
  type BatchObserver,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

// =============================================================================
// CONSTANTS
// =============================================================================

const PARALLEL_CONCURRENCY = 10;
const PR_METADATA_CACHE_SIZE = 100;
const ENRICHMENT_CACHE_SIZE = 200;

// =============================================================================
// LRU CACHE
// =============================================================================

/**
 * Simple LRU (Least Recently Used) cache implementation.
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | null {
    const value = this.cache.get(key);
    if (!value) return null;
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// =============================================================================
// ETag CACHE
// =============================================================================

interface ETagEntry {
  etag: string;
  timestamp: number;
}

/**
 * ETag-based cache with TTL (time-to-live) expiration.
 */
class ETagCache {
  private cache = new Map<string, ETagEntry>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number = 30_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    // Check if expired
    if (Date.now() - entry.timestamp > this.defaultTtlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.etag;
  }

  set(key: string, etag: string): void {
    this.cache.set(key, {
      etag,
      timestamp: Date.now(),
    });
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidateRepo(owner: string, repo: string): void {
    // Keys are in format: "type:owner/repo" or "type:owner/repo/number"
    // So we need to match "owner/repo" after the type prefix
    const repoPath = `${owner}/${repo}`;
    // Collect keys to delete first to avoid issues with modifying Map during iteration
    const keysToDelete: string[] = [];
    for (const cacheKey of this.cache.keys()) {
      if (cacheKey.includes(repoPath)) {
        keysToDelete.push(cacheKey);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }
}

// =============================================================================
// BATCH OBSERVER
// =============================================================================

/**
 * BatchObserver implementation with logging support.
 */
export class BatchObserverImpl implements BatchObserver {
  private readonly prefix: string;
  private readonly logs: string[] = [];

  constructor(prefix: string = "rest-parallel") {
    this.prefix = prefix;
  }

  recordSuccess(operation: string, durationMs: number, details?: Record<string, unknown>): void {
    const detailsStr = details ? ` ${JSON.stringify(details)}` : "";
    const logMsg = `[OK] ${operation} (${durationMs}ms)${detailsStr}`;
    this.logs.push(logMsg);
    console.log(logMsg);
  }

  recordFailure(operation: string, error: Error, durationMs: number, details?: Record<string, unknown>): void {
    const detailsStr = details ? ` ${JSON.stringify(details)}` : "";
    const logMsg = `[ERR] ${operation} failed: ${error.message} (${durationMs}ms)${detailsStr}`;
    this.logs.push(logMsg);
    console.error(logMsg);
  }

  log(message: string, details?: Record<string, unknown>): void {
    const detailsStr = details ? ` ${JSON.stringify(details)}` : "";
    const logMsg = `[${this.prefix}] ${message}${detailsStr}`;
    this.logs.push(logMsg);
    console.log(logMsg);
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  clear(): void {
    this.logs.length = 0;
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${error.message}`, {
      cause: err,
    });
  }
}

function prCacheKey(pr: PRInfo): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

// =============================================================================
// ETag GUARDS
// =============================================================================

/**
 * Guard 1: PR List ETag Check (per repo)
 * Detects PR metadata changes by comparing ETag.
 */
async function checkPRListETag(
  owner: string,
  repo: string,
  etagCache: ETagCache,
): Promise<boolean> {
  const etagKey = `pr-list:${owner}/${repo}`;
  const currentEtag = etagCache.get(etagKey);

  const args = ["api", "--method", "HEAD", `repos/${owner}/${repo}/pulls?state=open&per_page=1`];
  if (currentEtag) {
    args.push("-H", `"If-None-Match: "${currentEtag}"`);
  }

  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 1024,
      timeout: 30_000,
    });

    // Parse ETag from response headers
    const etagMatch = stdout.match(/ETag:\s*"([^"]+)"/i);
    const newEtag = etagMatch ? etagMatch[1] : undefined;

    if (newEtag) {
      etagCache.set(etagKey, newEtag);
    }

    // Check if 304 Not Modified
    if (stdout.includes("304") || stdout.includes("Not Modified")) {
      return false;
    }

    // If we got a different ETag, data changed
    return newEtag !== currentEtag;
  } catch {
    return true;
  }
}

/**
 * Guard 2: Commit Status ETag Check (per PR)
 * Detects CI status changes by comparing ETag.
 */
async function checkCommitStatusETag(pr: PRInfo, etagCache: ETagCache): Promise<boolean> {
  const etagKey = `commit-status:${pr.owner}/${pr.repo}/${pr.number}`;
  const currentEtag = etagCache.get(etagKey);

  const args = [
    "api",
    "--method",
    "HEAD",
    `repos/${pr.owner}/${pr.repo}/commits/${pr.headRefOid || "HEAD"}/status`,
  ];
  if (currentEtag) {
    args.push("-H", `"If-None-Match: "${currentEtag}"`);
  }

  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 1024,
      timeout: 30_000,
    });

    // Parse ETag from response headers
    const etagMatch = stdout.match(/ETag:\s*"([^"]+)"/i);
    const newEtag = etagMatch ? etagMatch[1] : undefined;

    if (newEtag) {
      etagCache.set(etagKey, newEtag);
    }

    // Check if 304 Not Modified
    if (stdout.includes("304") || stdout.includes("Not Modified")) {
      return false;
    }

    // If we got a different ETag, data changed
    return newEtag !== currentEtag;
  } catch {
    return true;
  }
}

/**
 * Check if PR enrichment should be refreshed using the 2-Guard strategy.
 * Returns true if either guard indicates data has changed.
 */
export async function shouldRefreshPREnrichment(
  pr: PRInfo,
  etagCache: ETagCache,
  observer?: BatchObserver,
): Promise<boolean> {
  // Guard 1: Check PR list ETag
  const prListChanged = await checkPRListETag(pr.owner, pr.repo, etagCache);
  if (prListChanged) {
    observer?.log(`PR list ETag changed for ${pr.owner}/${pr.repo}`);
    return true;
  }

  // Guard 2: Check commit status ETag
  const commitStatusChanged = await checkCommitStatusETag(pr, etagCache);
  if (commitStatusChanged) {
    observer?.log(`Commit status ETag changed for ${pr.owner}/${pr.repo}/${pr.number}`);
    return true;
  }

  return false;
}

// =============================================================================
// DATA FETCHING
// =============================================================================

interface PRData {
  state: PRState;
  title: string;
  additions: number;
  deletions: number;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  headRefOid: string;
}

/**
 * Fetch PR data from REST API
 */
export async function fetchPRData(pr: PRInfo, observer?: BatchObserver): Promise<PRData> {
  const startedAt = Date.now();
  try {
    const raw = await gh([
      "pr",
      "view",
      String(pr.number),
      "--repo",
      `${pr.owner}/${pr.repo}`,
      "--json",
      "state,title,additions,deletions,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid",
    ]);
    observer?.recordSuccess("fetchPRData", Date.now() - startedAt);
    const data = JSON.parse(raw);
    return data;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    observer?.recordFailure("fetchPRData", error, Date.now() - startedAt);
    throw error;
  }
}

/**
 * Map raw check state to our CICheck status
 */
function mapCheckStateToStatus(rawState: string | undefined): CICheck["status"] {
  const s = (rawState ?? "").toUpperCase();
  if (s === "IN_PROGRESS") return "running";
  if (s === "COMPLETED" || s === "SUCCESS") return "passed";
  if (s === "PENDING" || s === "QUEUED") return "pending";
  if (s === "FAILURE" || s === "ERROR" || s === "TIMED_OUT") return "failed";
  return "skipped";
}

interface CIData {
  checks: CICheck[];
  summary: CIStatus;
}

/**
 * Fetch CI status from REST API
 */
export async function fetchCIData(pr: PRInfo, observer?: BatchObserver): Promise<CIData> {
  const startedAt = Date.now();
  try {
    const raw = await gh([
      "api",
      `repos/${pr.owner}/${pr.repo}/commits/${pr.headRefOid || "HEAD"}/status`,
    ]);
    observer?.recordSuccess("fetchCIData", Date.now() - startedAt);

    const statusData = JSON.parse(raw);
    let checks: CICheck[] = [];

    if (statusData?.statuses && Array.isArray(statusData.statuses)) {
      checks = statusData.statuses.map((s: Record<string, unknown>) => ({
        name: typeof s.context === "string" ? s.context : "unknown",
        status: mapCheckStateToStatus(typeof s.state === "string" ? s.state : undefined),
        conclusion: typeof s.state === "string" ? s.state.toUpperCase() : undefined,
        url: typeof s.target_url === "string" ? s.target_url : undefined,
        startedAt: typeof s.created_at === "string" ? new Date(s.created_at) : undefined,
        completedAt: typeof s.updated_at === "string" ? new Date(s.updated_at) : undefined,
      }));
    }

    const summary = computeCISummary(checks);
    return { checks, summary };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    observer?.recordFailure("fetchCIData", error, Date.now() - startedAt);
    throw error;
  }
}

/**
 * Compute CI summary from checks
 */
function computeCISummary(checks: CICheck[]): CIStatus {
  if (checks.length === 0) return "none";

  const hasFailing = checks.some((c) => c.status === "failed");
  if (hasFailing) return "failing";

  const hasPending = checks.some((c) => c.status === "running" || c.status === "pending");
  if (hasPending) return "pending";

  const hasPassing = checks.some((c) => c.status === "passed");
  if (!hasPassing) return "none";

  return "passing";
}

/**
 * Parse PR state from GitHub API
 */
function parsePRState(state: string): PRState {
  const s = state.toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed";
  return "open";
}

/**
 * Parse review decision from GitHub API
 */
function parseReviewDecision(decision: string | undefined): ReviewDecision {
  if (!decision) return "none";
  const d = decision.toUpperCase();
  if (d === "APPROVED") return "approved";
  if (d === "CHANGES_REQUESTED") return "changes_requested";
  if (d === "REVIEW_REQUIRED") return "pending";
  return "none";
}

/**
 * Compute merge readiness from PR and CI data
 */
function computeMergeReadiness(prData: PRData, ciData: CIData): MergeReadiness {
  const blockers: string[] = [];

  // CI
  const ciPassing = ciData.summary === CI_STATUS.PASSING || ciData.summary === CI_STATUS.NONE;
  if (!ciPassing) {
    blockers.push(`CI is ${ciData.summary}`);
  }

  // Reviews
  const approved = prData.reviewDecision === "APPROVED";
  const rd = prData.reviewDecision.toUpperCase();
  if (rd === "CHANGES_REQUESTED") {
    blockers.push("Changes requested in review");
  } else if (rd === "REVIEW_REQUIRED") {
    blockers.push("Review required");
  }

  // Conflicts / merge state
  const mergeable = prData.mergeable.toUpperCase();
  const mergeState = prData.mergeStateStatus.toUpperCase();
  const noConflicts = mergeable === "MERGEABLE";
  if (mergeable === "CONFLICTING") {
    blockers.push("Merge conflicts");
  } else if (mergeable === "UNKNOWN" || mergeable === "") {
    blockers.push("Merge status unknown (GitHub is computing)");
  }
  if (mergeState === "BEHIND") {
    blockers.push("Branch is behind base branch");
  } else if (mergeState === "BLOCKED") {
    blockers.push("Merge is blocked by branch protection");
  } else if (mergeState === "UNSTABLE") {
    blockers.push("Required checks are failing");
  }

  // Draft
  if (prData.isDraft) {
    blockers.push("PR is still a draft");
  }

  return {
    mergeable: blockers.length === 0,
    ciPassing,
    approved,
    noConflicts,
    blockers,
  };
}

// =============================================================================
// SINGLE PR ENRICHMENT
// =============================================================================

interface EnrichmentResult {
  success: boolean;
  enrichment?: PREnrichmentData;
}

/**
 * Enrich a single PR with data from REST API
 */
async function enrichSinglePR(
  pr: PRInfo,
  etagCache: ETagCache,
  prCache: LRUCache<string, { success: boolean; enrichment: PREnrichmentData }>,
  observer?: BatchObserver,
): Promise<EnrichmentResult> {
  const cacheKey = prCacheKey(pr);

  // Check cache first
  const cached = prCache.get(cacheKey);
  if (cached) {
    observer?.log(`Cache hit for ${cacheKey}`);
    return { success: true, enrichment: cached.enrichment };
  }

  observer?.log(`Cache miss for ${cacheKey}, fetching from API`);

  // Make 2 parallel REST calls
  const startedAt = Date.now();
  const results = await Promise.allSettled([fetchPRData(pr, observer), fetchCIData(pr, observer)]);
  const [prResult, ciResult] = results;

  // Check if all critical requests failed
  const failedCount = results.filter((r) => r.status === "rejected").length;
  const allFailed = failedCount === results.length;

  if (allFailed) {
    const firstError =
      results.find((r) => r.status === "rejected")?.reason ?? new Error("Unknown error");
    const error = firstError instanceof Error ? firstError : new Error(String(firstError));
    observer?.recordFailure("enrichSinglePR", error, Date.now() - startedAt);
    // On complete failure, return partial data
    const partialEnrichment: PREnrichmentData = {
      state: "open",
      title: "Failed to fetch",
      additions: 0,
      deletions: 0,
      ciStatus: "none",
      ciChecks: [],
      reviewDecision: "none",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: true,
        blockers: ["Failed to fetch PR data"],
      },
      unresolvedThreads: 0,
      unresolvedComments: [],
    };
    return { success: false, enrichment: partialEnrichment };
  }

  // Build enrichment data from successful results
  const prData = prResult.status === "fulfilled" ? prResult.value : null;
  const ciData = ciResult.status === "fulfilled" ? ciResult.value : null;

  if (!prData || !ciData) {
    observer?.recordFailure(
      "enrichSinglePR",
      new Error("PR or CI data missing"),
      Date.now() - startedAt,
    );
    return { success: false };
  }

  const reviewDecision = parseReviewDecision(prData?.reviewDecision ?? undefined);
  const enrichment: PREnrichmentData = {
    state: parsePRState(prData?.state ?? "open"),
    title: prData?.title ?? "",
    additions: prData?.additions ?? 0,
    deletions: prData?.deletions ?? 0,
    ciStatus: ciData?.summary ?? "none",
    ciChecks:
      ciData?.checks.map((c) => ({
        name: c.name,
        status: c.status,
        url: c.url,
      })) ?? [],
    reviewDecision,
    mergeability: computeMergeReadiness(prData, ciData),
    unresolvedThreads: 0,
    unresolvedComments: [],
  };

  observer?.recordSuccess("enrichSinglePR", Date.now() - startedAt);

  // Cache the enrichment data
  prCache.set(cacheKey, { success: true, enrichment });
  observer?.log(`Cached ${cacheKey}`);

  return { success: true, enrichment };
}

// =============================================================================
// BATCH ENRICHMENT
// =============================================================================

/**
 * Enrich multiple PRs in parallel using REST API with 2-Guard ETag strategy.
 *
 * This is the main entry point for batch PR enrichment.
 * It:
 * 1. Checks ETag guards to determine which PRs need refresh
 * 2. Fetches data for PRs that need refresh in parallel (concurrency limit)
 * 3. Returns enrichment data for all PRs (from cache or fresh)
 */
export async function enrichSessionsPRBatch(
  prs: PRInfo[],
  config?: { project?: unknown; observer?: BatchObserver },
): Promise<Map<string, PREnrichmentData>> {
  const observer = config?.observer ?? new BatchObserverImpl("rest-parallel");
  const etagCache = new ETagCache();
  const prCache = new LRUCache<string, { success: boolean; enrichment: PREnrichmentData }>(
    ENRICHMENT_CACHE_SIZE,
  );
  const result = new Map<string, PREnrichmentData>();

  observer?.log(`Starting batch enrichment for ${prs.length} PRs`);

  // Filter PRs that need refresh using 2-Guard strategy
  const prsNeedingRefresh: PRInfo[] = [];
  const cacheHits: PREnrichmentData[] = [];

  for (const pr of prs) {
    const shouldRefresh = await shouldRefreshPREnrichment(pr, etagCache, observer);
    if (shouldRefresh) {
      prsNeedingRefresh.push(pr);
    } else {
      const cacheKey = prCacheKey(pr);
      const cached = prCache.get(cacheKey);
      if (cached && cached.success) {
        cacheHits.push(cached.enrichment);
        result.set(cacheKey, cached.enrichment);
      } else if (!cached) {
        // No cache but guard says no change - still need to refresh
        prsNeedingRefresh.push(pr);
      }
    }
  }

  observer?.log(`Cache hits: ${cacheHits.length}, refreshes needed: ${prsNeedingRefresh.length}`);

  // Enrich PRs that need refresh in parallel (concurrency limited)
  if (prsNeedingRefresh.length > 0) {
    observer?.log(
      `Enriching ${prsNeedingRefresh.length} PRs in parallel (concurrency=${PARALLEL_CONCURRENCY})`,
    );

    // Process PRs in parallel batches
    const batchSize = Math.min(PARALLEL_CONCURRENCY, prsNeedingRefresh.length);
    const batches: PRInfo[][] = [];
    for (let i = 0; i < prsNeedingRefresh.length; i += batchSize) {
      batches.push(prsNeedingRefresh.slice(i, i + batchSize));
    }

    const batchResults = await Promise.allSettled(
      batches.map((batch) =>
        Promise.all(batch.map((pr) => enrichSinglePR(pr, etagCache, prCache, observer))),
      ),
    );

    // Build result map from successful enrichments
    for (let i = 0; i < prsNeedingRefresh.length; i++) {
      const pr = prsNeedingRefresh[i];
      const batchIndex = Math.floor(i / batchSize);
      const batchResult = batchResults[batchIndex];

      if (batchResult?.status === "fulfilled") {
        const innerResults = batchResult.value;
        const innerIndex = i % batchSize;
        const enrichment = innerResults?.[innerIndex];

        if (enrichment?.success && enrichment?.enrichment) {
          const cacheKey = prCacheKey(pr);
          result.set(cacheKey, enrichment.enrichment);
          observer?.log(`Enriched ${cacheKey}`);
        } else {
          // Enrichment failed or cache miss - add partial data
          const cacheKey = prCacheKey(pr);
          if (!result.has(cacheKey)) {
            result.set(cacheKey, {
              state: "open",
              title: pr.title,
              additions: 0,
              deletions: 0,
              ciStatus: "none",
              ciChecks: [],
              reviewDecision: "none",
              mergeability: {
                mergeable: false,
                ciPassing: false,
                approved: false,
                noConflicts: true,
                blockers: ["Enrichment failed"],
              },
              unresolvedThreads: 0,
              unresolvedComments: [],
            });
          }
        }
      }
    }
  }

  observer?.log(`Batch enrichment complete: ${result.size} PRs enriched`);

  return result;
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
  LRUCache,
  ETagCache,
  PARALLEL_CONCURRENCY,
  PR_METADATA_CACHE_SIZE,
  ENRICHMENT_CACHE_SIZE,
};
