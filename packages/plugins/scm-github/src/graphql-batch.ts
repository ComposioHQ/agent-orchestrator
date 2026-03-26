/**
 * GraphQL Batch PR Enrichment
 *
 * Efficiently fetches data for multiple PRs using GraphQL aliases.
 * Reduces API calls from N×3 to 1 (or a few if batching needed).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CIStatus,
  ObservabilityLevel,
  PREnrichmentData,
  PRInfo,
  PRState,
  ReviewDecision,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

/**
 * ETag cache for REST API endpoints.
 * Used to avoid expensive GraphQL queries when nothing has changed.
 *
 * Keys:
 * - PR list: "prList:{owner}/{repo}"
 * - Commit status: "commit:{owner}/{repo}#{sha}"
 */
interface ETagCache {
  prList: Map<string, string>; // Key: "owner/repo", Value: ETag
  commitStatus: Map<string, string>; // Key: "owner/repo#sha", Value: ETag
}

/**
 * Global ETag cache instance.
 * This is shared across all batch enrichment calls within the process lifecycle.
 * The cache persists between polling cycles to avoid redundant REST/GraphQL calls.
 */
const etagCache: ETagCache = {
  prList: new Map(),
  commitStatus: new Map(),
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
  etagCache.commitStatus.clear();
}

/**
 * Get PR list ETag for a repository.
 */
export function getPRListETag(owner: string, repo: string): string | undefined {
  return etagCache.prList.get(`${owner}/${repo}`);
}

/**
 * Get commit status ETag for a specific commit.
 */
export function getCommitStatusETag(
  owner: string,
  repo: string,
  sha: string,
): string | undefined {
  return etagCache.commitStatus.get(`${owner}/${repo}#${sha}`);
}

/**
 * Set PR list ETag for a repository.
 */
function setPRListETag(owner: string, repo: string, etag: string): void {
  etagCache.prList.set(`${owner}/${repo}`, etag);
}

/**
 * Set commit status ETag for a specific commit.
 */
function setCommitStatusETag(
  owner: string,
  repo: string,
  sha: string,
  etag: string,
): void {
  etagCache.commitStatus.set(`${owner}/${repo}#${sha}`, etag);
}

/**
 * Cache for PR metadata needed for ETag guard decisions.
 * Stores head SHA and CI status for each PR.
 * Key: "${owner}/${repo}#${number}"
 */
const prMetadataCache = new Map<
  string,
  { headSha: string | null; ciStatus: CIStatus }
>();

/**
 * Cache for full PR enrichment data.
 * Stores the complete PREnrichmentData object for each PR.
 * Used when ETag guard indicates no refresh is needed.
 * Key: "${owner}/${repo}#${number}"
 */
const prEnrichmentDataCache = new Map<string, PREnrichmentData>();

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
 * 2-Guard ETag Strategy: Check if PR enrichment cache needs refreshing.
 *
 * Before running expensive GraphQL batch queries, use two lightweight REST API
 * ETag checks to detect if anything actually changed:
 *
 * Guard 1: PR List ETag Check (per repo)
 *   - Detects: New commits, PR title/body edits, labels changes, reviews, PR state changes
 *   - Misses: CI status changes
 *
 * Guard 2: Commit Status ETag Check (per PR with pending CI)
 *   - Only checks PRs with ciStatus === "pending"
 *   - Detects: CI check starts, passes, fails, or external status updates
 *
 * @param prs - PRs to check
 * @returns true if GraphQL batch should run, false if nothing changed
 */
