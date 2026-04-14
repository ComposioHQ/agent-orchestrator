/**
 * GraphQL Batch PR Enrichment
 *
 * Efficiently fetches data for multiple PRs using GraphQL aliases.
 * Reduces API calls from N×3 to 1 (or a few if batching needed).
 */

import {
  getGhClient,
  type BatchObserver,
  type CICheck,
  type CIStatus,
  type PREnrichmentData,
  type PRInfo,
  type PRState,
  type ReviewDecision,
} from "@aoagents/ao-core";
import { LRUCache } from "./lru-cache.js";

/**
 * Configuration constants for cache sizing.
 * LRU cache automatically evicts oldest entries when these limits are reached.
 */
const MAX_PR_LIST_ETAGS = 100;  // Number of repos to cache
const MAX_PR_METADATA = 200;  // Number of PRs to cache full data

/**
 * ETag cache for REST API endpoints.
 * Used to avoid expensive GraphQL queries when nothing has changed.
 *
 * Keys:
 * - PR list: "prList:{owner}/{repo}"
 */
interface ETagCache {
  prList: LRUCache<string, string>; // Key: "owner/repo", Value: ETag
}

/**
 * Global ETag cache instance.
 * This is shared across all batch enrichment calls within the process lifecycle.
 * The cache persists between polling cycles to avoid redundant REST/GraphQL calls.
 *
 * Uses LRU eviction to ensure bounded memory usage.
 */
const etagCache: ETagCache = {
  prList: new LRUCache(MAX_PR_LIST_ETAGS),
};

/**
 * Result of checking if PR data has changed via ETag guards.
 */
interface ETagGuardResult {
  shouldRefresh: boolean;
  details: string[];
}

/**
 * Clear all ETag cache entries.
 * Useful for testing or when forcing a refresh.
 */
export function clearETagCache(): void {
  etagCache.prList.clear();
}

/**
 * Get PR list ETag for a repository.
 */
export function getPRListETag(owner: string, repo: string): string | undefined {
  return etagCache.prList.get(`${owner}/${repo}`);
}

/**
 * Set PR list ETag for a repository.
 * Exported for testing.
 */
export function setPRListETag(owner: string, repo: string, etag: string): void {
  etagCache.prList.set(`${owner}/${repo}`, etag);
}

/**
 * Cache for PR metadata needed for ETag guard decisions.
 * Stores head SHA and CI status for each PR.
 * Key: "${owner}/${repo}#${number}"
 *
 * Uses LRU eviction to ensure bounded memory usage.
 */
const prMetadataCache = new LRUCache<
  string,
  { headSha: string | null; ciStatus: CIStatus }
>(MAX_PR_METADATA);

/**
 * Cache for full PR enrichment data.
 * Stores the complete PREnrichmentData object for each PR.
 * Used when ETag guard indicates no refresh is needed.
 * Key: "${owner}/${repo}#${number}"
 *
 * Uses LRU eviction to ensure bounded memory usage.
 */
const prEnrichmentDataCache = new LRUCache<string, PREnrichmentData>(MAX_PR_METADATA);

/**
 * Timestamp of the last successful batch refresh.
 * Used to enforce a staleness cap so that the batch re-runs
 * even when Guard 1 returns 304 (e.g. CI status changes that
 * don't touch the PR list).
 */
let lastBatchRefreshAt = 0;

/** Maximum staleness before forcing a batch refresh (2 minutes). */
const STALENESS_CAP_MS = 2 * 60 * 1000;

/**
 * Update PR metadata cache with latest enrichment data.
 * Called after successful GraphQL batch enrichment.
 */
function updatePRMetadataCache(
  prKey: string,
  enrichment: PREnrichmentData,
  headSha: string | null,
): void {
  prMetadataCache.set(prKey, {
    headSha,
    ciStatus: enrichment.ciStatus,
  });
  // Also cache the full enrichment data for ETag guard bypass
  prEnrichmentDataCache.set(prKey, enrichment);
}

