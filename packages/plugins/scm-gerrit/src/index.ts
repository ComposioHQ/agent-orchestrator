/**
 * scm-gerrit plugin — Gerrit code review: changes, patch sets, reviews, merge readiness.
 *
 * Uses the Gerrit REST API via fetch().
 * Auth: GERRIT_USERNAME + GERRIT_PASSWORD (Basic auth) or GERRIT_TOKEN.
 * Requires GERRIT_HOST env var.
 *
 * Gerrit terminology mapping:
 *   - "Change" = Pull Request
 *   - "Patch Set" = commit/revision
 *   - "Submit" = merge
 *   - "Abandon" = close
 *   - Code-Review label: -2..+2 (voting system)
 *   - Verified label: -1..+1
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function getHost(): string {
  const host = process.env["GERRIT_HOST"];
  if (!host) {
    throw new Error(
      "GERRIT_HOST environment variable is required for the Gerrit SCM plugin",
    );
  }
  return host.replace(/\/+$/, "");
}

function getAuthHeaders(): Record<string, string> {
  const token = process.env["GERRIT_TOKEN"];
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }

  const username = process.env["GERRIT_USERNAME"];
  const password = process.env["GERRIT_PASSWORD"];
  if (username && password) {
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }

  throw new Error(
    "Gerrit auth is required: set GERRIT_TOKEN or GERRIT_USERNAME + GERRIT_PASSWORD env vars",
  );
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

/**
 * Gerrit REST API returns JSON with a magic prefix `)]}'\n` that must be stripped.
 */
