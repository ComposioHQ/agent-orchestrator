/**
 * scm-gitlab plugin — GitLab MRs, CI pipelines, reviews, merge readiness.
 *
 * Uses the `glab` CLI for all GitLab API interactions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

/** Known bot usernames that produce automated review comments */
const BOT_AUTHORS = new Set([
  "gitlab-bot",
  "project_bot",
  "ghost",
  "dependabot[bot]",
  "renovate[bot]",
  "codecov[bot]",
  "sonarcloud[bot]",
  "codeclimate[bot]",
  "deepsource-autofix[bot]",
  "snyk-bot",
  "sast-bot",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function glab(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("glab", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`glab ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

function repoFlag(pr: PRInfo): string {
  return `${pr.owner}/${pr.repo}`;
}

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createGitLabSCM(): SCM {
  return {
    name: "gitlab",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const parts = project.repo.split("/");
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format "${project.repo}", expected "group/project"`);
      }
      // GitLab supports nested groups: "group/subgroup/project"
      const owner = parts.slice(0, -1).join("/");
      const repo = parts[parts.length - 1];

      try {
        const raw = await glab([
          "mr",
          "list",
          "--repo",
          project.repo,
          "--source-branch",
          session.branch,
          "--output",
          "json",
          "--per-page",
          "1",
        ]);

        const mrs: Array<{
          iid: number;
          web_url: string;
          title: string;
          source_branch: string;
          target_branch: string;
          draft: boolean;
        }> = JSON.parse(raw);

        if (mrs.length === 0) return null;

        const mr = mrs[0];
        return {
          number: mr.iid,
          url: mr.web_url,
          title: mr.title,
          owner,
          repo,
          branch: mr.source_branch,
          baseBranch: mr.target_branch,
          isDraft: mr.draft ?? false,
        };
      } catch {
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const raw = await glab([
        "mr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--output",
        "json",
      ]);
      const data: { state: string } = JSON.parse(raw);
      const s = data.state.toLowerCase();
      if (s === "merged") return "merged";
      if (s === "closed") return "closed";
      return "open";
    },

    async getPRSummary(pr: PRInfo) {
      const raw = await glab([
        "mr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--output",
        "json",
      ]);
      const data: {
        state: string;
        title: string;
        changes_count: string;
      } = JSON.parse(raw);
      const s = data.state.toLowerCase();
      const state: PRState = s === "merged" ? "merged" : s === "closed" ? "closed" : "open";

      // GitLab API provides changes_count but not separate additions/deletions
      // via glab. Use the REST API for detailed diff stats.
      let additions = 0;
      let deletions = 0;
      try {
        const diffRaw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}`,
          "--method",
          "GET",
        ]);
        const diffData: {
          additions?: number;
          deletions?: number;
        } = JSON.parse(diffRaw);
        additions = diffData.additions ?? 0;
        deletions = diffData.deletions ?? 0;
      } catch {
        // Fall back to 0 if API call fails
      }

      return {
        state,
        title: data.title ?? "",
        additions,
        deletions,
      };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const args = [
        "mr",
        "merge",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--remove-source-branch",
        "--yes",
      ];

      if (method === "squash") {
        args.push("--squash");
      } else if (method === "rebase") {
        args.push("--rebase");
      }
      // "merge" is the default for glab mr merge (no extra flag needed)

      await glab(args);
    },

    async closePR(pr: PRInfo): Promise<void> {
      await glab(["mr", "close", String(pr.number), "--repo", repoFlag(pr)]);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        // Fetch pipeline jobs for the MR's head pipeline via REST API
        const mrRaw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}`,
          "--method",
          "GET",
        ]);
        const mrData: {
          head_pipeline?: { id: number };
        } = JSON.parse(mrRaw);

        if (!mrData.head_pipeline?.id) return [];

        const pipelineId = mrData.head_pipeline.id;
        const jobsRaw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/pipelines/${pipelineId}/jobs`,
          "--method",
          "GET",
          "--paginate",
        ]);
        const jobs: Array<{
          name: string;
          status: string;
          web_url: string;
          started_at: string | null;
          finished_at: string | null;
        }> = JSON.parse(jobsRaw);

        return jobs.map((j) => {
          let status: CICheck["status"];
          const s = j.status?.toLowerCase();

          if (s === "pending" || s === "waiting_for_resource" || s === "created") {
            status = "pending";
          } else if (s === "running") {
            status = "running";
          } else if (s === "success") {
            status = "passed";
          } else if (
            s === "failed" ||
            s === "canceled" ||
            s === "cancelled"
          ) {
            status = "failed";
          } else if (s === "skipped" || s === "manual" || s === "allowed_failure") {
            status = "skipped";
          } else {
            status = "failed";
          }

          return {
            name: j.name,
            status,
            url: j.web_url || undefined,
            conclusion: j.status || undefined,
            startedAt: j.started_at ? new Date(j.started_at) : undefined,
            completedAt: j.finished_at ? new Date(j.finished_at) : undefined,
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
          // Can't determine state either; fall through to fail-closed.
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
      // GitLab uses approvals rather than review states. Fetch approvals via API.
      try {
        const raw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}/approvals`,
          "--method",
          "GET",
        ]);
        const data: {
          approved_by: Array<{
            user: { username: string };
          }>;
          approved: boolean;
        } = JSON.parse(raw);

        const reviews: Review[] = data.approved_by.map((a) => ({
          author: a.user?.username ?? "unknown",
          state: "approved" as const,
          submittedAt: new Date(), // GitLab approvals API doesn't provide timestamp
        }));

        return reviews;
      } catch {
        return [];
      }
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      try {
        const raw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}/approvals`,
          "--method",
          "GET",
        ]);
        const data: {
          approved: boolean;
          approvals_required: number;
          approvals_left: number;
        } = JSON.parse(raw);

        if (data.approved) return "approved";
        if (data.approvals_required > 0 && data.approvals_left > 0) return "pending";

        // Check for unresolved discussions (equivalent to changes_requested)
        const mrRaw = await glab([
          "mr",
          "view",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--output",
          "json",
        ]);
        const mrData: {
          blocking_discussions_resolved?: boolean;
        } = JSON.parse(mrRaw);

        if (mrData.blocking_discussions_resolved === false) return "changes_requested";

        return "none";
      } catch {
        return "none";
      }
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        // Fetch unresolved discussion threads via GraphQL
        const raw = await glab([
          "api",
          "graphql",
          "-f",
          `query=query {
            project(fullPath: "${repoFlag(pr)}") {
              mergeRequest(iid: "${pr.number}") {
                discussions(first: 100) {
                  nodes {
                    id
                    resolved
                    resolvable
                    notes(first: 1) {
                      nodes {
                        id
                        author { username }
                        body
                        position { filePath newLine }
                        url
                        createdAt
                      }
                    }
                  }
                }
              }
            }
          }`,
        ]);

        const data: {
          data: {
            project: {
              mergeRequest: {
                discussions: {
                  nodes: Array<{
                    id: string;
                    resolved: boolean;
                    resolvable: boolean;
                    notes: {
                      nodes: Array<{
                        id: string;
                        author: { username: string } | null;
                        body: string;
                        position: { filePath: string | null; newLine: number | null } | null;
                        url: string;
                        createdAt: string;
                      }>;
                    };
                  }>;
                };
              };
            };
          };
        } = JSON.parse(raw);

        const discussions = data.data.project.mergeRequest.discussions.nodes;

        return discussions
          .filter((d) => {
            if (!d.resolvable || d.resolved) return false;
            const note = d.notes.nodes[0];
            if (!note) return false;
            const author = note.author?.username ?? "";
            return !BOT_AUTHORS.has(author);
          })
          .map((d) => {
            const note = d.notes.nodes[0];
            return {
              id: note.id,
              author: note.author?.username ?? "unknown",
              body: note.body,
              path: note.position?.filePath || undefined,
              line: note.position?.newLine ?? undefined,
              isResolved: false,
              createdAt: parseDate(note.createdAt),
              url: note.url,
            };
          });
      } catch {
        return [];
      }
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        // Fetch MR notes (comments) via REST API
        const raw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}/notes`,
          "--method",
          "GET",
          "--paginate",
        ]);

        const notes: Array<{
          id: number;
          author: { username: string };
          body: string;
          position?: { new_path: string; new_line: number | null } | null;
          created_at: string;
          noteable_iid: number;
        }> = JSON.parse(raw);

        const projectUrl = pr.url.replace(/\/-\/merge_requests\/\d+$/, "");

        return notes
          .filter((n) => BOT_AUTHORS.has(n.author?.username ?? ""))
          .map((n) => {
            let severity: AutomatedComment["severity"] = "info";
            const bodyLower = n.body.toLowerCase();
            if (
              bodyLower.includes("error") ||
              bodyLower.includes("bug") ||
              bodyLower.includes("critical") ||
              bodyLower.includes("potential issue")
            ) {
              severity = "error";
            } else if (
              bodyLower.includes("warning") ||
              bodyLower.includes("suggest") ||
              bodyLower.includes("consider")
            ) {
              severity = "warning";
            }

            return {
              id: String(n.id),
              botName: n.author?.username ?? "unknown",
              body: n.body,
              path: n.position?.new_path || undefined,
              line: n.position?.new_line ?? undefined,
              severity,
              createdAt: parseDate(n.created_at),
              url: `${projectUrl}/-/merge_requests/${pr.number}#note_${n.id}`,
            };
          });
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

      // Fetch MR details via REST API for merge status
      const raw = await glab([
        "api",
        `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}`,
        "--method",
        "GET",
      ]);

      const data: {
        merge_status: string;
        detailed_merge_status?: string;
        has_conflicts: boolean;
        draft: boolean;
        blocking_discussions_resolved: boolean;
      } = JSON.parse(raw);

      // CI
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      // Reviews / Approvals
      const reviewDecision = await this.getReviewDecision(pr);
      const approved = reviewDecision === "approved";
      if (reviewDecision === "changes_requested") {
        blockers.push("Unresolved discussions blocking merge");
      } else if (reviewDecision === "pending") {
        blockers.push("Approvals required");
      }

      // Conflicts
      const noConflicts = !data.has_conflicts;
      if (data.has_conflicts) {
        blockers.push("Merge conflicts");
      }

      // Detailed merge status (GitLab 15.6+)
      const detailedStatus = (data.detailed_merge_status ?? data.merge_status ?? "").toLowerCase();
      if (detailedStatus === "blocked_status") {
        blockers.push("Merge is blocked by project settings");
      } else if (detailedStatus === "need_rebase") {
        blockers.push("Branch needs rebase");
      } else if (detailedStatus === "not_approved") {
        if (!blockers.some((b) => b.includes("Approvals"))) {
          blockers.push("Not approved");
        }
      } else if (detailedStatus === "discussions_not_resolved") {
        if (!blockers.some((b) => b.includes("discussions"))) {
          blockers.push("Unresolved discussions");
        }
      }

      // Blocking discussions
      if (!data.blocking_discussions_resolved) {
        if (!blockers.some((b) => b.includes("discussions"))) {
          blockers.push("Blocking discussions not resolved");
        }
      }

      // Draft
      if (data.draft) {
        blockers.push("MR is still a draft");
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
  name: "gitlab",
  slot: "scm" as const,
  description: "SCM plugin: GitLab MRs, CI pipelines, reviews, merge readiness",
  version: "0.1.0",
};

export function create(): SCM {
  return createGitLabSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
