/**
 * scm-gitlab plugin — GitLab Merge Requests, CI pipelines, reviews, merge readiness.
 *
 * Uses the `glab` CLI (official GitLab CLI) for all API interactions.
 * Supports self-hosted GitLab instances (configured via `glab config`).
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
  "dependabot",
  "renovate-bot",
  "sonarqube-bot",
  "codeclimate",
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
      if (parts.length < 2) {
        throw new Error(`Invalid repo format "${project.repo}", expected "group/project" or "group/subgroup/project"`);
      }
      // GitLab repos can have nested groups: "group/subgroup/project"
      // owner = everything except last segment, repo = last segment
      const repoName = parts[parts.length - 1];
      const ownerName = parts.slice(0, -1).join("/");

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
          owner: ownerName,
          repo: repoName,
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

      // GitLab's changes_count is a string; individual additions/deletions
      // require diffstat parsing. Use the REST API for accurate stats.
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
        // Fall back to zero if API call fails
      }

      return {
        state,
        title: data.title ?? "",
        additions,
        deletions,
      };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const args = ["mr", "merge", String(pr.number), "--repo", repoFlag(pr), "--yes"];

      if (method === "squash") {
        args.push("--squash-before-merge");
      } else if (method === "rebase") {
        args.push("--rebase");
      }
      // "merge" = default merge commit, no extra flag

      args.push("--remove-source-branch");

      await glab(args);
    },

    async closePR(pr: PRInfo): Promise<void> {
      await glab(["mr", "close", String(pr.number), "--repo", repoFlag(pr)]);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        // Use REST API to get pipeline jobs for the MR's head pipeline
        const mrRaw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}`,
          "--method",
          "GET",
        ]);
        const mrData: { head_pipeline?: { id: number } } = JSON.parse(mrRaw);

        if (!mrData.head_pipeline?.id) return [];

        const pipelineId = mrData.head_pipeline.id;
        const jobsRaw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/pipelines/${pipelineId}/jobs?per_page=100`,
          "--method",
          "GET",
        ]);

        const jobs: Array<{
          name: string;
          status: string;
          web_url: string;
          started_at: string | null;
          finished_at: string | null;
        }> = JSON.parse(jobsRaw);

        return jobs.map((job) => {
          let status: CICheck["status"];
          const s = job.status.toLowerCase();

          if (s === "pending" || s === "waiting_for_resource" || s === "created") {
            status = "pending";
          } else if (s === "running") {
            status = "running";
          } else if (s === "success") {
            status = "passed";
          } else if (s === "failed" || s === "canceled") {
            status = "failed";
          } else if (s === "skipped" || s === "manual" || s === "allowed_failure") {
            status = "skipped";
          } else {
            // Unknown status — fail closed
            status = "failed";
          }

          return {
            name: job.name,
            status,
            url: job.web_url || undefined,
            conclusion: job.status,
            startedAt: job.started_at ? new Date(job.started_at) : undefined,
            completedAt: job.finished_at ? new Date(job.finished_at) : undefined,
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
          // Can't determine state either
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
        // GitLab uses "approvals" rather than GitHub-style reviews
        const raw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}/approval_state`,
          "--method",
          "GET",
        ]);

        const data: {
          rules: Array<{
            approved: boolean;
            approved_by: Array<{ username: string }>;
          }>;
        } = JSON.parse(raw);

        const reviews: Review[] = [];
        for (const rule of data.rules ?? []) {
          for (const approver of rule.approved_by ?? []) {
            reviews.push({
              author: approver.username,
              state: "approved",
              submittedAt: new Date(),
            });
          }
        }

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
        // No approval rules configured
        return "none";
      } catch {
        return "none";
      }
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        // GitLab uses "discussions" for review threads
        const raw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}/discussions?per_page=100`,
          "--method",
          "GET",
        ]);

        const discussions: Array<{
          id: string;
          notes: Array<{
            id: number;
            author: { username: string };
            body: string;
            position?: { new_path?: string; new_line?: number | null };
            resolvable: boolean;
            resolved: boolean;
            created_at: string;
          }>;
        }> = JSON.parse(raw);

        const comments: ReviewComment[] = [];
        for (const discussion of discussions) {
          const note = discussion.notes[0];
          if (!note) continue;
          if (!note.resolvable) continue; // skip non-resolvable (e.g. system notes)
          if (note.resolved) continue; // only pending (unresolved)
          if (BOT_AUTHORS.has(note.author?.username ?? "")) continue;

          comments.push({
            id: String(note.id),
            author: note.author?.username ?? "unknown",
            body: note.body,
            path: note.position?.new_path || undefined,
            line: note.position?.new_line ?? undefined,
            isResolved: false,
            createdAt: parseDate(note.created_at),
            url: `${pr.url}#note_${note.id}`,
          });
        }
        return comments;
      } catch {
        return [];
      }
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        const raw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}/notes?per_page=100&sort=desc`,
          "--method",
          "GET",
        ]);

        const notes: Array<{
          id: number;
          author: { username: string };
          body: string;
          position?: { new_path?: string; new_line?: number | null };
          created_at: string;
        }> = JSON.parse(raw);

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
              url: `${pr.url}#note_${n.id}`,
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

      // Fetch MR details via REST API
      const raw = await glab([
        "api",
        `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}`,
        "--method",
        "GET",
      ]);

      const data: {
        merge_status: string;
        has_conflicts: boolean;
        work_in_progress: boolean;
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
      const approved = reviewDecision === "approved" || reviewDecision === "none";
      if (reviewDecision === "pending") {
        blockers.push("Approvals required");
      }

      // Conflicts
      const noConflicts = !data.has_conflicts;
      if (data.has_conflicts) {
        blockers.push("Merge conflicts");
      }

      // Merge status
      const mergeStatus = data.merge_status?.toLowerCase();
      if (mergeStatus === "cannot_be_merged") {
        if (!data.has_conflicts) {
          blockers.push("Cannot be merged (branch protection or other rules)");
        }
      } else if (mergeStatus === "checking") {
        blockers.push("Merge status is being checked");
      }

      // Draft / WIP
      if (data.draft || data.work_in_progress) {
        blockers.push("MR is still a draft");
      }

      // Unresolved discussions
      if (!data.blocking_discussions_resolved) {
        blockers.push("Unresolved discussions");
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
  description: "SCM plugin: GitLab Merge Requests, CI pipelines, reviews, merge readiness",
  version: "0.1.0",
};

export function create(): SCM {
  return createGitLabSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
