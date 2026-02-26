/**
 * scm-bitbucket plugin — Bitbucket Pull Requests, Pipelines, Reviews.
 *
 * Uses the Bitbucket REST API v2 via fetch() with Basic auth.
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

const BASE_URL = "https://api.bitbucket.org/2.0";
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAuth(): { username: string; password: string } {
  const username = process.env["BITBUCKET_USERNAME"];
  const password = process.env["BITBUCKET_APP_PASSWORD"];
  if (!username || !password) {
    throw new Error(
      "BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD environment variables are required",
    );
  }
  return { username, password };
}

function authHeader(): string {
  const { username, password } = getAuth();
  const encoded = Buffer.from(`${username}:${password}`).toString("base64");
  return `Basic ${encoded}`;
}

async function bbFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Bitbucket API ${resp.status}: ${resp.statusText} — ${body}`);
    }

    // For DELETE/204 responses with no body
    if (resp.status === 204) return undefined as T;

    const text = await resp.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Failed to parse Bitbucket API response as JSON`);
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

/** Known bot-like account patterns on Bitbucket */
function isBotUser(username: string): boolean {
  const lower = username.toLowerCase();
  return (
    lower.includes("bot") ||
    lower.includes("pipeline") ||
    lower.includes("ci-") ||
    lower.includes("codecov") ||
    lower.includes("sonar") ||
    lower.includes("dependabot") ||
    lower.includes("renovate")
  );
}

// ---------------------------------------------------------------------------
// Bitbucket API types
// ---------------------------------------------------------------------------

interface BBPullRequest {
  id: number;
  title: string;
  state: string;
  source: { branch: { name: string } };
  destination: { branch: { name: string } };
  links: { html: { href: string } };
  author: { display_name: string; nickname: string };
}

interface BBPipeline {
  uuid: string;
  state: {
    name: string;
    result?: { name: string };
  };
  target: { ref_name: string };
  created_on: string;
  completed_on: string | null;
  build_number: number;
}

interface BBComment {
  id: number;
  user: { display_name: string; nickname: string };
  content: { raw: string };
  inline?: { path: string; to?: number };
  created_on: string;
  links: { html: { href: string } };
}

interface BBParticipant {
  user: { display_name: string; nickname: string };
  role: string;
  approved: boolean;
  state: string | null;
  participated_on: string;
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createBitbucketSCM(): SCM {
  return {
    name: "bitbucket",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const parts = project.repo.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format "${project.repo}", expected "workspace/repo_slug"`);
      }
      const [owner, repo] = parts;

      try {
        const data = await bbFetch<{ values: BBPullRequest[] }>(
          `/repositories/${owner}/${repo}/pullrequests?q=source.branch.name="${session.branch}"&state=OPEN&pagelen=1`,
        );

        if (!data.values || data.values.length === 0) return null;

        const pr = data.values[0];
        return {
          number: pr.id,
          url: pr.links.html.href,
          title: pr.title,
          owner,
          repo,
          branch: pr.source.branch.name,
          baseBranch: pr.destination.branch.name,
          isDraft: false, // Bitbucket does not have draft PRs natively
        };
      } catch {
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const data = await bbFetch<BBPullRequest>(
        `/repositories/${pr.owner}/${pr.repo}/pullrequests/${pr.number}`,
      );

      const s = data.state.toUpperCase();
      if (s === "MERGED") return "merged";
      if (s === "DECLINED" || s === "SUPERSEDED") return "closed";
      return "open";
    },

    async getPRSummary(pr: PRInfo) {
      const data = await bbFetch<BBPullRequest & {
        title: string;
      }>(
        `/repositories/${pr.owner}/${pr.repo}/pullrequests/${pr.number}`,
      );

      const s = data.state.toUpperCase();
      const state: PRState = s === "MERGED" ? "merged" : s === "DECLINED" || s === "SUPERSEDED" ? "closed" : "open";

      // Bitbucket diffstat for additions/deletions
      let additions = 0;
      let deletions = 0;
      try {
        const diffstat = await bbFetch<{
          values: Array<{
            lines_added: number;
            lines_removed: number;
          }>;
        }>(
          `/repositories/${pr.owner}/${pr.repo}/pullrequests/${pr.number}/diffstat`,
        );

        for (const entry of diffstat.values ?? []) {
          additions += entry.lines_added ?? 0;
          deletions += entry.lines_removed ?? 0;
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
      // Bitbucket merge strategies: merge_commit, squash, fast_forward
      let strategy: string;
      if (method === "squash") {
        strategy = "squash";
      } else if (method === "rebase") {
        strategy = "fast_forward";
      } else {
        strategy = "merge_commit";
      }

      await bbFetch(
        `/repositories/${pr.owner}/${pr.repo}/pullrequests/${pr.number}/merge`,
        {
          method: "POST",
          body: JSON.stringify({
            merge_strategy: strategy,
            close_source_branch: true,
          }),
        },
      );
    },

    async closePR(pr: PRInfo): Promise<void> {
      await bbFetch(
        `/repositories/${pr.owner}/${pr.repo}/pullrequests/${pr.number}/decline`,
        { method: "POST" },
      );
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        // Bitbucket uses pipelines; get recent pipelines for the PR branch
        const data = await bbFetch<{ values: BBPipeline[] }>(
          `/repositories/${pr.owner}/${pr.repo}/pipelines/?sort=-created_on&pagelen=20`,
        );

        // Filter pipelines for this branch
        const branchPipelines = (data.values ?? []).filter(
          (p) => p.target?.ref_name === pr.branch,
        );

        if (branchPipelines.length === 0) return [];

        // Use the most recent pipeline
        const latest = branchPipelines[0];

        // Map pipeline state to CICheck
        let status: CICheck["status"];
        const stateName = latest.state?.name?.toUpperCase() ?? "";
        const resultName = latest.state?.result?.name?.toUpperCase() ?? "";

        if (stateName === "COMPLETED") {
          if (resultName === "SUCCESSFUL") {
            status = "passed";
          } else if (resultName === "FAILED" || resultName === "ERROR") {
            status = "failed";
          } else if (resultName === "STOPPED") {
            status = "skipped";
          } else {
            status = "failed";
          }
        } else if (stateName === "IN_PROGRESS" || stateName === "RUNNING") {
          status = "running";
        } else if (stateName === "PENDING") {
          status = "pending";
        } else {
          status = "pending";
        }

        return [
          {
            name: `Pipeline #${latest.build_number}`,
            status,
            url: `https://bitbucket.org/${pr.owner}/${pr.repo}/pipelines/results/${latest.build_number}`,
            conclusion: resultName || stateName,
            startedAt: latest.created_on ? new Date(latest.created_on) : undefined,
            completedAt: latest.completed_on ? new Date(latest.completed_on) : undefined,
          },
        ];
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
        const data = await bbFetch<BBPullRequest & {
          participants: BBParticipant[];
        }>(
          `/repositories/${pr.owner}/${pr.repo}/pullrequests/${pr.number}`,
        );

