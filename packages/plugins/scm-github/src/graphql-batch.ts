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
  PREnrichmentData,
  PRInfo,
  PRState,
  ReviewDecision,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

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
          contexts(first: 10) {
            nodes {
              ... on CheckRun {
                name
                status
                conclusion
              }
              ... on StatusContext {
                context
                state
              }
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

  const variableDefs = Object.keys(variables)
    .map((v) => {
      // PR numbers should be Int!, all others are String!
      if (v.endsWith("Number")) {
        return `$${v}: Int!`;
      }
      return `$${v}: String!`;
    })
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

  const { stdout } = await execFileAsync("gh", args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
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
 * Type for CheckRun context from GraphQL API.
 * CheckRun uses 'status' field (not 'state') and has 'conclusion'.
 */
interface CheckRunContext {
  name?: string;
  status?: string;
  conclusion?: string;
}

/**
 * Type for StatusContext from GraphQL API.
 * StatusContext uses 'state' field only (no 'conclusion').
 */
interface StatusContextType {
  context?: string;
  state?: string;
}

/**
 * Generic context type that handles union of CheckRun and StatusContext.
 * This allows more flexible parsing for test data and edge cases.
 */
type GenericContext = CheckRunContext | StatusContextType | { state?: string; conclusion?: string };

/**
 * Type guard to check if a context has 'status' field (CheckRun).
 */
function hasStatusField(ctx: GenericContext): ctx is CheckRunContext {
  return "status" in ctx;
}

/**
 * Type guard to check if a context has 'conclusion' field (CheckRun or hybrid).
 */
function hasConclusionField(ctx: GenericContext): ctx is CheckRunContext | { state?: string; conclusion?: string } {
  return "conclusion" in ctx;
}

/**
 * Parse raw CI state from status check rollup.
 */
function parseCIState(
  statusCheckRollup: unknown,
): CIStatus {
  if (!statusCheckRollup || typeof statusCheckRollup !== "object") {
    return "none";
  }

  const rollup = statusCheckRollup as Record<string, unknown>;
  const state = typeof rollup["state"] === "string" ? rollup["state"].toUpperCase() : "";

  // Check individual contexts for detailed state - this takes precedence over
  // the top-level state because contexts provide more granular information
  const contexts = rollup["contexts"] as
    | { nodes?: Array<GenericContext> }
    | undefined;
  if (contexts?.nodes && contexts.nodes.length > 0) {
    const hasFailing = contexts.nodes.some(
      (c) => {
        // Handle CheckRun (has 'status' field): check conclusion for failure
        if (hasStatusField(c)) {
          return (
            c.conclusion === "FAILURE" ||
            c.conclusion === "TIMED_OUT" ||
            c.conclusion === "ACTION_REQUIRED" ||
            c.conclusion === "CANCELLED" ||
            c.conclusion === "ERROR"
          );
        }
        // Handle StatusContext (has 'conclusion' field): check state for failure
        // This covers both pure StatusContext and hybrid test data
        if (hasConclusionField(c)) {
          return c.state === "FAILURE";
        }
        return false;
      },
    );
    if (hasFailing) return "failing";

    const hasPending = contexts.nodes.some(
      (c) => {
        // Handle CheckRun (has 'status' field): check status for pending
        if (hasStatusField(c)) {
          return (
            c.status === "PENDING" ||
            c.status === "QUEUED" ||
            c.status === "IN_PROGRESS" ||
            c.status === "EXPECTED" ||
            c.status === "WAITING"
          );
        }
        // Handle StatusContext (has 'conclusion' field): check state for pending
        if (hasConclusionField(c)) {
          return (
            c.state === "PENDING" ||
            c.state === "QUEUED" ||
            c.state === "IN_PROGRESS" ||
            c.state === "EXPECTED" ||
            c.state === "WAITING"
          );
        }
        return false;
      },
    );
    if (hasPending) return "pending";

    const hasPassing = contexts.nodes.some(
      (c) => {
        // Handle CheckRun (has 'status' field): check conclusion for success
        if (hasStatusField(c)) {
          return c.conclusion === "SUCCESS";
        }
        // Handle StatusContext (has 'conclusion' field): check state for success
        if (hasConclusionField(c)) {
          return c.state === "SUCCESS";
        }
        return false;
      },
    );
    if (hasPassing) return "passing";
  }

  // Fall back to top-level state if no contexts found
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
function extractPREnrichment(pullRequest: unknown): PREnrichmentData | null {
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
  for (const batch of batches) {
    try {
      const data = await executeBatchQuery(batch);

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
        }
        // PR not found (deleted/closed/permission issue)
        // Don't add to cache - let individual API fallback handle it
      });
    } catch (err) {
      // Batch failed - throw to allow individual API fallback
      // instead of populating fake data that would block fallback
      const errorMsg = err instanceof Error ? err.message : String(err);
      const error = new Error(`Batch enrichment failed: ${errorMsg}`);
      if (err instanceof Error) {
        error.cause = err;
      }
      throw error;
    }
  }

  return result;
}

// Export internal functions for testing
export { parseCIState, parseReviewDecision, parsePRState, extractPREnrichment };