export async function shouldRefreshPREnrichment(
  prs: PRInfo[],
): Promise<ETagGuardResult> {
  const details: string[] = [];
  let shouldRefresh = false;

  if (prs.length === 0) {
    return { shouldRefresh: false, details: ["No PRs to check"] };
  }

  // Group PRs by repository for Guard 1 (PR list check)
  const repos = new Map<string, PRInfo[]>();
  const pendingCIPRs: Array<{ pr: PRInfo; key: string }> = [];

  for (const pr of prs) {
    const repoKey = `${pr.owner}/${pr.repo}`;
    if (!repos.has(repoKey)) {
      repos.set(repoKey, []);
    }
    const repoPrs = repos.get(repoKey);
    if (repoPrs) {
      repoPrs.push(pr);
    }

    // Collect PRs with pending CI for Guard 2
    const prKey = `${repoKey}#${pr.number}`;
    const cached = prMetadataCache.get(prKey);
    if (cached && cached.ciStatus === "pending") {
      pendingCIPRs.push({ pr, key: prKey });
    }
  }

  // Guard 1: Check PR list ETag for each repository
  for (const [repoKey] of repos) {
    const [owner, repo] = repoKey.split("/");
    const prListChanged = await checkPRListETag(owner, repo);
    if (prListChanged) {
      shouldRefresh = true;
      details.push(`PR list changed for ${repoKey} (Guard 1)`);
    }
  }

  // Guard 2: Check commit status ETag for PRs with pending CI
  // We need to fetch head SHA for these PRs - use a lightweight REST call
  for (const { key: prKey } of pendingCIPRs) {
    const [ownerRepo, number] = prKey.split("#");
    const [owner, repo] = ownerRepo.split("/");

    // Get head SHA from PR metadata cache or fetch via REST
    const cached = prMetadataCache.get(prKey);
    const headSha = cached?.headSha;

    if (!headSha) {
      // First time seeing this PR - need to refresh
      shouldRefresh = true;
      details.push(`First time seeing PR #${number} (Guard 2: no cached head SHA)`);
      continue;
    }

    const statusChanged = await checkCommitStatusETag(owner, repo, headSha);
    if (statusChanged) {
      shouldRefresh = true;
      details.push(`CI status changed for ${owner}/${repo}#${number} (Guard 2)`);
    }
  }

  return { shouldRefresh, details };
}

/**
 * Get cached PR metadata for testing.
 */
export function getPRMetadataCache(): Map<
  string,
  { headSha: string | null; ciStatus: CIStatus }
> {
  return new Map(prMetadataCache);
}

/**
 * Get cached PR enrichment data for testing.
 */
export function getPREnrichmentDataCache(): Map<string, PREnrichmentData> {
  return new Map(prEnrichmentDataCache);
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
}

/**
 * Interface for recording GraphQL batch observability operations.
 * Allows the caller to provide an observer that records to
 * observability system instead of using console.log.
 */
export interface BatchObserver {
  recordSuccess(data: {
    batchIndex: number;
    totalBatches: number;
    prCount: number;
    durationMs: number;
  }): void;
  recordFailure(data: {
    batchIndex: number;
    totalBatches: number;
    prCount: number;
    error: string;
    durationMs: number;
  }): void;
  log(level: ObservabilityLevel, message: string): void;
}

/**
 * Interface for errors with cause property (ES2022+).
 * Used for better error tracking when cause is not available in older environments.
 */
interface ErrorWithCause extends Error {
  cause?: unknown;
}

/**
 * Pre-flight check to verify gh CLI is available and authenticated.
 * This prevents silent failures during GraphQL batch queries.
 */
async function verifyGhCLI(): Promise<void> {
  try {
    await execFileAsync("gh", ["--version"], { timeout: 5000 });
  } catch {
    const error = new Error(
      "gh CLI not available or not authenticated. GraphQL batch enrichment requires gh CLI to be installed and configured.",
    ) as ErrorWithCause;
    error.cause = "GH_CLI_UNAVAILABLE";
    throw error;
  }
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
    const { stdout } = await execFileAsync("gh", args, { timeout: 10_000 });
    const output = stdout.trim();

    // Check for HTTP 304 Not Modified response
    if (output.includes("HTTP/1.1 304") || output.includes("HTTP/2 304")) {
      // No changes detected - cost: 0 GraphQL points
      return false;
    }

    // Extract new ETag from response headers
    // ETag header format: "etag": "W/"abc123..." or "etag": "abc123..."
    const etagMatch = output.match(/etag:\s*"([^"]+)"/i);
    if (etagMatch) {
      const newETag = etagMatch[1];
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
 * Guard 2: Commit Status ETag Check (per PR with pending CI)
 *
 * Detects if CI status has changed for a specific commit using REST ETag.
 *
 * - Endpoint: GET /repos/{owner}/{repo}/commits/{head_sha}/status
 * - Detects: CI check starts, passes, fails, or external status updates
 * - Only checked for PRs with ciStatus === "pending" to minimize calls
 *
 * @returns true if CI status has changed (200 OK), false if unchanged (304 Not Modified)
 */
async function checkCommitStatusETag(
  owner: string,
  repo: string,
  sha: string,
): Promise<boolean> {
  const commitKey = `${owner}/${repo}#${sha}`;
  const cachedETag = etagCache.commitStatus.get(commitKey);

  // Build gh CLI args for REST API call
  const url = `repos/${owner}/${repo}/commits/${sha}/status`;
  const args = ["api", "--method", "GET", url, "-i"]; // -i includes headers

  // Add If-None-Match header if we have a cached ETag
  if (cachedETag) {
    args.push("-H", `If-None-Match: ${cachedETag}`);
  }

  try {
    const { stdout } = await execFileAsync("gh", args, { timeout: 10_000 });
    const output = stdout.trim();

    // Check for HTTP 304 Not Modified response
    if (output.includes("HTTP/1.1 304") || output.includes("HTTP/2 304")) {
      // No CI changes detected - cost: 0 GraphQL points
      return false;
    }

    // Extract new ETag from response headers
    const etagMatch = output.match(/etag:\s*"([^"]+)"/i);
    if (etagMatch) {
      const newETag = etagMatch[1];
      setCommitStatusETag(owner, repo, sha, newETag);
    }

    // CI status changed - cost: 1 REST point
    return true;
  } catch (err) {
    // On error, assume change to ensure we don't miss anything
    const errorMsg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console -- Observability logging for ETag errors
    console.warn(
      `[ETag Guard 2] Commit status check failed for ${commitKey}: ${errorMsg}`,
    );
    return true; // Assume changed to be safe
  }
}

