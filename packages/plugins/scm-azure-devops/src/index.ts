/**
 * scm-azure-devops plugin — Azure DevOps Pull Requests, Build Pipelines, Reviews.
 *
 * Uses the Azure DevOps REST API via fetch() with Personal Access Token (PAT) auth.
 * Auth: Basic auth with empty username + AZURE_DEVOPS_PAT as password.
 * Requires AZURE_DEVOPS_ORG env var for the organization name.
 * Repo format: "project/repo" (Azure DevOps repos are scoped under projects).
 */

import {
  CI_STATUS,
  type PluginModule,
  type SCM,
  type Session,
  type ProjectConfig,
  type PRInfo,
  type PRState,
  type MergeMethod,
  type CICheck,
  type CIStatus,
  type Review,
  type ReviewDecision,
  type ReviewComment,
  type AutomatedComment,
  type MergeReadiness,
} from "@composio/ao-core";

const API_VERSION = "7.1";
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConfig(): { org: string; pat: string } {
  const org = process.env["AZURE_DEVOPS_ORG"];
  const pat = process.env["AZURE_DEVOPS_PAT"];
  if (!org) {
    throw new Error("AZURE_DEVOPS_ORG environment variable is required");
  }
  if (!pat) {
    throw new Error("AZURE_DEVOPS_PAT environment variable is required");
  }
  return { org, pat };
}

function authHeader(): string {
  const { pat } = getConfig();
  // Azure DevOps Basic auth: empty username + PAT as password
  const encoded = Buffer.from(`:${pat}`).toString("base64");
  return `Basic ${encoded}`;
}

/**
 * Parse project and repo from the "project/repo" format.
 * Azure DevOps repos are scoped under projects.
 */
function parseRepo(repoStr: string): { project: string; repo: string } {
  const parts = repoStr.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format "${repoStr}", expected "project/repo"`);
  }
  return { project: parts[0], repo: parts[1] };
}

function gitApiBase(project: string, repo: string): string {
  const { org } = getConfig();
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
}

function buildApiBase(project: string): string {
  const { org } = getConfig();
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/build/builds`;
}

