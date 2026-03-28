/**
 * REST Parallel PR Enrichment
 *
 * Fetches PR data using parallel REST API calls with 2-Guard ETag strategy.
 * This is an alternative to GraphQL batching for A/B testing API strategies.
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

// Reuse ETag guard functions and caches from graphql-batch.ts
import {
  shouldRefreshPREnrichment,
  getPREnrichmentDataCache,
  clearETagCache,
  clearPRMetadataCache,
  updatePRMetadataCache,
  type BatchObserver,
} from "./graphql-batch.js";

let execFileAsync = promisify(execFile);

/**
 * Set execFileAsync for testing.
 * Allows mocking of underlying execFile in unit tests.
 */
export function setExecFileAsync(fn: typeof execFileAsync): void {
  execFileAsync = fn;
}

/**
 * Maximum number of concurrent REST API calls.
 * Limits parallelism to avoid overwhelming GitHub API.
 */
export const PARALLEL_CONCURRENCY = 10;

/**
 * Interface for errors with cause property (ES2022+).
 * Used for better error tracking when cause is not available in older environments.
 */
interface ErrorWithCause extends Error {
  cause?: unknown;
}

/**
 * PR state data fetched from REST API.
 */
interface PRStateData {
  state: PRState;
  title?: string;
  additions?: number;
  deletions?: number;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: ReviewDecision;
  headRefOid?: string;
}

/**
 * CI status data fetched from REST API.
 */
interface CIData {
  state: CIStatus;
}

/**
 * Helper to execute gh CLI commands.
 */