/**
 * ETag Guard + Staleness Cap: Check if PR enrichment cache needs refreshing.
 *
 * Before running expensive GraphQL batch queries, uses a lightweight REST API
 * ETag check (Guard 1) plus a time-based staleness cap to decide if the batch
 * should run.
 *
 * Guard 1: PR List ETag Check (per repo)
 *   - Detects: New commits, PR title/body edits, labels changes, reviews, PR state changes
 *   - Cost: 1 REST call per repo (0 if 304 Not Modified)
 *
 * Staleness Cap (replaces former Guard 2):
 *   - If Guard 1 says "no change" but the cache is older than 2 minutes, run batch anyway.
 *   - Catches CI status changes that don't touch the PR list.
 *   - Saves ~6,000 REST calls/hour compared to per-PR commit status checks.
 *
 * @param prs - PRs to check
 * @returns true if GraphQL batch should run, false if nothing changed
 */
export async function shouldRefreshPREnrichment(
  prs: PRInfo[],
): Promise<ETagGuardResult> {
  const details: string[] = [];

  if (prs.length === 0) {
    return { shouldRefresh: false, details: ["No PRs to check"] };
  }

  // Group PRs by repository for Guard 1 (PR list check)
  const repos = new Set<string>();
  for (const pr of prs) {
    repos.add(`${pr.owner}/${pr.repo}`);
  }

  // Guard 1: Check PR list ETag for each repository
  let guard1DetectedChanges = false;
  for (const repoKey of repos) {
    const [owner, repo] = repoKey.split("/");
    const prListChanged = await checkPRListETag(owner, repo);
    if (prListChanged) {
      guard1DetectedChanges = true;
      details.push(`PR list changed for ${repoKey} (Guard 1)`);
    }
  }

  if (guard1DetectedChanges) {
    return { shouldRefresh: true, details };
  }

  // Staleness cap: if Guard 1 says "no change" but cache is older than
  // STALENESS_CAP_MS, run the batch anyway to catch CI status changes.
  const cacheAge = Date.now() - lastBatchRefreshAt;
  if (cacheAge >= STALENESS_CAP_MS) {
    details.push(`Cache stale (${Math.round(cacheAge / 1000)}s old, cap ${STALENESS_CAP_MS / 1000}s)`);
    return { shouldRefresh: true, details };
  }

  return { shouldRefresh: false, details: ["No changes detected (Guard 1 + staleness cap)"] };
}

/**
 * Get cached PR metadata for testing.
 */
export function getPRMetadataCache(): Map<
  string,
  { headSha: string | null; ciStatus: CIStatus }
> {
  return prMetadataCache.toMap();
}

/**
 * Get cached PR enrichment data for testing.
 */
export function getPREnrichmentDataCache(): Map<string, PREnrichmentData> {
  return prEnrichmentDataCache.toMap();
}

/**
 * Set PR metadata for testing.
 */
export function setPRMetadata(
  key: string,
  metadata: { headSha: string | null; ciStatus: CIStatus },
): void {
  prMetadataCache.set(key, metadata);
}

/**
 * Clear PR metadata cache for testing.
 */
export function clearPRMetadataCache(): void {
  prMetadataCache.clear();
  prEnrichmentDataCache.clear();
  lastBatchRefreshAt = 0;
}

/**
 * Maximum number of PRs to query in a single GraphQL batch.
 * GitHub has limits on query complexity and we stay well under this limit.
 */
export const MAX_BATCH_SIZE = 25;

/**
 * Guard 1: PR List ETag Check (per repo)
 *
 * Detects if PR metadata has changed in a repository using REST ETag.
 *
 * - Endpoint: GET /repos/{owner}/{repo}/pulls?state=open&sort=updated&direction=desc
 * - Detects: New commits, PR title/body edits, label changes, reviews, PR state changes
 * - Misses: CI status changes (handled by Guard 2)
 *
 * @returns true if PR list has changed (200 OK), false if unchanged (304 Not Modified)
 */