async function gerritFetch<T>(
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<T> {
  const host = getHost();
  const url = `${host}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const fetchOptions: RequestInit = {
      method: options.method ?? "GET",
      signal: controller.signal,
      headers: {
        ...getAuthHeaders(),
        Accept: "application/json",
      },
    };

    if (options.body) {
      fetchOptions.headers = {
        ...fetchOptions.headers,
        "Content-Type": "application/json",
      };
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Gerrit API returned HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    const text = await response.text();
    // Strip the Gerrit magic prefix )]}'
    const jsonText = text.replace(/^\)\]\}'\n/, "");

    try {
      return JSON.parse(jsonText) as T;
    } catch {
      throw new Error(`Failed to parse Gerrit response: ${jsonText.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Gerrit API types
// ---------------------------------------------------------------------------

interface GerritChange {
  _number: number;
  id: string;
  project: string;
  branch: string;
  topic?: string;
  subject: string;
  status: "NEW" | "MERGED" | "ABANDONED";
  mergeable?: boolean;
  submittable?: boolean;
  insertions: number;
  deletions: number;
  labels?: Record<string, GerritLabel>;
  current_revision?: string;
  revisions?: Record<string, GerritRevision>;
  owner: GerritAccount;
  _more_changes?: boolean;
}

interface GerritLabel {
  approved?: GerritAccount;
  rejected?: GerritAccount;
  recommended?: GerritAccount;
  disliked?: GerritAccount;
  all?: GerritLabelVote[];
  default_value?: number;
  blocking?: boolean;
}

interface GerritLabelVote {
  value: number;
  date: string;
  _account_id: number;
  name?: string;
  username?: string;
  email?: string;
}

interface GerritRevision {
  _number: number;
  ref: string;
  created: string;
}

interface GerritAccount {
  _account_id: number;
  name?: string;
  username?: string;
  email?: string;
}

interface GerritCommentInfo {
  id: string;
  author: GerritAccount;
  message: string;
  path?: string;
  line?: number;
  updated: string;
  unresolved?: boolean;
  robot_id?: string;
  robot_run_id?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gerritStateTopr(status: GerritChange["status"]): PRState {
  switch (status) {
    case "MERGED":
      return "merged";
    case "ABANDONED":
      return "closed";
    case "NEW":
    default:
      return "open";
  }
}

function parseGerritDate(dateStr: string): Date {
  // Gerrit dates: "2024-01-15 10:30:00.000000000"
  const cleaned = dateStr.replace(/\.\d+$/, "").replace(" ", "T") + "Z";
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function changeUrl(changeNumber: number): string {
  return `${getHost()}/c/${changeNumber}`;
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createGerritSCM(): SCM {
  return {
    name: "gerrit",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const gerritProject = project.scm?.["project"] as string | undefined ?? project.repo;

      try {
        const query = `project:${gerritProject}+branch:${project.defaultBranch}+topic:${session.branch}+status:open`;
        const changes = await gerritFetch<GerritChange[]>(
          `/a/changes/?q=${encodeURIComponent(query)}&n=1`,
        );

        if (changes.length === 0) return null;

        const change = changes[0];
        return {
          number: change._number,
          url: changeUrl(change._number),
          title: change.subject,
          owner: change.owner.username ?? change.owner.name ?? "unknown",
          repo: change.project,
          branch: session.branch,
          baseBranch: change.branch,
          isDraft: false,
        };
      } catch {
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const change = await gerritFetch<GerritChange>(
        `/a/changes/${pr.number}`,
      );
      return gerritStateTopr(change.status);
    },

    async getPRSummary(pr: PRInfo) {
      const change = await gerritFetch<GerritChange>(
        `/a/changes/${pr.number}?o=CURRENT_REVISION`,
      );
      return {
        state: gerritStateTopr(change.status),
        title: change.subject,
        additions: change.insertions ?? 0,
        deletions: change.deletions ?? 0,
      };
    },

    async mergePR(pr: PRInfo, _method?: MergeMethod): Promise<void> {
      // Gerrit uses "submit" to merge a change
      await gerritFetch(`/a/changes/${pr.number}/submit`, {
        method: "POST",
        body: {},
      });
    },

    async closePR(pr: PRInfo): Promise<void> {
      // Gerrit uses "abandon" to close a change
      await gerritFetch(`/a/changes/${pr.number}/abandon`, {
        method: "POST",
        body: {},
      });
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      // Gerrit CI is tracked via the "Verified" label votes
      const change = await gerritFetch<GerritChange>(
        `/a/changes/${pr.number}?o=LABELS&o=DETAILED_LABELS`,
      );

      const checks: CICheck[] = [];
      const verifiedLabel = change.labels?.["Verified"];

      if (verifiedLabel?.all) {
        for (const vote of verifiedLabel.all) {
          let status: CICheck["status"];
          if (vote.value > 0) {
            status = "passed";
          } else if (vote.value < 0) {
            status = "failed";
          } else {
            status = "pending";
          }

          checks.push({
            name: vote.name ?? vote.username ?? `account-${vote._account_id}`,
            status,
            conclusion: `Verified ${vote.value > 0 ? "+" : ""}${vote.value}`,
            completedAt: parseGerritDate(vote.date),
          });
        }
      }

      return checks;
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch {
        // Check if change is merged/abandoned
        try {
          const state = await this.getPRState(pr);
          if (state === "merged" || state === "closed") return CI_STATUS.NONE;
        } catch {
          // Fall through
        }
        return CI_STATUS.FAILING;
      }

      if (checks.length === 0) return CI_STATUS.NONE;

      const hasFailing = checks.some((c) => c.status === "failed");
      if (hasFailing) return CI_STATUS.FAILING;

      const hasPending = checks.some((c) => c.status === "pending" || c.status === "running");
      if (hasPending) return CI_STATUS.PENDING;

      const hasPassing = checks.some((c) => c.status === "passed");
      if (!hasPassing) return CI_STATUS.NONE;

      return CI_STATUS.PASSING;
    },

    async getReviews(pr: PRInfo): Promise<Review[]> {
      const change = await gerritFetch<GerritChange>(
        `/a/changes/${pr.number}?o=LABELS&o=DETAILED_LABELS`,
      );

      const reviews: Review[] = [];
      const codeReviewLabel = change.labels?.["Code-Review"];

      if (codeReviewLabel?.all) {
        for (const vote of codeReviewLabel.all) {
          let state: Review["state"];
          if (vote.value >= 2) {
            state = "approved";
          } else if (vote.value <= -2) {
            state = "changes_requested";
          } else if (vote.value === 1) {
            state = "commented"; // +1 is a soft approval in Gerrit
          } else if (vote.value === -1) {
            state = "changes_requested"; // -1 is a soft rejection
          } else {
            state = "pending";
          }

          reviews.push({
            author: vote.username ?? vote.name ?? `account-${vote._account_id}`,
            state,
            submittedAt: parseGerritDate(vote.date),
          });
        }
      }

      return reviews;
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const change = await gerritFetch<GerritChange>(
        `/a/changes/${pr.number}?o=LABELS&o=DETAILED_LABELS`,
      );

      const codeReviewLabel = change.labels?.["Code-Review"];
      if (!codeReviewLabel) return "none";

      // Check for blocking -2
      if (codeReviewLabel.rejected) return "changes_requested";

      // Check for approval +2
      if (codeReviewLabel.approved) return "approved";

      // Check if any votes exist
      if (codeReviewLabel.all && codeReviewLabel.all.length > 0) {
        const hasNegative = codeReviewLabel.all.some((v) => v.value < 0);
        if (hasNegative) return "changes_requested";
        return "pending";
      }

      return "none";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        // Fetch all comments on the change, keyed by file path
        const commentsMap = await gerritFetch<Record<string, GerritCommentInfo[]>>(
          `/a/changes/${pr.number}/comments`,
        );

        const comments: ReviewComment[] = [];
        for (const [path, fileComments] of Object.entries(commentsMap)) {
          for (const comment of fileComments) {
            // Skip resolved comments and robot comments
            if (comment.unresolved !== undefined && !comment.unresolved) continue;
            if (comment.robot_id) continue;

            comments.push({
              id: comment.id,
              author: comment.author.username ?? comment.author.name ?? "unknown",
              body: comment.message,
              path: path === "/PATCHSET_LEVEL" ? undefined : path,
              line: comment.line,
              isResolved: comment.unresolved !== undefined && !comment.unresolved,
              createdAt: parseGerritDate(comment.updated),
              url: `${changeUrl(pr.number)}/comment/${comment.id}/`,
            });
          }
        }

        return comments;
      } catch {
        return [];
      }
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        // Gerrit has explicit "robot comments" for automated feedback
        const robotCommentsMap = await gerritFetch<Record<string, GerritCommentInfo[]>>(
          `/a/changes/${pr.number}/robotcomments`,
        );

        const comments: AutomatedComment[] = [];
        for (const [path, fileComments] of Object.entries(robotCommentsMap)) {
          for (const comment of fileComments) {
            // Determine severity from message content
            let severity: AutomatedComment["severity"] = "info";
            const bodyLower = comment.message.toLowerCase();
            if (
              bodyLower.includes("error") ||
              bodyLower.includes("bug") ||
              bodyLower.includes("critical")
            ) {
              severity = "error";
            } else if (
              bodyLower.includes("warning") ||
              bodyLower.includes("suggest") ||
              bodyLower.includes("consider")
            ) {
              severity = "warning";
            }

            comments.push({
              id: comment.id,
              botName: comment.robot_id ?? comment.author.username ?? "unknown",
              body: comment.message,
              path: path === "/PATCHSET_LEVEL" ? undefined : path,
              line: comment.line,
              severity,
              createdAt: parseGerritDate(comment.updated),
              url: `${changeUrl(pr.number)}/comment/${comment.id}/`,
            });
          }
        }

        return comments;
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

      const change = await gerritFetch<GerritChange>(
        `/a/changes/${pr.number}?o=LABELS&o=DETAILED_LABELS&o=SUBMITTABLE`,
      );

      // CI (Verified label)
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      // Reviews (Code-Review label)
      const codeReviewLabel = change.labels?.["Code-Review"];
      const approved = codeReviewLabel?.approved !== undefined;
      if (codeReviewLabel?.rejected) {
        blockers.push("Code-Review -2 (blocking rejection)");
      } else if (!approved) {
        blockers.push("Code-Review +2 required");
      }

      // Conflicts / mergeable
      const noConflicts = change.mergeable !== false;
      if (!noConflicts) {
        blockers.push("Merge conflicts");
      }

      // Check if Gerrit considers it submittable
      if (change.submittable === false) {
        if (blockers.length === 0) {
          blockers.push("Change is not submittable (submit requirements not met)");
        }
      }

      if (state === "closed") {
        blockers.push("Change is abandoned");
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
  name: "gerrit",
  slot: "scm" as const,
  description: "SCM plugin: Gerrit code review (changes, patch sets, reviews)",
  version: "0.1.0",
};

export function create(): SCM {
  return createGerritSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