        const participants = data.participants ?? [];

        return participants
          .filter((p) => p.role === "REVIEWER")
          .map((p) => {
            let state: Review["state"];
            if (p.approved) {
              state = "approved";
            } else if (p.state === "changes_requested") {
              state = "changes_requested";
            } else {
              state = "commented";
            }

            return {
              author: p.user?.nickname ?? p.user?.display_name ?? "unknown",
              state,
              submittedAt: parseDate(p.participated_on),
            };
          });
      } catch {
        return [];
      }
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const reviews = await this.getReviews(pr);
      if (reviews.length === 0) return "none";

      const hasChangesRequested = reviews.some((r) => r.state === "changes_requested");
      if (hasChangesRequested) return "changes_requested";

      const hasApproved = reviews.some((r) => r.state === "approved");
      if (hasApproved) return "approved";

      return "pending";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        const data = await bbFetch<{ values: BBComment[] }>(
          `/repositories/${pr.owner}/${pr.repo}/pullrequests/${pr.number}/comments?pagelen=100`,
        );

        return (data.values ?? [])
          .filter((c) => {
            const nickname = c.user?.nickname ?? "";
            return !isBotUser(nickname) && c.inline !== undefined;
          })
          .map((c) => ({
            id: String(c.id),
            author: c.user?.nickname ?? c.user?.display_name ?? "unknown",
            body: c.content?.raw ?? "",
            path: c.inline?.path || undefined,
            line: c.inline?.to ?? undefined,
            isResolved: false, // Bitbucket API v2 does not natively track resolved state for inline comments
            createdAt: parseDate(c.created_on),
            url: c.links?.html?.href ?? "",
          }));
      } catch {
        return [];
      }
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        const data = await bbFetch<{ values: BBComment[] }>(
          `/repositories/${pr.owner}/${pr.repo}/pullrequests/${pr.number}/comments?pagelen=100`,
        );

        return (data.values ?? [])
          .filter((c) => isBotUser(c.user?.nickname ?? ""))
          .map((c) => ({
            id: String(c.id),
            botName: c.user?.nickname ?? c.user?.display_name ?? "unknown",
            body: c.content?.raw ?? "",
            path: c.inline?.path || undefined,
            line: c.inline?.to ?? undefined,
            severity: determineSeverity(c.content?.raw ?? ""),
            createdAt: parseDate(c.created_on),
            url: c.links?.html?.href ?? "",
          }));
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

      // Conflicts — check via the merge endpoint check
      let noConflicts = true;
      try {
        const diffstat = await bbFetch<{
          values: Array<{ status: string }>;
        }>(
          `/repositories/${pr.owner}/${pr.repo}/pullrequests/${pr.number}/diffstat`,
        );
        // If diffstat succeeds, there are no conflicts at the API level
        // Bitbucket returns a conflict status in the PR itself
        const prData = await bbFetch<{
          state: string;
          merge_commit: unknown;
        }>(
          `/repositories/${pr.owner}/${pr.repo}/pullrequests/${pr.number}`,
        );

        // Bitbucket doesn't have a direct conflicts field in the API v2;
        // we infer from whether diffstat has entries with conflict status
        const hasConflict = (diffstat.values ?? []).some(
          (d) => d.status === "merge conflict",
        );
        if (hasConflict) {
          noConflicts = false;
          blockers.push("Merge conflicts");
        }
      } catch {
        noConflicts = false;
        blockers.push("Unable to determine conflict status");
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
  name: "bitbucket",
  slot: "scm" as const,
  description: "SCM plugin: Bitbucket Pull Requests, Pipelines, Reviews",
  version: "0.1.0",
};

export function create(): SCM {
  return createBitbucketSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