async function checkPRListETag(
  owner: string,
  repo: string,
): Promise<boolean> {
  const repoKey = `${owner}/${repo}`;
  const cachedETag = etagCache.prList.get(repoKey);

  // Build gh CLI args for REST API call
  const url = `repos/${repoKey}/pulls?state=open&sort=updated&direction=desc&per_page=1`;
  const args = ["api", "--method", "GET", url, "-i"]; // -i includes headers

  // Add If-None-Match header if we have a cached ETag
  if (cachedETag) {
    args.push("-H", `If-None-Match: ${cachedETag}`);
  }

  try {
    const output = await getGhClient().exec(args, { timeout: 10_000 });

    // Check for HTTP 304 Not Modified response
    if (output.includes("HTTP/1.1 304") || output.includes("HTTP/2 304")) {
      // No changes detected - cost: 0 GraphQL points
      return false;
    }

    // Extract new ETag from response headers
    // ETag header format: "etag": "W/"abc123..." or "etag": "abc123..."
    const etagMatch = output.match(/etag:\s*(.+)/i);
    if (etagMatch) {
      // Trim to remove trailing whitespace/newlines that could cause comparison issues
      const newETag = etagMatch[1].trim();
      setPRListETag(owner, repo, newETag);
    }

    // PR list changed - cost: 1 REST point
    return true;
  } catch (err) {
    // On error, assume change to ensure we don't miss anything
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Log but don't throw - allow GraphQL batch to proceed
    // eslint-disable-next-line no-console -- Observability logging for ETag errors
    console.warn(`[ETag Guard 1] PR list check failed for ${repoKey}: ${errorMsg}`);
    return true; // Assume changed to be safe
  }
}

/**
 * GraphQL fields to fetch for each PR.
 * This includes all data needed for orchestrator status detection.
 */
const PR_FIELDS = `
  title
  state
  additions
  deletions
  isDraft
  mergeable
  mergeStateStatus
  reviewDecision
  headRefName
  headRefOid
  reviews(last: 3) {
    nodes {
      author { login }
      state
      submittedAt
    }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 15) {
            nodes {
              ... on CheckRun {
                name
                status
                conclusion
                detailsUrl
              }
              ... on StatusContext {
                context
                state
                targetUrl
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      }
    }
  }
`;

/**
 * Generate a GraphQL batch query for multiple PRs using aliases.
 *
 * Each PR gets a unique alias (pr0, pr1, pr2...) and the query
 * fetches the same fields for each PR.
 */
export function generateBatchQuery(prs: PRInfo[]): {
  query: string;
  variables: Record<string, unknown>;
} {
  // Handle empty array - return empty query to be handled by caller
  if (prs.length === 0) {
    return {
      query: "",
      variables: {},
    };
  }

  const selections: string[] = [];
  const variables: Record<string, unknown> = {};

  prs.forEach((pr, i) => {
    const alias = `pr${i}`;
    // Using inline fragments to handle nullable repository type
    selections.push(`
      ${alias}: repository(owner: $${alias}Owner, name: $${alias}Name) {
        ... on Repository {
          pullRequest(number: $${alias}Number) { ${PR_FIELDS} }
        }
      }
    `);
    variables[`${alias}Owner`] = pr.owner;
    variables[`${alias}Name`] = pr.repo;
    variables[`${alias}Number`] = pr.number;
  });

  const variableDefs = Object.entries(variables)
    .map(([key, value]) => `$${key}: ${typeof value === "number" ? "Int!" : "String!"}`)
    .join(", ");

  return {
    query: `query BatchPRs(${variableDefs}) {
      ${selections.join("\n")}
    }`,
    variables,
  };
}

/**
 * Execute a GraphQL batch query using the gh CLI.
 *
 * @throws Error if the query fails with GraphQL errors or parsing issues.
 */