/**
 * GraphQL fields to fetch for each PR.
 * This includes all data needed for orchestrator status detection.
 * Includes head SHA for ETag Guard 2 (commit status checks).
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
  reviews(last: 5) {
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

  // Pre-flight check to verify gh CLI is available
  await verifyGhCLI();

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

  const { stdout } = await execFileAsync("gh", args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: adaptiveTimeout,
  });

  const result: {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string; path?: string[] }>;
  } = JSON.parse(stdout.trim());

  // Check for GraphQL errors and throw to allow individual API fallback
  if (result.errors && result.errors.length > 0) {
    const errorMsg = result.errors.map((e) => e.message).join("; ");
    throw new Error(`GraphQL query errors: ${errorMsg}`);
  }

  return (result.data ?? {}) as Record<string, unknown>;
}

/**
 * Parse raw CI state from status check rollup.
 *
 * Uses only the top-level aggregate state, which is much cheaper
 * than fetching individual check contexts. The top-level state
 * provides the same semantic information (passing/failing/pending).
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

  // Extract CI status from commits
  const commits = pr["commits"] as
    | { nodes?: Array<{ commit?: { statusCheckRollup?: unknown } }> }
    | undefined;
  const ciStatus = commits?.nodes?.[0]?.commit?.statusCheckRollup
    ? parseCIState(commits.nodes[0].commit.statusCheckRollup)
    : "none";

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
    // No changes detected - skip expensive GraphQL queries
    // Return cached enrichment data instead of empty map
    for (const pr of prs) {
      const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
      const cachedData = prEnrichmentDataCache.get(prKey);
      if (cachedData) {
        result.set(prKey, cachedData);
      }
    }
    observer?.log(
      "info",
      `[ETag Guard] Skipping GraphQL batch - no changes detected. Returning ${result.size} cached PR enrichments. Reasons: ${guardResult.details.join(", ")}`,
    );
    return result;
  }

  observer?.log(
    "info",
    `[ETag Guard] Changes detected, running GraphQL batch. Reasons: ${guardResult.details.join(", ")}`,
  );

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
          // Remove from cache so individual fallback handles it
          result.delete(prKey);
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

      // Batch partially failed - log but continue with individual fallbacks
      // We don't throw to avoid losing all batch results
      // Individual PRs that succeed via fallback will populate cache for next poll
      const errorMsg = err instanceof Error ? err.message : String(err);
      const error = new Error(`Batch enrichment partially failed: ${errorMsg}`) as ErrorWithCause;
      if (err instanceof Error) {
        error.cause = err;
      }

      // Record failure for observability
      observer?.recordFailure({
        batchIndex,
        totalBatches: batches.length,
        prCount: batch.length,
        error: errorMsg,
        durationMs: batchDuration,
      });

      // Log the error for observability but don't fail entirely
      // eslint-disable-next-line no-console -- Observability logging for batch errors
      console.error(`[GraphQL Batch Warning] ${error.message}`);

      // Continue with next batch - failed PRs will use individual fallback
      // We don't throw here, letting the loop continue
    }
  }

  return result;
}

// Export internal functions for testing
export {
  parseCIState,
  parseReviewDecision,
  parsePRState,
  extractPREnrichment,
  checkPRListETag,
  checkCommitStatusETag,
  // shouldRefreshPREnrichment is already exported as async function
  updatePRMetadataCache,
};

// Export types for testing
export type { ETagCache, ETagGuardResult };
