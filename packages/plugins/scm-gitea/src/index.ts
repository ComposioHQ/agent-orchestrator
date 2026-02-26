/**
 * scm-gitea plugin — Gitea Pull Requests, CI, Reviews.
 *
 * Uses the Gitea REST API v1 via fetch().
 * Auth: GITEA_TOKEN env var, sent as `Authorization: token {token}`.
 * Host: GITEA_HOST env var (e.g., https://gitea.example.com).
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

const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHost(): string {
  const host = process.env["GITEA_HOST"];
  if (!host) {
    throw new Error("GITEA_HOST environment variable is required");
  }
  return host.replace(/\/+$/, "");
}

function getToken(): string {
  const token = process.env["GITEA_TOKEN"];
  if (!token) {
    throw new Error("GITEA_TOKEN environment variable is required");
  }
  return token;
}

async function giteaFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = `${getHost()}/api/v1${path}`;
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `token ${getToken()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Gitea API ${resp.status}: ${resp.statusText} — ${body}`);
    }

    if (resp.status === 204) return undefined as T;

    const text = await resp.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("Failed to parse Gitea API response as JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

function repoPath(pr: PRInfo): string {
  return `/repos/${pr.owner}/${pr.repo}`;
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

/** Check if a username looks like a bot account */
function isBotUser(login: string): boolean {
  const lower = login.toLowerCase();
  return lower.includes("bot") || lower.includes("[bot]");
}

// ---------------------------------------------------------------------------
// Gitea API response types
// ---------------------------------------------------------------------------

interface GiteaPullRequest {
  number: number;
  title: string;
  state: string; // "open", "closed"
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
  user: { login: string };
  additions: number;
  deletions: number;
  mergeable: boolean | null;
  draft: boolean;
}

interface GiteaCommitStatus {
  id: number;
  context: string;
  status: string; // "pending", "success", "error", "failure", "warning"
  target_url: string;
  description: string;
  created_at: string;
  updated_at: string;
}

interface GiteaReview {
  id: number;
  user: { login: string };
  state: string; // "APPROVED", "REQUEST_CHANGES", "COMMENT", "REQUEST_REVIEW", "PENDING"
  body: string;
  submitted_at: string;
}