async function executeBatchQuery(
  prs: PRInfo[],
): Promise<Record<string, unknown>> {
  const { query, variables } = generateBatchQuery(prs);

  // Handle empty array - no query needed
  if (!query || prs.length === 0) {
    return {};
  }

  // Build gh CLI arguments with variables
  const varArgs: string[] = [];
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "string") {
      varArgs.push("-f", `${key}=${value}`);
    } else {
      varArgs.push("-F", `${key}=${value}`);
    }
  }

  const args = ["api", "graphql", ...varArgs, "-f", `query=${query}`];

  // Scale timeout based on batch size to prevent large batches from timing out
  // Base: 30s, +2s per PR beyond first 10
  const batchSize = prs.length;
  const adaptiveTimeout = 30_000 + Math.max(0, (batchSize - 10) * 2000);

  const stdout = await getGhClient().exec(args, { timeout: adaptiveTimeout });

  const result: {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string; path?: string[] }>;
  } = JSON.parse(stdout);

  // Check for GraphQL errors and throw to allow individual API fallback
  if (result.errors && result.errors.length > 0) {
    const errorMsg = result.errors.map((e) => e.message).join("; ");
    throw new Error(`GraphQL query errors: ${errorMsg}`);
  }

  return (result.data ?? {}) as Record<string, unknown>;
}

/**
 * Parse individual CI check contexts from statusCheckRollup.contexts.nodes.
 * Handles both CheckRun (GitHub Actions) and StatusContext (legacy status checks).
 */
function parseCheckContexts(contexts: unknown): CICheck[] {
  if (!contexts || typeof contexts !== "object") return [];

  const nodes = (contexts as Record<string, unknown>)["nodes"];
  if (!Array.isArray(nodes)) return [];

  const checks: CICheck[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;

    // CheckRun node (GitHub Actions)
    if (typeof n["name"] === "string" && typeof n["status"] === "string") {
      const rawStatus = (n["status"] as string).toUpperCase();
      // Uppercase conclusion to match REST getCIChecks/getCIChecksFromStatusRollup format
      // so fingerprints are consistent regardless of which data source is used.
      const rawConclusion =
        typeof n["conclusion"] === "string" ? (n["conclusion"] as string).toUpperCase() : null;

      let status: CICheck["status"];
      if (rawStatus === "COMPLETED") {
        if (rawConclusion === "SUCCESS") {
          status = "passed";
        } else if (
          rawConclusion === "SKIPPED" ||
          rawConclusion === "NEUTRAL" ||
          rawConclusion === "STALE" ||
          rawConclusion === "NOT_REQUIRED" ||
          rawConclusion === "NONE"
        ) {
          // Mirror mapRawCheckStateToStatus() in the REST path: all non-failure
          // terminal conclusions that are not SUCCESS map to "skipped".
          status = "skipped";
        } else if (
          rawConclusion === "FAILURE" ||
          rawConclusion === "TIMED_OUT" ||
          rawConclusion === "CANCELLED" ||
          rawConclusion === "ACTION_REQUIRED" ||
          rawConclusion === "ERROR"
        ) {
          // Explicit failure conclusions — mirrors the failure list in mapRawCheckStateToStatus()
          status = "failed";
        } else {
          // STARTUP_FAILURE and any other unrecognized conclusion → "skipped",
          // matching mapRawCheckStateToStatus()'s default return "skipped" in the REST path.
          status = "skipped";
        }
      } else if (rawStatus === "IN_PROGRESS") {
        // Only IN_PROGRESS maps to "running" — matches mapRawCheckStateToStatus() in REST path
        status = "running";
      } else {
        // QUEUED, WAITING, and any other non-COMPLETED status → "pending"
        // (REST path maps QUEUED/WAITING to "pending", not "running")
        status = "pending";
      }

      checks.push({
        name: n["name"] as string,
        status,
        // Store the uppercased conclusion to match REST format
        conclusion: rawConclusion ?? undefined,
        url: typeof n["detailsUrl"] === "string" ? (n["detailsUrl"] as string) : undefined,
      });
      continue;
    }

    // StatusContext node (legacy commit statuses)
    if (typeof n["context"] === "string" && typeof n["state"] === "string") {
      const rawState = (n["state"] as string).toUpperCase();
      let status: CICheck["status"];
      if (rawState === "SUCCESS") {
        status = "passed";
      } else if (rawState === "FAILURE" || rawState === "ERROR") {
        status = "failed";
      } else {
        status = "pending";
      }

      // Set conclusion to match the REST getCIChecksFromStatusRollup format
      // (which sets conclusion = rawState.toUpperCase()) so fingerprints are
      // consistent regardless of which data source is used.
      checks.push({
        name: n["context"] as string,
        status,
        conclusion: rawState,
        url: typeof n["targetUrl"] === "string" ? (n["targetUrl"] as string) : undefined,
      });
    }
  }

  return checks;
}

