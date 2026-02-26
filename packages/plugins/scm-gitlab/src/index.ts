/**
 * scm-gitlab plugin — GitLab Merge Requests, Pipelines, Reviews.
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
  "project_xxx_bot",
  "sast-bot",
  "dependency-scanning-bot",
  "code-quality-bot",
  "container-scanning-bot",
  "license-management-bot",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGitLabHost(): string {
  return process.env["GITLAB_HOST"] || "https://gitlab.com";
}

async function glab(args: string[]): Promise<string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  const host = getGitLabHost();
  if (host !== "https://gitlab.com") {
    env["GITLAB_HOST"] = host;
  }
  try {
    const { stdout } = await execFileAsync("glab", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      env,
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

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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
        throw new Error(`Invalid repo format "${project.repo}", expected "owner/repo"`);
      }
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
        ]);

        const mrs = safeJsonParse<Array<{
          iid: number;
          web_url: string;
          title: string;
          source_branch: string;
          target_branch: string;
          draft: boolean;
        }>>(raw, []);

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

      const data = safeJsonParse<{ state: string }>(raw, { state: "opened" });
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

      const data = safeJsonParse<{
        state: string;
        title: string;
        changes_count: string;
      }>(raw, { state: "opened", title: "", changes_count: "0" });

      const s = data.state.toLowerCase();
      const state: PRState = s === "merged" ? "merged" : s === "closed" ? "closed" : "open";

      // GitLab provides changes_count but not separate additions/deletions in the MR list.
      // We approximate by fetching MR changes via the API.
      let additions = 0;
      let deletions = 0;
      try {
        const changesRaw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}/changes`,
        ]);
        const changesData = safeJsonParse<{
          changes: Array<{
            diff: string;
          }>;
        }>(changesRaw, { changes: [] });

        for (const change of changesData.changes) {
          const lines = change.diff.split("\n");
          for (const line of lines) {
            if (line.startsWith("+") && !line.startsWith("+++")) additions++;
            if (line.startsWith("-") && !line.startsWith("---")) deletions++;
          }
        }
      } catch {
        // Best-effort; additions/deletions stay 0
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
        "--yes",
        "--remove-source-branch",
      ];

      if (method === "squash") {
        args.push("--squash");
      } else if (method === "rebase") {
        args.push("--rebase");
      }
      // "merge" is default behavior, no extra flag needed

      await glab(args);
    },

    async closePR(pr: PRInfo): Promise<void> {
      await glab([
        "mr",
        "close",
        String(pr.number),
        "--repo",
        repoFlag(pr),
      ]);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        // Get the pipeline status for this MR via GitLab API
        const raw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}/pipelines`,
        ]);

        const pipelines = safeJsonParse<Array<{
          id: number;
          status: string;
          web_url: string;
          created_at: string;
          updated_at: string;
        }>>(raw, []);

        if (pipelines.length === 0) return [];

        // Get jobs from the latest pipeline
        const latestPipeline = pipelines[0];
        const jobsRaw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/pipelines/${latestPipeline.id}/jobs`,
        ]);

        const jobs = safeJsonParse<Array<{
          name: string;
          status: string;
          web_url: string;
          started_at: string | null;
          finished_at: string | null;
        }>>(jobsRaw, []);

        return jobs.map((job) => {
          let status: CICheck["status"];
          const s = job.status.toLowerCase();

          if (s === "success" || s === "passed") {
            status = "passed";
          } else if (s === "failed") {
            status = "failed";
          } else if (s === "running") {
            status = "running";
          } else if (s === "pending" || s === "waiting_for_resource" || s === "created") {
            status = "pending";
          } else if (s === "skipped" || s === "manual" || s === "canceled" || s === "cancelled") {
            status = "skipped";
          } else {
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
        const raw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}/approvals`,
        ]);

        const data = safeJsonParse<{
          approved_by: Array<{
            user: { username: string };
          }>;
        }>(raw, { approved_by: [] });

        // GitLab approvals are simpler: approved_by list
        const reviews: Review[] = data.approved_by.map((a) => ({
          author: a.user?.username ?? "unknown",
          state: "approved" as const,
          submittedAt: new Date(),
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
        ]);

        const data = safeJsonParse<{
          approved: boolean;
          approvals_required: number;
          approvals_left: number;
        }>(raw, { approved: false, approvals_required: 0, approvals_left: 0 });

        if (data.approved) return "approved";
        if (data.approvals_required > 0 && data.approvals_left > 0) return "pending";
        // If no approvals required, treat as none
        if (data.approvals_required === 0) return "none";
        return "pending";
      } catch {
        return "none";
      }
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        const raw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}/discussions`,
        ]);

        const discussions = safeJsonParse<Array<{
          id: string;
          notes: Array<{
            id: number;
            author: { username: string };
            body: string;
            position?: {
              new_path?: string;
              new_line?: number;
            };
            resolvable: boolean;
            resolved: boolean;
            created_at: string;
          }>;
        }>>(raw, []);

        const comments: ReviewComment[] = [];

        for (const discussion of discussions) {
          for (const note of discussion.notes) {
            if (!note.resolvable) continue;
            if (note.resolved) continue;
            const author = note.author?.username ?? "";
            if (BOT_AUTHORS.has(author)) continue;

            comments.push({
              id: String(note.id),
              author: author || "unknown",
              body: note.body,
              path: note.position?.new_path || undefined,
              line: note.position?.new_line ?? undefined,
              isResolved: false,
              createdAt: parseDate(note.created_at),
              url: `${pr.url}#note_${note.id}`,
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
        const raw = await glab([
          "api",
          `projects/${encodeURIComponent(repoFlag(pr))}/merge_requests/${pr.number}/notes?per_page=100`,
        ]);

        const notes = safeJsonParse<Array<{
          id: number;
          author: { username: string };
          body: string;
          created_at: string;
          system: boolean;
        }>>(raw, []);

        return notes
          .filter((n) => n.system || BOT_AUTHORS.has(n.author?.username ?? ""))
          .map((n) => ({
            id: String(n.id),
            botName: n.author?.username ?? "system",
            body: n.body,
            severity: determineSeverity(n.body),
            createdAt: parseDate(n.created_at),
            url: `${pr.url}#note_${n.id}`,
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

      // Fetch MR details
      const raw = await glab([
        "mr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--output",
        "json",
      ]);

      const data = safeJsonParse<{
        has_conflicts: boolean;
        merge_status: string;
        draft: boolean;
        blocking_discussions_resolved: boolean;
      }>(raw, {
        has_conflicts: false,
        merge_status: "cannot_be_merged",
        draft: false,
        blocking_discussions_resolved: true,
      });

      // CI
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      // Reviews / Approvals
      const reviewDecision = await this.getReviewDecision(pr);
      const approved = reviewDecision === "approved";
      if (reviewDecision === "pending") {
        blockers.push("Approval required");
      }

      // Conflicts
      const noConflicts = !data.has_conflicts;
      if (data.has_conflicts) {
        blockers.push("Merge conflicts");
      }

      // Merge status
      if (data.merge_status === "cannot_be_merged") {
        if (!data.has_conflicts) {
          blockers.push("Merge status: cannot be merged");
        }
      }

      // Blocking discussions
      if (!data.blocking_discussions_resolved) {
        blockers.push("Unresolved blocking discussions");
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
  description: "SCM plugin: GitLab Merge Requests, Pipelines, Reviews",
  version: "0.1.0",
};

export function create(): SCM {
  return createGitLabSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