interface GiteaComment {
  id: number;
  user: { login: string };
  body: string;
  path: string;
  line: number | null;
  created_at: string;
  html_url: string;
  resolver: unknown | null;
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createGiteaSCM(): SCM {
  return {
    name: "gitea",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const parts = project.repo.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format "${project.repo}", expected "owner/repo"`);
      }
      const [owner, repo] = parts;

      try {
        const prs = await giteaFetch<GiteaPullRequest[]>(
          `/repos/${owner}/${repo}/pulls?state=open&limit=50`,
        );

        // Filter by head branch (Gitea's API may not support head query param directly)
        const match = prs.find((pr) => pr.head.ref === session.branch);
        if (!match) return null;

        return {
          number: match.number,
          url: match.html_url,
          title: match.title,
          owner,
          repo,
          branch: match.head.ref,
          baseBranch: match.base.ref,
          isDraft: match.draft ?? false,
        };
      } catch {
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const data = await giteaFetch<GiteaPullRequest>(
        `${repoPath(pr)}/pulls/${pr.number}`,
      );

      if (data.merged) return "merged";
      if (data.state === "closed") return "closed";
      return "open";
    },

    async getPRSummary(pr: PRInfo) {
      const data = await giteaFetch<GiteaPullRequest>(
        `${repoPath(pr)}/pulls/${pr.number}`,
      );

      let state: PRState;
      if (data.merged) state = "merged";
      else if (data.state === "closed") state = "closed";
      else state = "open";

      return {
        state,
        title: data.title ?? "",
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
      };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      // Gitea merge "Do" values: "merge", "rebase", "rebase-merge", "squash"
      const doMap: Record<MergeMethod, string> = {
        merge: "merge",
        rebase: "rebase",
        squash: "squash",
      };

      await giteaFetch(
        `${repoPath(pr)}/pulls/${pr.number}/merge`,
        {
          method: "POST",
          body: JSON.stringify({
            Do: doMap[method],
            delete_branch_after_merge: true,
          }),
        },
      );
    },

    async closePR(pr: PRInfo): Promise<void> {
      await giteaFetch(
        `${repoPath(pr)}/pulls/${pr.number}`,
        {
          method: "PATCH",
          body: JSON.stringify({ state: "closed" }),
        },
      );
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        // Get the head commit SHA from the PR
        const prData = await giteaFetch<GiteaPullRequest>(
          `${repoPath(pr)}/pulls/${pr.number}`,
        );
        const sha = prData.head.sha;

        // Get commit statuses for this SHA
        const statuses = await giteaFetch<GiteaCommitStatus[]>(
          `${repoPath(pr)}/statuses/${sha}`,
        );

        return statuses.map((s) => {
          let status: CICheck["status"];
          const st = s.status.toLowerCase();

          if (st === "success") {
            status = "passed";
          } else if (st === "error" || st === "failure") {
            status = "failed";
          } else if (st === "pending") {
            status = "pending";
          } else if (st === "warning") {
            status = "passed"; // Treat warnings as passed
          } else {
            status = "failed";
          }

          return {
            name: s.context || s.description,
            status,
            url: s.target_url || undefined,
            conclusion: s.status,
            startedAt: s.created_at ? new Date(s.created_at) : undefined,
            completedAt: s.updated_at ? new Date(s.updated_at) : undefined,
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
        const reviews = await giteaFetch<GiteaReview[]>(
          `${repoPath(pr)}/pulls/${pr.number}/reviews`,
        );

        return reviews.map((r) => {
          let state: Review["state"];
          const s = (r.state ?? "").toUpperCase();

          if (s === "APPROVED") state = "approved";
          else if (s === "REQUEST_CHANGES") state = "changes_requested";
          else if (s === "PENDING") state = "pending";
          else if (s === "DISMISSED" || s === "REQUEST_REVIEW") state = "dismissed";
          else state = "commented";

          return {
            author: r.user?.login ?? "unknown",
            state,
            body: r.body || undefined,
            submittedAt: parseDate(r.submitted_at),
          };
        });
      } catch {
        return [];
      }
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const reviews = await this.getReviews(pr);
      if (reviews.length === 0) return "none";

      // Build a map of latest review per author (most recent wins)
      const latestByAuthor = new Map<string, Review>();
      for (const review of reviews) {
        const existing = latestByAuthor.get(review.author);
        if (!existing || review.submittedAt > existing.submittedAt) {
          latestByAuthor.set(review.author, review);
        }
      }

      const latest = [...latestByAuthor.values()];
      const hasChangesRequested = latest.some((r) => r.state === "changes_requested");
      if (hasChangesRequested) return "changes_requested";

      const hasApproved = latest.some((r) => r.state === "approved");
      if (hasApproved) return "approved";

      if (latest.length > 0) return "pending";
      return "none";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        const comments = await giteaFetch<GiteaComment[]>(
          `${repoPath(pr)}/pulls/${pr.number}/comments`,
        );

        return comments
          .filter((c) => {
            // Only include file-level comments that are unresolved
            if (!c.path) return false;
            if (c.resolver) return false; // resolved
            if (isBotUser(c.user?.login ?? "")) return false;
            return true;
          })
          .map((c) => ({
            id: String(c.id),
            author: c.user?.login ?? "unknown",
            body: c.body,
            path: c.path || undefined,
            line: c.line ?? undefined,
            isResolved: false,
            createdAt: parseDate(c.created_at),
            url: c.html_url ?? "",
          }));
      } catch {
        return [];
      }
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        const comments = await giteaFetch<GiteaComment[]>(
          `${repoPath(pr)}/pulls/${pr.number}/comments`,
        );

        return comments
          .filter((c) => isBotUser(c.user?.login ?? ""))
          .map((c) => ({
            id: String(c.id),
            botName: c.user?.login ?? "unknown",
            body: c.body,
            path: c.path || undefined,
            line: c.line ?? undefined,
            severity: determineSeverity(c.body),
            createdAt: parseDate(c.created_at),
            url: c.html_url ?? "",
          }));
      } catch {
        return [];
      }
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const blockers: string[] = [];

      const prData = await giteaFetch<GiteaPullRequest>(
        `${repoPath(pr)}/pulls/${pr.number}`,
      );

      if (prData.merged) {
        return {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        };
      }

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
      }

      // Merge conflicts
      const noConflicts = prData.mergeable !== false;
      if (prData.mergeable === false) {
        blockers.push("Merge conflicts");
      } else if (prData.mergeable === null) {
        blockers.push("Merge status unknown");
      }

      // Draft
      if (prData.draft) {
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
  name: "gitea",
  slot: "scm" as const,
  description: "SCM plugin: Gitea Pull Requests, CI, Reviews",
  version: "0.1.0",
};

export function create(): SCM {
  return createGiteaSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