/**
 * Parse raw CI state from status check rollup.
 *
 * Uses only the top-level aggregate state to determine overall CI status.
 * Individual check details are parsed separately via parseCheckContexts().
 */
function parseCIState(
  statusCheckRollup: unknown,
): CIStatus {
  if (!statusCheckRollup || typeof statusCheckRollup !== "object") {
    return "none";
  }

  const rollup = statusCheckRollup as Record<string, unknown>;
  const state = typeof rollup["state"] === "string" ? rollup["state"].toUpperCase() : "";

  // Map GitHub's statusCheckRollup.state to our CIStatus enum
  // This top-level state aggregates all individual checks and is
  // significantly cheaper than fetching contexts (10 points vs 50+ per PR)
  if (state === "SUCCESS") return "passing";
  if (state === "FAILURE") return "failing";
  if (state === "ERROR") return "failing";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  if (state === "TIMED_OUT" || state === "CANCELLED" || state === "ACTION_REQUIRED")
    return "failing";
  if (state === "QUEUED" || state === "IN_PROGRESS" || state === "WAITING")
    return "pending";

  return "none";
}

/**
 * Parse review decision from GraphQL response.
 */
function parseReviewDecision(reviewDecision: unknown): ReviewDecision {
  const decision = typeof reviewDecision === "string" ? reviewDecision.toUpperCase() : "";
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes_requested";
  if (decision === "REVIEW_REQUIRED") return "pending";
  return "none";
}

/**
 * Parse PR state from GraphQL response.
 */
function parsePRState(state: unknown): PRState {
  const s = typeof state === "string" ? state.toUpperCase() : "";
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed";
  return "open";
}

/**
 * Extract enrichment data from a single PR result.
 *
 * Returns the enrichment data along with the head SHA for ETag caching.
 */
