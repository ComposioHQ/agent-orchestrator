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
 */
export function extractPREnrichment(
  pullRequest: unknown,
): PREnrichmentData | null {
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

  return {
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
}

/**
 * Main batch enrichment function.
 *
 * Fetches data for multiple PRs in one or more GraphQL queries.
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

  // Split into batches if we have too many PRs
  const batches: PRInfo[][] = [];
  for (let i = 0; i < prs.length; i += MAX_BATCH_SIZE) {
    batches.push(prs.slice(i, i + MAX_BATCH_SIZE));
  }

  // Execute each batch
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
          const enrichment = extractPREnrichment(repositoryData.pullRequest);
          if (enrichment) {
            result.set(prKey, enrichment);
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
export { parseCIState, parseReviewDecision, parsePRState, extractPREnrichment };
