/**
 * scm-gitlab plugin — GitLab Merge Requests, CI pipelines, reviews, merge readiness.
 *
 * Uses the `glab` CLI for all GitLab API interactions.
 * Supports both GitLab.com and self-hosted GitLab instances.
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

const BOT_AUTHORS = new Set([
  "gitlab-bot",
  "codecov-bot",
  "renovate-bot",
  "dependabot[bot]",
  "renovate[bot]",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGitLabHost(project: ProjectConfig): string {
  const host = (project.scm?.["host"] as string) || (project.tracker?.["host"] as string);
  if (host) {
    return host.replace(/^https?:\/\//, "");
  }
  return process.env["GITLAB_HOST"] || "gitlab.com";
}

function getProjectPath(project: ProjectConfig): string {
  const projectPath =
    (project.scm?.["projectPath"] as string) || (project.tracker?.["projectPath"] as string);
  if (projectPath) {
    return projectPath;
  }
  return project.repo;
}

function buildGlabArgs(
  host: string,
  projectPath: string,
  apiPath: string,
  method: string = "GET",
  data?: Record<string, unknown>,
): string[] {
  const args = ["api", `projects/${encodeURIComponent(projectPath)}${apiPath}`];

  if (method !== "GET") {
    args.push("--method", method);
  }

  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          for (const item of value) {
            args.push("-f", `${key}[]=${String(item)}`);
          }
        } else {
          args.push("-f", `${key}=${String(value)}`);
        }
      }
    }
  }

  if (host !== "gitlab.com") {
    args.unshift("--hostname", host);
  }

  return args;
}

async function glab(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("glab", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    const error = err as Error & { stderr?: string };
    throw new Error(
      `glab ${args.slice(0, 3).join(" ")} failed: ${error.message}${error.stderr ? ` (${error.stderr})` : ""}`,
      { cause: err },
    );
  }
}

async function glabApi<T>(
  host: string,
  projectPath: string,
  apiPath: string,
  method: string = "GET",
  data?: Record<string, unknown>,
): Promise<T> {
  const args = buildGlabArgs(host, projectPath, apiPath, method, data);
  const raw = await glab(args);
  return JSON.parse(raw) as T;
}

function parseMRIdentifier(reference: string): string {
  const urlMatch = reference.match(/\/-\/merge_requests\/(\d+)/);
  if (urlMatch) {
    return urlMatch[1];
  }

  const scopedMatch = reference.match(/!(\d+)$/);
  if (scopedMatch) {
    return scopedMatch[1];
  }

  return reference.replace(/^!/, "");
}

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function mapMRState(state: string): PRState {
  const s = state.toLowerCase();
  if (s === "merged") return "merged";
  if (s === "closed" || s === "locked") return "closed";
  return "open";
}

function mapJobStatus(status: string): CICheck["status"] {
  const s = status.toLowerCase();
  if (s === "running" || s === "pending") return "running";
  if (s === "success") return "passed";
  if (s === "failed" || s === "canceled") return "failed";
  return "skipped";
}

function mapPipelineStatusToCI(status: string): CIStatus {
  const s = status.toLowerCase();
  if (s === "success") return "passing";
  if (s === "failed" || s === "canceled") return "failing";
  if (s === "running" || s === "pending") return "pending";
  return "none";
}

function mrInfoFromResponse(
  data: {
    iid: number;
    web_url: string;
    title: string;
    source_branch: string;
    target_branch: string;
    draft: boolean;
  },
  projectPath: string,
): PRInfo {
  return {
    number: data.iid,
    url: data.web_url,
    title: data.title,
    owner: projectPath.split("/")[0] || "",
    repo: projectPath.split("/").slice(1).join("/") || projectPath,
    branch: data.source_branch,
    baseBranch: data.target_branch,
    isDraft: data.draft,
  };
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createGitLabSCM(): SCM {
  return {
    name: "gitlab",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const host = getGitLabHost(project);
      const projectPath = getProjectPath(project);

      try {
        const data = await glabApi<
          Array<{
            iid: number;
            web_url: string;
            title: string;
            source_branch: string;
            target_branch: string;
            draft: boolean;
          }>
        >(
          host,
          projectPath,
          `/merge_requests?state=opened&source_branch=${encodeURIComponent(session.branch)}`,
        );

        if (data.length === 0) return null;
        return mrInfoFromResponse(data[0], projectPath);
      } catch {
        return null;
      }
    },

    async resolvePR(reference: string, project: ProjectConfig): Promise<PRInfo> {
      const host = getGitLabHost(project);
      const projectPath = getProjectPath(project);
      const iid = parseMRIdentifier(reference);

      const data = await glabApi<{
        iid: number;
        web_url: string;
        title: string;
        source_branch: string;
        target_branch: string;
        draft: boolean;
      }>(host, projectPath, `/merge_requests/${iid}`);

      return mrInfoFromResponse(data, projectPath);
    },

    async assignPRToCurrentUser(pr: PRInfo): Promise<void> {
      const host = getGitLabHost({ repo: `${pr.owner}/${pr.repo}` } as ProjectConfig);
      const projectPath = `${pr.owner}/${pr.repo}`;

      const currentUser = await glabApi<{ id: number }>(host, projectPath, "/user");
      await glabApi(host, projectPath, `/merge_requests/${pr.number}`, "PUT", {
        assignee_ids: [currentUser.id],
      });
    },

    async checkoutPR(pr: PRInfo, workspacePath: string): Promise<boolean> {
      const { stdout: currentBranch } = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: workspacePath,
      });

      if (currentBranch.trim() === pr.branch) return false;

      const { stdout: dirty } = await execFileAsync("git", ["status", "--porcelain"], {
        cwd: workspacePath,
      });

      if (dirty.trim()) {
        throw new Error(
          `Workspace has uncommitted changes; cannot switch to MR branch "${pr.branch}" safely`,
        );
      }

      await execFileAsync(
        "git",
        ["fetch", "origin", `merge-requests/${pr.number}/head:${pr.branch}`],
        { cwd: workspacePath },
      );

      await execFileAsync("git", ["checkout", pr.branch], { cwd: workspacePath });

      return true;
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const host = getGitLabHost({ repo: `${pr.owner}/${pr.repo}` } as ProjectConfig);
      const projectPath = `${pr.owner}/${pr.repo}`;

      const data = await glabApi<{ state: string }>(
        host,
        projectPath,
        `/merge_requests/${pr.number}`,
      );

      return mapMRState(data.state);
    },

    async getPRSummary(pr: PRInfo) {
      const host = getGitLabHost({ repo: `${pr.owner}/${pr.repo}` } as ProjectConfig);
      const projectPath = `${pr.owner}/${pr.repo}`;

      const data = await glabApi<{
        state: string;
        title: string;
        changes_count: number;
      }>(host, projectPath, `/merge_requests/${pr.number}`);

      return {
        state: mapMRState(data.state),
        title: data.title ?? "",
        additions: data.changes_count ?? 0,
        deletions: 0,
      };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const host = getGitLabHost({ repo: `${pr.owner}/${pr.repo}` } as ProjectConfig);
      const projectPath = `${pr.owner}/${pr.repo}`;

      const mergeParams: Record<string, unknown> = {
        squash: method === "squash",
      };

      if (method === "rebase") {
        await glabApi(host, projectPath, `/merge_requests/${pr.number}/rebase`, "PUT");
      }

      await glabApi(host, projectPath, `/merge_requests/${pr.number}/merge`, "PUT", mergeParams);
    },

    async closePR(pr: PRInfo): Promise<void> {
      const host = getGitLabHost({ repo: `${pr.owner}/${pr.repo}` } as ProjectConfig);
      const projectPath = `${pr.owner}/${pr.repo}`;

      await glabApi(host, projectPath, `/merge_requests/${pr.number}`, "PUT", {
        state_event: "close",
      });
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      const host = getGitLabHost({ repo: `${pr.owner}/${pr.repo}` } as ProjectConfig);
      const projectPath = `${pr.owner}/${pr.repo}`;

      const pipelines = await glabApi<
        Array<{
          id: number;
          status: string;
          web_url: string;
        }>
      >(host, projectPath, `/merge_requests/${pr.number}/pipelines`);

      if (pipelines.length === 0) return [];

      const latestPipeline = pipelines[0];
      const jobs = await glabApi<
        Array<{
          name: string;
          status: string;
          web_url: string;
          started_at: string | null;
          finished_at: string | null;
        }>
      >(host, projectPath, `/pipelines/${latestPipeline.id}/jobs`);

      return jobs.map((job) => ({
        name: job.name,
        status: mapJobStatus(job.status),
        url: job.web_url,
        startedAt: job.started_at ? parseDate(job.started_at) : undefined,
        completedAt: job.finished_at ? parseDate(job.finished_at) : undefined,
      }));
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      try {
        const checks = await this.getCIChecks(pr);
        if (checks.length === 0) {
          const state = await this.getPRState(pr);
          if (state === "merged" || state === "closed") return "none";
          return "none";
        }

        const hasFailing = checks.some((c) => c.status === "failed");
        if (hasFailing) return "failing";

        const hasPending = checks.some((c) => c.status === "pending" || c.status === "running");
        if (hasPending) return "pending";

        const hasPassing = checks.some((c) => c.status === "passed");
        if (!hasPassing) return "none";

        return "passing";
      } catch {
        try {
          const state = await this.getPRState(pr);
          if (state === "merged" || state === "closed") return "none";
        } catch {}
        return "failing";
      }
    },

    async getReviews(pr: PRInfo): Promise<Review[]> {
      const host = getGitLabHost({ repo: `${pr.owner}/${pr.repo}` } as ProjectConfig);
      const projectPath = `${pr.owner}/${pr.repo}`;

      const approvals = await glabApi<{
        approved_by: Array<{ user: { username: string } }>;
      }>(host, projectPath, `/merge_requests/${pr.number}/approvals`);

      return approvals.approved_by.map((a) => ({
        author: a.user.username,
        state: "approved" as const,
        submittedAt: new Date(),
      }));
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const host = getGitLabHost({ repo: `${pr.owner}/${pr.repo}` } as ProjectConfig);
      const projectPath = `${pr.owner}/${pr.repo}`;

      const data = await glabApi<{
        approved: boolean;
        approvals_required: number;
        approvals_left: number;
      }>(host, projectPath, `/merge_requests/${pr.number}/approvals`);

      if (data.approved) return "approved";
      if (data.approvals_required > 0 && data.approvals_left > 0) return "pending";
      return "none";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      const host = getGitLabHost({ repo: `${pr.owner}/${pr.repo}` } as ProjectConfig);
      const projectPath = `${pr.owner}/${pr.repo}`;

      const discussions = await glabApi<
        Array<{
          id: string;
          notes: Array<{
            id: number;
            author: { username: string };
            body: string;
            position?: {
              new_path?: string;
              new_line?: number;
            };
            created_at: string;
            resolvable: boolean;
            resolved: boolean;
          }>;
        }>
      >(host, projectPath, `/merge_requests/${pr.number}/discussions`);

      const comments: ReviewComment[] = [];

      for (const discussion of discussions) {
        const firstNote = discussion.notes[0];
        if (!firstNote) continue;

        if (firstNote.resolvable && !firstNote.resolved) {
          if (BOT_AUTHORS.has(firstNote.author.username)) continue;

          comments.push({
            id: String(firstNote.id),
            author: firstNote.author.username,
            body: firstNote.body,
            path: firstNote.position?.new_path,
            line: firstNote.position?.new_line,
            isResolved: false,
            createdAt: parseDate(firstNote.created_at),
            url: `https://${host}/${projectPath}/-/merge_requests/${pr.number}#note_${firstNote.id}`,
          });
        }
      }

      return comments;
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      const host = getGitLabHost({ repo: `${pr.owner}/${pr.repo}` } as ProjectConfig);
      const projectPath = `${pr.owner}/${pr.repo}`;

      const notes = await glabApi<
        Array<{
          id: number;
          author: { username: string };
          body: string;
          position?: {
            new_path?: string;
            new_line?: number;
          };
          created_at: string;
        }>
      >(host, projectPath, `/merge_requests/${pr.number}/notes?per_page=100`);

      return notes
        .filter((note) => BOT_AUTHORS.has(note.author.username))
        .map((note) => {
          const bodyLower = note.body.toLowerCase();
          let severity: AutomatedComment["severity"] = "info";
          if (
            bodyLower.includes("error") ||
            bodyLower.includes("bug") ||
            bodyLower.includes("critical")
          ) {
            severity = "error";
          } else if (bodyLower.includes("warning") || bodyLower.includes("suggest")) {
            severity = "warning";
          }

          return {
            id: String(note.id),
            botName: note.author.username,
            body: note.body,
            path: note.position?.new_path,
            line: note.position?.new_line,
            severity,
            createdAt: parseDate(note.created_at),
            url: `https://${host}/${projectPath}/-/merge_requests/${pr.number}#note_${note.id}`,
          };
        });
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

      const host = getGitLabHost({ repo: `${pr.owner}/${pr.repo}` } as ProjectConfig);
      const projectPath = `${pr.owner}/${pr.repo}`;

      const mrData = await glabApi<{
        merge_status: string;
        draft: boolean;
        blocking_discussions_resolved: boolean;
      }>(host, projectPath, `/merge_requests/${pr.number}`);

      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      const reviewDecision = await this.getReviewDecision(pr);
      const approved = reviewDecision === "approved";
      if (reviewDecision === "pending") {
        blockers.push("Review required");
      }

      const noConflicts = mrData.merge_status === "can_be_merged";
      if (mrData.merge_status === "cannot_be_merged") {
        blockers.push("Merge conflicts");
      } else if (mrData.merge_status === "checking") {
        blockers.push("Merge status is being checked");
      }

      if (!mrData.blocking_discussions_resolved) {
        blockers.push("Unresolved discussions");
      }

      if (mrData.draft) {
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
  description: "SCM plugin: GitLab Merge Requests, CI pipelines, reviews, merge readiness",
  version: "0.1.0",
};

export function create(): SCM {
  return createGitLabSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