function extractPREnrichment(
  pullRequest: unknown,
): { data: PREnrichmentData; headSha: string | null } | null {
  if (!pullRequest || typeof pullRequest !== "object") {
    return null;
  }

  const pr = pullRequest as Record<string, unknown>;

  // Check for at least one required field to validate this is a valid PR object
  if (
    pr["state"] === undefined &&
    pr["title"] === undefined &&
    pr["reviews"] === undefined &&
    pr["commits"] === undefined
  ) {
    return null;
  }

  const state = parsePRState(pr["state"]);

  // Extract basic info
  const title = typeof pr["title"] === "string" ? pr["title"] : undefined;
  const additions = typeof pr["additions"] === "number" ? pr["additions"] : 0;
  const deletions = typeof pr["deletions"] === "number" ? pr["deletions"] : 0;
  const isDraft = pr["isDraft"] === true;

  // Extract head SHA for ETag Guard 2
  const headSha =
    typeof pr["headRefOid"] === "string"
      ? pr["headRefOid"]
      : typeof pr["headSha"] === "string"
        ? pr["headSha"]
        : null;

  // Extract merge info
  const mergeable = pr["mergeable"];
  const mergeStateStatus =
    typeof pr["mergeStateStatus"] === "string"
      ? pr["mergeStateStatus"].toUpperCase()
      : "";
  const hasConflicts = mergeable === "CONFLICTING";
  const isBehind = mergeStateStatus === "BEHIND";

  // Extract review decision
  const reviewDecision = parseReviewDecision(pr["reviewDecision"]);

  // Extract CI status and individual checks from commits
  const commits = pr["commits"] as
    | { nodes?: Array<{ commit?: { statusCheckRollup?: Record<string, unknown> } }> }
    | undefined;
  const statusCheckRollup = commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const ciStatus = statusCheckRollup ? parseCIState(statusCheckRollup) : "none";

  // Only include ciChecks when the list is complete (no truncation).
  // contexts(first: 20) silently truncates PRs with >20 checks — when truncated,
  // the failing check may be missing, so we set ciChecks to undefined to force
  // the getCIChecks() REST fallback in maybeDispatchCIFailureDetails.
  const contextsField = statusCheckRollup?.["contexts"] as
    | Record<string, unknown>
    | undefined;
  const pageInfo = contextsField?.["pageInfo"];
  const contextsHasNextPage =
    pageInfo !== null &&
    pageInfo !== undefined &&
    typeof pageInfo === "object" &&
    (pageInfo as Record<string, unknown>)["hasNextPage"] === true;
  const ciChecks =
    contextsField && !contextsHasNextPage
      ? parseCheckContexts(contextsField)
      : undefined;

  // Build blockers list
  const blockers: string[] = [];
  if (ciStatus === "failing") blockers.push("CI is failing");
  if (reviewDecision === "changes_requested")
    blockers.push("Changes requested in review");
  if (reviewDecision === "pending") blockers.push("Review required");
  if (hasConflicts) blockers.push("Merge conflicts");
  if (isBehind) blockers.push("Branch is behind base branch");
  if (isDraft) blockers.push("PR is still a draft");

  // Determine if mergeable based on all conditions
  // Merged/closed PRs are not considered mergeable for new changes
  const isMergeableState = state === "open";
  // Treat ciStatus "none" as passing (no CI checks configured), matching individual getMergeability
  const ciPassing = ciStatus === "passing" || ciStatus === "none";
  const mergeReady =
    isMergeableState &&
    ciPassing &&
    (reviewDecision === "approved" || reviewDecision === "none") &&
    !hasConflicts &&
    !isBehind &&
    !isDraft;

  const data: PREnrichmentData = {
    state,
    ciStatus,
    reviewDecision,
    mergeable: mergeReady,
    title,
    additions,
    deletions,
    isDraft,
    hasConflicts,
    isBehind,
    blockers,
    ...(ciChecks !== undefined ? { ciChecks } : {}),
  };

  return { data, headSha };
}

/**
 * Main batch enrichment function with 2-Guard ETag Strategy.
 *
 * Before running expensive GraphQL batch queries, uses two lightweight REST API
 * ETag checks to detect if anything actually changed:
 *
 * 1. Guard 1: PR List ETag Check (per repo)
 *    - Detects PR metadata changes (commits, reviews, labels, state)
 *    - Cost: 1 REST point if changed, 0 if unchanged (304)
 *
 * 2. Guard 2: Commit Status ETag Check (per PR with pending CI)
 *    - Detects CI status changes for PRs with pending CI
 *    - Cost: 1 REST point if changed, 0 if unchanged (304)
 *
 * If guards indicate no changes, skips GraphQL entirely (saves ~50 points per batch).
 * If any guard detects a change, runs GraphQL batch queries.
 *
 * Returns a Map keyed by "${owner}/${repo}#${number}" for efficient lookup.
 */