async function adoFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const separator = url.includes("?") ? "&" : "?";
    const fullUrl = `${url}${separator}api-version=${API_VERSION}`;

    const resp = await fetch(fullUrl, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Azure DevOps API ${resp.status}: ${resp.statusText} — ${body}`);
    }

    if (resp.status === 204) return undefined as T;

    const text = await resp.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("Failed to parse Azure DevOps API response as JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function determineSeverity(body: string): AutomatedComment["severity"] {
  const lower = body.toLowerCase();
  if (
    lower.includes("error") ||
    lower.includes("bug") ||
    lower.includes("critical") ||
    lower.includes("potential issue")
  ) {
    return "error";
  }
  if (
    lower.includes("warning") ||
    lower.includes("suggest") ||
    lower.includes("consider")
  ) {
    return "warning";
  }
  return "info";
}

/** Strip Azure DevOps ref prefix (refs/heads/) */
function stripRefPrefix(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

// ---------------------------------------------------------------------------
// Azure DevOps API response types
// ---------------------------------------------------------------------------

interface ADOPullRequest {
  pullRequestId: number;
  title: string;
  status: string; // "active", "completed", "abandoned"
  sourceRefName: string;
  targetRefName: string;
  isDraft: boolean;
  url: string;
  createdBy: { displayName: string; uniqueName: string };
  mergeStatus: string;
  reviewers: ADOReviewer[];
}

interface ADOReviewer {
  displayName: string;
  uniqueName: string;
  vote: number; // 10=approved, 5=approved with suggestions, -5=waiting, -10=rejected, 0=no vote
  isRequired: boolean;
}

interface ADOBuild {
  id: number;
  buildNumber: string;
  status: string; // "completed", "inProgress", "cancelling", "postponed", "notStarted", "none"
  result: string | null; // "succeeded", "partiallySucceeded", "failed", "canceled", "none"
  definition: { name: string };
  startTime: string;
  finishTime: string;
  _links: { web: { href: string } };
}

interface ADOThread {
  id: number;
  status: string; // "active", "byDesign", "closed", "fixed", "pending", "unknown", "wontFix"
  isDeleted: boolean;
  comments: Array<{
    id: number;
    author: { displayName: string; uniqueName: string };
    content: string;
    commentType: string; // "text", "system", "codeChange"
    publishedDate: string;
  }>;
  threadContext?: {
    filePath: string;
    rightFileStart?: { line: number };
  };
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createAzureDevOpsSCM(): SCM {
  return {
    name: "azure-devops",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const { project: adoProject, repo } = parseRepo(project.repo);

      try {
        const data = await adoFetch<{ value: ADOPullRequest[] }>(
          `${gitApiBase(adoProject, repo)}/pullrequests?searchCriteria.sourceRefName=refs/heads/${encodeURIComponent(session.branch)}&searchCriteria.status=active&$top=1`,
        );

        if (!data.value || data.value.length === 0) return null;

        const pr = data.value[0];
        const { org } = getConfig();
        const webUrl = `https://dev.azure.com/${org}/${encodeURIComponent(adoProject)}/_git/${encodeURIComponent(repo)}/pullrequest/${pr.pullRequestId}`;

        return {
          number: pr.pullRequestId,
          url: webUrl,
          title: pr.title,
          owner: adoProject,
          repo,
          branch: stripRefPrefix(pr.sourceRefName),
          baseBranch: stripRefPrefix(pr.targetRefName),
          isDraft: pr.isDraft ?? false,
        };
      } catch {
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const data = await adoFetch<ADOPullRequest>(
        `${gitApiBase(pr.owner, pr.repo)}/pullrequests/${pr.number}`,
      );

      const s = data.status.toLowerCase();
      if (s === "completed") return "merged";
      if (s === "abandoned") return "closed";
      return "open";
    },

    async getPRSummary(pr: PRInfo) {
      const data = await adoFetch<ADOPullRequest>(
        `${gitApiBase(pr.owner, pr.repo)}/pullrequests/${pr.number}`,
      );

      const s = data.status.toLowerCase();
      const state: PRState = s === "completed" ? "merged" : s === "abandoned" ? "closed" : "open";

      // Get iteration changes for additions/deletions
      let additions = 0;
      let deletions = 0;
      try {
        const iterations = await adoFetch<{
          value: Array<{ id: number }>;
        }>(
          `${gitApiBase(pr.owner, pr.repo)}/pullrequests/${pr.number}/iterations`,
        );

        if (iterations.value && iterations.value.length > 0) {
          const lastIteration = iterations.value[iterations.value.length - 1];
          const changes = await adoFetch<{
            changeEntries: Array<{ changeTrackingId: number }>;
          }>(
            `${gitApiBase(pr.owner, pr.repo)}/pullrequests/${pr.number}/iterations/${lastIteration.id}/changes`,
          );
          // Azure DevOps does not directly provide line counts in the changes endpoint;
          // approximate with file count
          additions = changes.changeEntries?.length ?? 0;
          deletions = 0;
        }
      } catch {
        // Best-effort
      }

      return {
        state,
        title: data.title ?? "",
        additions,
        deletions,
      };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      // Azure DevOps completionOptions.mergeStrategy:
      // 1 = noFastForward (merge commit)
      // 2 = rebase
      // 3 = squash
      // 4 = rebaseMerge
      const mergeStrategyMap: Record<MergeMethod, number> = {
        merge: 1,
        rebase: 2,
        squash: 3,
      };

      // Get the last merge source commit (required for completion)
      const prData = await adoFetch<{
        lastMergeSourceCommit: { commitId: string };
      }>(
        `${gitApiBase(pr.owner, pr.repo)}/pullrequests/${pr.number}`,
      );

      await adoFetch(
        `${gitApiBase(pr.owner, pr.repo)}/pullrequests/${pr.number}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "completed",
            lastMergeSourceCommit: prData.lastMergeSourceCommit,
            completionOptions: {
              mergeStrategy: mergeStrategyMap[method],
              deleteSourceBranch: true,
            },
          }),
        },
      );
    },

    async closePR(pr: PRInfo): Promise<void> {
      await adoFetch(
        `${gitApiBase(pr.owner, pr.repo)}/pullrequests/${pr.number}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "abandoned",
          }),
        },
      );
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        const data = await adoFetch<{ value: ADOBuild[] }>(
          `${buildApiBase(pr.owner)}?branchName=refs/heads/${encodeURIComponent(pr.branch)}&$top=10&queryOrder=finishTimeDescending`,
        );

        if (!data.value || data.value.length === 0) return [];

        return data.value.map((build) => {
          let status: CICheck["status"];
          const buildStatus = (build.status ?? "").toLowerCase();
          const buildResult = (build.result ?? "").toLowerCase();

          if (buildStatus === "completed") {
            if (buildResult === "succeeded") {
              status = "passed";
            } else if (buildResult === "failed") {
              status = "failed";
            } else if (buildResult === "canceled" || buildResult === "cancelled") {
              status = "skipped";
            } else if (buildResult === "partiallysucceeded") {
              status = "failed";
            } else {
              status = "failed";
            }
          } else if (buildStatus === "inprogress") {
            status = "running";
          } else if (buildStatus === "notstarted" || buildStatus === "postponed") {
            status = "pending";
          } else if (buildStatus === "cancelling") {
            status = "skipped";
          } else {
            status = "pending";
          }

          return {
            name: build.definition?.name ?? `Build #${build.buildNumber}`,
            status,
            url: build._links?.web?.href || undefined,
            conclusion: buildResult || buildStatus,
            startedAt: build.startTime ? new Date(build.startTime) : undefined,
            completedAt: build.finishTime ? new Date(build.finishTime) : undefined,
          };
        });
      } catch (err) {
        throw new Error("Failed to fetch CI checks", { cause: err });
      }
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch {
        try {
          const state = await this.getPRState(pr);
          if (state === "merged" || state === "closed") return "none";
        } catch {
          // Cannot determine state; fail closed
        }
        return "failing";
      }

      if (checks.length === 0) return "none";

      const hasFailing = checks.some((c) => c.status === "failed");
      if (hasFailing) return "failing";

      const hasPending = checks.some((c) => c.status === "pending" || c.status === "running");
      if (hasPending) return "pending";

      const hasPassing = checks.some((c) => c.status === "passed");
      if (!hasPassing) return "none";

      return "passing";
    },

    async getReviews(pr: PRInfo): Promise<Review[]> {
      try {
        const data = await adoFetch<ADOPullRequest>(
          `${gitApiBase(pr.owner, pr.repo)}/pullrequests/${pr.number}`,
        );

        return (data.reviewers ?? []).map((reviewer) => {
          let state: Review["state"];
          const vote = reviewer.vote ?? 0;

          if (vote === 10 || vote === 5) {
            state = "approved";
          } else if (vote === -10) {
            state = "changes_requested";
          } else if (vote === -5) {
            state = "changes_requested";
          } else {
            state = "pending";
          }

          return {
            author: reviewer.uniqueName ?? reviewer.displayName ?? "unknown",
            state,
            submittedAt: new Date(),
          };
        });
      } catch {
        return [];
      }
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const reviews = await this.getReviews(pr);
      if (reviews.length === 0) return "none";

      const hasRejected = reviews.some((r) => r.state === "changes_requested");
      if (hasRejected) return "changes_requested";

      const hasApproved = reviews.some((r) => r.state === "approved");
      const allReviewed = reviews.every(
        (r) => r.state === "approved" || r.state === "commented",
      );
      if (hasApproved && allReviewed) return "approved";

      return "pending";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        const data = await adoFetch<{ value: ADOThread[] }>(
          `${gitApiBase(pr.owner, pr.repo)}/pullrequests/${pr.number}/threads`,
        );

        const comments: ReviewComment[] = [];
        const { org } = getConfig();

        for (const thread of data.value ?? []) {
          if (thread.isDeleted) continue;

          // Only include active/pending threads (unresolved)
          const isResolved =
            thread.status === "closed" ||
            thread.status === "fixed" ||
            thread.status === "byDesign" ||
            thread.status === "wontFix";
          if (isResolved) continue;

          // Get the first non-system comment
          const firstComment = thread.comments?.find(
            (c) => c.commentType !== "system",
          );
          if (!firstComment) continue;

          // Skip bot/automated comments
          const authorName = firstComment.author?.uniqueName ?? "";
          if (
            authorName.includes("[bot]") ||
            authorName.includes("build service") ||
            authorName.includes("service account")
          ) continue;

          comments.push({
            id: String(thread.id),
            author: firstComment.author?.displayName ?? "unknown",
            body: firstComment.content ?? "",
            path: thread.threadContext?.filePath || undefined,
            line: thread.threadContext?.rightFileStart?.line ?? undefined,
            isResolved: false,
            createdAt: parseDate(firstComment.publishedDate),
            url: `https://dev.azure.com/${org}/${encodeURIComponent(pr.owner)}/_git/${encodeURIComponent(pr.repo)}/pullrequest/${pr.number}`,
          });
        }

        return comments;
      } catch {
        return [];
      }
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        const data = await adoFetch<{ value: ADOThread[] }>(
          `${gitApiBase(pr.owner, pr.repo)}/pullrequests/${pr.number}/threads`,
        );

        const automated: AutomatedComment[] = [];
        const { org } = getConfig();

        for (const thread of data.value ?? []) {
          if (thread.isDeleted) continue;

          for (const comment of thread.comments ?? []) {
            if (comment.commentType === "system") continue;

            const authorName = comment.author?.uniqueName ?? "";
            const isBot =
              authorName.includes("[bot]") ||
              authorName.includes("build service") ||
              authorName.includes("@azure.com") ||
              authorName.includes("service account");
            if (!isBot) continue;

            automated.push({
              id: String(comment.id),
              botName: comment.author?.displayName ?? "system",
              body: comment.content ?? "",
              path: thread.threadContext?.filePath || undefined,
              line: thread.threadContext?.rightFileStart?.line ?? undefined,
              severity: determineSeverity(comment.content ?? ""),
              createdAt: parseDate(comment.publishedDate),
              url: `https://dev.azure.com/${org}/${encodeURIComponent(pr.owner)}/_git/${encodeURIComponent(pr.repo)}/pullrequest/${pr.number}`,
            });
          }
        }

        return automated;
      } catch {
        return [];
      }
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const blockers: string[] = [];

      const state = await this.getPRState(pr);
      if (state === "merged") {
        return {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        };
      }

      // Fetch PR details for merge status
      const data = await adoFetch<ADOPullRequest>(
        `${gitApiBase(pr.owner, pr.repo)}/pullrequests/${pr.number}`,
      );

      // CI
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      // Reviews
      const reviewDecision = await this.getReviewDecision(pr);
      const approved = reviewDecision === "approved";
      if (reviewDecision === "changes_requested") {
        blockers.push("Changes requested in review");
      } else if (reviewDecision === "pending") {
        blockers.push("Review pending");
      }

      // Conflicts
      const mergeStatus = (data.mergeStatus ?? "").toLowerCase();
      const noConflicts = mergeStatus !== "conflicts";
      if (mergeStatus === "conflicts") {
        blockers.push("Merge conflicts");
      } else if (mergeStatus === "failure") {
        blockers.push("Merge check failed");
      } else if (mergeStatus === "rejectedbypolicy") {
        blockers.push("Rejected by branch policy");
      }

      // Draft
      if (data.isDraft) {
        blockers.push("PR is still a draft");
      }

      return {
        mergeable: blockers.length === 0,
        ciPassing,
        approved,
        noConflicts,
        blockers,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "azure-devops",
  slot: "scm" as const,
  description: "SCM plugin: Azure DevOps Pull Requests, Build Pipelines, Reviews",
  version: "0.1.0",
};

export function create(): SCM {
  return createAzureDevOpsSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