async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${errorMsg}`, {
      cause: err,
    });
  }
}

/**
 * Parse PR state from REST API response.
 */
function parsePRState(state: string): PRState {
  const s = state.toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed";
  return "open";
}

/**
 * Parse review decision from REST API response.
 */
function parseReviewDecision(reviewDecision: string): ReviewDecision {
  const d = reviewDecision.toUpperCase();
  if (d === "APPROVED") return "approved";
  if (d === "CHANGES_REQUESTED") return "changes_requested";
  if (d === "REVIEW_REQUIRED") return "pending";
  return "none";
}

/**
 * Parse CI state from REST API status check rollup.
 */
function parseCIState(statusCheckRollup: unknown): CIStatus {
  if (!statusCheckRollup || typeof statusCheckRollup !== "object") {
    return "none";
  }

  const rollup = statusCheckRollup as Record<string, unknown>;
  const state = typeof rollup["state"] === "string" ? rollup["state"].toUpperCase() : "";

  // Map GitHub's statusCheckRollup.state to our CIStatus enum
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
 * Fetch PR data using REST API via gh CLI.
 * Fetches state, title, additions, deletions, isDraft, mergeable, mergeStateStatus, reviewDecision, and headSha.
 */
async function fetchPRData(pr: PRInfo): Promise<PRStateData | null> {
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

    const data = JSON.parse(raw);

    return {
      state: parsePRState(data.state),
      title: data.title,
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
      isDraft: data.isDraft ?? false,
      mergeable: data.mergeable?.toUpperCase(),
      mergeStateStatus: data.mergeStateStatus?.toUpperCase(),
      reviewDecision: parseReviewDecision(data.reviewDecision ?? ""),
      headRefOid: data.headRefOid,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch CI status using REST API via gh CLI.
 * Uses statusCheckRollup for efficient CI status determination.
 */
async function fetchCIData(pr: PRInfo): Promise<CIData | null> {
  try {
    const raw = await gh([
      "pr",
      "view",
      String(pr.number),
      "--repo",
      `${pr.owner}/${pr.repo}`,
      "--json",
      "statusCheckRollup",
    ]);

    const data = JSON.parse(raw);
    const statusCheckRollup = data.statusCheckRollup;

    return {
      state: parseCIState(statusCheckRollup),
    };
  } catch {
    return null;
  }
}

/**
 * Determine if PR is mergeable based on enrichment data.
 */
function isMergeReady(prData: PRStateData, ciData: CIData): {
  mergeable: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];

  // State check
  if (prData.state !== "open") {
    return { mergeable: false, blockers: [] };
  }

  // CI check - treat "none" as passing (no CI checks configured)
  const ciPassing = ciData.state === "passing" || ciData.state === "none";
  if (!ciPassing) {
    blockers.push(`CI is ${ciData.state}`);
  }

  // Reviews
  const reviewDecision = prData.reviewDecision ?? "none";
  if (reviewDecision === "changes_requested") {
    blockers.push("Changes requested in review");
  } else if (reviewDecision === "pending") {
    blockers.push("Review required");
  }

  // Conflicts / merge state
  const mergeable = prData.mergeable;
  const mergeState = prData.mergeStateStatus ?? "";
  const hasConflicts = mergeable === "CONFLICTING";
  const isBehind = mergeState === "BEHIND";

  if (hasConflicts) {
    blockers.push("Merge conflicts");
  } else if (mergeable === "UNKNOWN" || mergeable === "") {
    blockers.push("Merge status unknown (GitHub is computing)");
  }

  if (isBehind) {
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

  const isMergeable =
    prData.state === "open" &&
    ciPassing &&
    (reviewDecision === "approved" || reviewDecision === "none") &&
    !hasConflicts &&
    !isBehind &&
    !prData.isDraft;

  return { mergeable: isMergeable, blockers };
}

/**
 * Fetch all enrichment data for a single PR using parallel REST calls.
 * Makes 3 REST API calls in parallel: PR data, CI data, and reviews.
 */
async function fetchSinglePREnrichment(
  pr: PRInfo,
  observer?: BatchObserver,
): Promise<{ prKey: string; data: PREnrichmentData; headSha: string | null } | null> {
  const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;

  try {
    // Run 3 REST calls in parallel using Promise.all
    const [prData, ciData] = await Promise.all([
      fetchPRData(pr),
      fetchCIData(pr),
    ]);

    // Handle null responses (PR not found, deleted, permission issues)
    if (!prData || !ciData) {
      return null;
    }

    // Extract head SHA for ETag Guard 2
    const headSha = prData.headRefOid ?? null;

    // Build merge readiness
    const { mergeable, blockers } = isMergeReady(prData, ciData);

    // Build PREnrichmentData object
    const data: PREnrichmentData = {
      state: prData.state,
      ciStatus: ciData.state,
      reviewDecision: prData.reviewDecision ?? "none",
      mergeable,
      title: prData.title,
      additions: prData.additions ?? 0,
      deletions: prData.deletions ?? 0,
      isDraft: prData.isDraft ?? false,
      hasConflicts: prData.mergeable === "CONFLICTING",
      isBehind: prData.mergeStateStatus === "BEHIND",
      blockers,
    };

    return { prKey, data, headSha };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    observer?.log("warn", `[REST Parallel] Failed to enrich ${prKey}: ${errorMsg}`);
    return null;
  }
}

/**
 * Process PRs in parallel batches with concurrency limit.
 */
async function processPRsInBatches(
  prs: PRInfo[],
  observer?: BatchObserver,
): Promise<Map<string, PREnrichmentData>> {
  const result = new Map<string, PREnrichmentData>();
  const batches: PRInfo[][] = [];

  // Split into batches with concurrency limit
  for (let i = 0; i < prs.length; i += PARALLEL_CONCURRENCY) {
    batches.push(prs.slice(i, i + PARALLEL_CONCURRENCY));
  }

  // Process each batch in sequence, with parallel execution within each batch
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const batchStartTime = Date.now();

    // Process batch in parallel using Promise.allSettled for fault tolerance
    const settlements = await Promise.allSettled(
      batch.map((pr) => fetchSinglePREnrichment(pr, observer))
    );

    // Handle results - only include successful ones
    for (const settlement of settlements) {
      if (settlement.status === "fulfilled" && settlement.value) {
        const { prKey, data, headSha } = settlement.value;
        result.set(prKey, data);
        // Update PR metadata cache for future ETag checks
        updatePRMetadataCache(prKey, data, headSha);
      }
      // Silently skip failed PRs - they'll be retried on next poll
    }

    const batchDuration = Date.now() - batchStartTime;
    const successCount = settlements.filter(
      (s) => s.status === "fulfilled" && s.value !== null
    ).length;

    observer?.recordSuccess({
      batchIndex,
      totalBatches: batches.length,
      prCount: successCount,
      durationMs: batchDuration,
    });

    observer?.log(
      "info",
      `[REST Parallel] Batch ${batchIndex + 1}/${batches.length} completed: ${successCount}/${batch.length} PRs enriched (${batchDuration}ms)`,
    );
  }

  return result;
}

/**
 * Main REST parallel enrichment function with 2-Guard ETag Strategy.
 *
 * Before running expensive REST API calls, uses the same 2-Guard ETag strategy
 * as GraphQL batching:
 *
 * 1. Guard 1: PR List ETag Check (per repo)
 *    - Detects PR metadata changes (commits, reviews, labels, state)
 *    - Cost: 1 REST point if changed, 0 if unchanged (304)
 *
 * 2. Guard 2: Commit Status ETag Check (per PR with cached metadata)
 *    - Detects CI status changes
 *    - Cost: 1 REST point if changed, 0 if unchanged (304)
 *
 * If guards indicate no changes, skips REST calls entirely.
 * If any guard detects a change, runs parallel REST API calls.
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
    // No changes detected - return cached enrichment data
    const enrichmentCache = getPREnrichmentDataCache();
    for (const pr of prs) {
      const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
      const cachedData = enrichmentCache.get(prKey);
      if (cachedData) {
        result.set(prKey, cachedData);
      }
    }
    observer?.log(
      "info",
      `[ETag Guard] Skipping REST parallel - no changes detected. Returning ${result.size} cached PR enrichments. Reasons: ${guardResult.details.join(", ")}`,
    );
    return result;
  }

  observer?.log(
    "info",
    `[ETag Guard] Changes detected, running REST parallel. Reasons: ${guardResult.details.join(", ")}`,
  );

  // Step 2: Process PRs in parallel batches
  return processPRsInBatches(prs, observer);
}