export async function enrichSessionsPRBatch(
  prs: PRInfo[],
  observer?: BatchObserver,
): Promise<Map<string, PREnrichmentData>> {
  const result = new Map<string, PREnrichmentData>();

  if (prs.length === 0) {
    return result;
  }

  // Step 1: Check if we need to refresh using 2-Guard ETag Strategy
  const guardResult = await shouldRefreshPREnrichment(prs);

  if (!guardResult.shouldRefresh) {
    // No changes detected - try to return cached data
    // If any PRs are missing from cache, we need to fetch them via GraphQL
    const missingPRs: PRInfo[] = [];

    for (const pr of prs) {
      const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
      const cachedData = prEnrichmentDataCache.get(prKey);
      if (cachedData) {
        result.set(prKey, cachedData);
      } else {
        missingPRs.push(pr);
      }
    }

    if (missingPRs.length === 0) {
      // All PRs cached - return cached data
      observer?.log(
        "info",
        `[ETag Guard] Skipping GraphQL batch - all ${result.size} PRs cached. Reasons: ${guardResult.details.join(", ")}`,
      );
      return result;
    }

    // Some PRs not cached - fetch missing PRs via GraphQL
    observer?.log(
      "info",
      `[ETag Guard] Partial cache: ${result.size} cached, ${missingPRs.length} missing. Fetching missing PRs via GraphQL.`,
    );
    prs = missingPRs; // Update to only fetch missing PRs
    // Continue to GraphQL batch processing below
  }

  // Step 2: Split into batches if we have too many PRs
  const batches: PRInfo[][] = [];
  for (let i = 0; i < prs.length; i += MAX_BATCH_SIZE) {
    batches.push(prs.slice(i, i + MAX_BATCH_SIZE));
  }

  // Step 3: Execute each batch
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const prCountBefore = result.size;
    const batchStartTime = Date.now();
    let batchDuration: number;

    try {
      const data = await executeBatchQuery(batch);
      batchDuration = Date.now() - batchStartTime;

      // Extract results for each PR in the batch
      batch.forEach((pr, index) => {
        const alias = `pr${index}`;
        const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
        const repositoryData = data[alias] as { pullRequest?: unknown } | undefined;

        if (repositoryData?.pullRequest) {
          const extracted = extractPREnrichment(repositoryData.pullRequest);
          if (extracted) {
            const { data: enrichment, headSha } = extracted;
            result.set(prKey, enrichment);
            // Update PR metadata cache for future ETag checks
            updatePRMetadataCache(prKey, enrichment, headSha);
          }
        } else {
          // PR not found (deleted/closed/permission issue)
          // Don't add to result or cache.
          // This allows lifecycle-manager to fall back to individual API calls
          // which can better handle permissions/edge cases.
          // The batch will succeed with fewer PRs, and missing PRs
          // will trigger the fallback path on the next poll.
        }
      });

      // Log observability metric for successful batch
      const prCountAfter = result.size;
      if (prCountAfter > prCountBefore) {
        const successData = {
          batchIndex,
          totalBatches: batches.length,
          prCount: prCountAfter - prCountBefore,
          durationMs: batchDuration,
        };
        observer?.recordSuccess(successData);
        observer?.log("info", `[GraphQL Batch Success] Batch ${batchIndex + 1}/${batches.length} succeeded: added ${prCountAfter - prCountBefore} PRs to cache (${batchDuration}ms)`);
      }
    } catch (err) {
      // Calculate duration even on failure
      batchDuration = Date.now() - batchStartTime;

      // Record failure for observability
      const errorMsg = err instanceof Error ? err.message : String(err);
      observer?.recordFailure({
        batchIndex,
        totalBatches: batches.length,
        prCount: batch.length,
        error: errorMsg,
        durationMs: batchDuration,
      });

      // Log error for observability but don't fail entirely
      // eslint-disable-next-line no-console -- Observability logging for batch errors
      console.error(`[GraphQL Batch Warning] Batch enrichment partially failed: ${errorMsg}`);

      // Don't add placeholder entries to result or cache.
      // This allows lifecycle-manager to fall back to individual API calls
      // for PRs in the failed batch on the next poll.
      // Return only the partial results we successfully fetched.
      // Continue to next batch instead of throwing to allow partial success.

      // Continue with next batch
    }
  }

  // Record refresh timestamp unconditionally — even if all PRs were missing
  // or returned errors, the batch ran and we shouldn't re-run on every poll.
  lastBatchRefreshAt = Date.now();

  return result;
}

// Export internal functions for testing
export {
  parseCIState,
  parseReviewDecision,
  parsePRState,
  extractPREnrichment,
  checkPRListETag,
  // shouldRefreshPREnrichment is already exported as async function
  updatePRMetadataCache,
};

// Export types for testing
export type { ETagCache, ETagGuardResult };
