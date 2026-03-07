/**
 * scm-gitlab plugin — GitLab MRs, CI pipelines, reviews, merge readiness.
 *
 * Uses the `glab` CLI for GitLab API interactions.
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
  "ghost",
  "dependabot[bot]",
  "renovate[bot]",
  "sast-bot",
  "codeclimate[bot]",
  "sonarcloud[bot]",
  "snyk-bot",
]);

function isBot(username: string): boolean {
  return BOT_AUTHORS.has(username) || /^project_\d+_bot/.test(username) || username.endsWith("[bot]");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function glab(args: string[], hostname?: string): Promise<string> {
  if (hostname && args[0] === "api") {
    args = [args[0], "--hostname", hostname, ...args.slice(1)];
  }
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

function extractHostFromOwner(owner: string): string | undefined {
  const parts = owner.split("/");
  const first = parts[0];
  return first && first.includes(".") && parts.length >= 2 ? first : undefined;
}

function stripHost(fullPath: string): string {
  const parts = fullPath.split("/");
  if (parts[0] && parts[0].includes(".") && parts.length >= 3) {
    return parts.slice(1).join("/");
  }
  return fullPath;
}

function encodeProjectId(owner: string, repo: string): string {
  return encodeURIComponent(stripHost(`${owner}/${repo}`));
}

function parseJSON<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${context}: expected JSON but got: ${raw.slice(0, 200)}`, { cause: err });
  }
}

function mapJobStatus(status: string): CICheck["status"] {
  switch (status) {
    case "pending":
    case "waiting_for_resource":
    case "preparing":
    case "created":
    case "scheduled":
    case "manual":
      return "pending";
    case "running":
      return "running";
    case "success":
      return "passed";
    case "failed":
    case "canceled":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "failed";
  }
}

function mapPRState(state: string): PRState {
  const s = state.toLowerCase();
  if (s === "merged") return "merged";
  if (s === "closed") return "closed";
  return "open";
}

function inferSeverity(body: string): AutomatedComment["severity"] {
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

interface GitLabNote {
  id: number;
  author: { username: string };
  body: string;
  resolvable: boolean;
  resolved: boolean;
  position?: { new_path?: string; new_line?: number | null };
  created_at: string;
}

interface GitLabDiscussion {
  id: string;
  notes: GitLabNote[];
}

function mrApiPath(pr: PRInfo): string {
  return `projects/${encodeProjectId(pr.owner, pr.repo)}/merge_requests/${pr.number}`;
}

async function fetchDiscussions(
  pr: PRInfo,
  hostname: string | undefined,
  context: string,
): Promise<GitLabDiscussion[]> {
  const raw = await glab(
    ["api", `${mrApiPath(pr)}/discussions?per_page=100`],
    hostname,
  );
  return parseJSON<GitLabDiscussion[]>(raw, context);
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createGitLabSCM(config?: Record<string, unknown>): SCM {
  const configHostname = typeof config?.host === "string" ? config.host : undefined;

  function resolveHostname(pr?: PRInfo): string | undefined {
    return configHostname ?? (pr ? extractHostFromOwner(pr.owner) : undefined);
  }

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
        const raw = await glab(
          [
            "mr",
            "list",
            "--source-branch",
            session.branch,
            "--repo",
            project.repo,
            "-F",
            "json",
            "-P",
            "1",
          ],
          resolveHostname(),
        );

        const mrs = parseJSON<
          Array<{
            iid: number;
            web_url: string;
            title: string;
            source_branch: string;
            target_branch: string;
            draft: boolean;
          }>
        >(raw, `detectPR for branch "${session.branch}"`);

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
      } catch (err) {
        console.warn(`detectPR: failed for branch "${session.branch}": ${(err as Error).message}`);
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const raw = await glab(
        ["mr", "view", String(pr.number), "--repo", repoFlag(pr), "-F", "json"],
        resolveHostname(pr),
      );
      const data = parseJSON<{ state: string }>(raw, `getPRState for MR !${pr.number}`);
      return mapPRState(data.state);
    },

    async getPRSummary(pr: PRInfo) {
      const raw = await glab(
        ["mr", "view", String(pr.number), "--repo", repoFlag(pr), "-F", "json"],
        resolveHostname(pr),
      );
      const data = parseJSON<{ state: string; title: string }>(
        raw,
        `getPRSummary for MR !${pr.number}`,
      );
      return {
        state: mapPRState(data.state),
        title: data.title ?? "",
        additions: 0,
        deletions: 0,
      };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const args = ["mr", "merge", String(pr.number), "--repo", repoFlag(pr)];
      if (method === "squash") args.push("--squash");
      else if (method === "rebase") args.push("--rebase");
      args.push("-d", "-y");
      await glab(args, resolveHostname(pr));
    },

    async closePR(pr: PRInfo): Promise<void> {
      await glab(["mr", "close", String(pr.number), "--repo", repoFlag(pr)], resolveHostname(pr));
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        const apiBase = mrApiPath(pr);
        const hostname = resolveHostname(pr);

        const pipelinesRaw = await glab(
          ["api", `${apiBase}/pipelines`],
          hostname,
        );
        const pipelines = parseJSON<Array<{ id: number }>>(
          pipelinesRaw,
          `getCIChecks pipelines for MR !${pr.number}`,
        );
        if (pipelines.length === 0) return [];

        const latestPipelineId = pipelines[0].id;
        const projectId = encodeProjectId(pr.owner, pr.repo);

        const jobsRaw = await glab(
          ["api", `projects/${projectId}/pipelines/${latestPipelineId}/jobs`],
          hostname,
        );
        const jobs = parseJSON<
          Array<{
            name: string;
            status: string;
            web_url: string;
            started_at: string | null;
            finished_at: string | null;
          }>
        >(jobsRaw, `getCIChecks jobs for pipeline ${latestPipelineId}`);

        return jobs.map((j) => ({
          name: j.name,
          status: mapJobStatus(j.status),
          url: j.web_url || undefined,
          conclusion: j.status || undefined,
          startedAt: j.started_at ? new Date(j.started_at) : undefined,
          completedAt: j.finished_at ? new Date(j.finished_at) : undefined,
        }));
      } catch (err) {
        throw new Error("Failed to fetch CI checks", { cause: err });
      }
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch (err) {
        console.warn(`getCISummary: CI check fetch failed for MR !${pr.number}: ${(err as Error).message}`);
        try {
          const state = await this.getPRState(pr);
          if (state === "merged" || state === "closed") return "none";
        } catch (innerErr) {
          console.warn(`getCISummary: PR state fallback also failed for MR !${pr.number}: ${(innerErr as Error).message}`);
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
      const hostname = resolveHostname(pr);
      const reviews: Review[] = [];

      const approvalsRaw = await glab(
        ["api", `${mrApiPath(pr)}/approvals`],
        hostname,
      );
      const approvals = parseJSON<{
        approved_by: Array<{ user: { username: string } }>;
      }>(approvalsRaw, `getReviews approvals for MR !${pr.number}`);

      const approvedUsers = new Set<string>();
      for (const a of approvals.approved_by ?? []) {
        const author = a.user?.username ?? "unknown";
        approvedUsers.add(author);
        reviews.push({ author, state: "approved", submittedAt: new Date(0) });
      }

      try {
        const discussions = await fetchDiscussions(
          pr,
          hostname,
          `getReviews discussions for MR !${pr.number}`,
        );

        const requestedAuthors = new Set<string>();
        for (const d of discussions) {
          const note = d.notes[0];
          if (!note) continue;
          if (!note.resolvable || note.resolved) continue;
          const author = note.author?.username ?? "";
          if (isBot(author) || approvedUsers.has(author) || requestedAuthors.has(author)) continue;
          requestedAuthors.add(author);
          reviews.push({
            author,
            state: "changes_requested",
            submittedAt: parseDate(note.created_at),
          });
        }
      } catch (err) {
        console.warn(`getReviews: discussions fetch failed for MR !${pr.number}: ${(err as Error).message}`);
      }

      return reviews;
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const raw = await glab(
        ["api", `${mrApiPath(pr)}/approvals`],
        resolveHostname(pr),
      );
      const data = parseJSON<{ approved: boolean; approvals_left: number }>(
        raw,
        `getReviewDecision for MR !${pr.number}`,
      );

      if (data.approved) return "approved";
      if (data.approvals_left > 0) return "pending";
      return "none";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      const discussions = await fetchDiscussions(
        pr,
        resolveHostname(pr),
        `getPendingComments for MR !${pr.number}`,
      );

      const comments: ReviewComment[] = [];
      for (const d of discussions) {
        const note = d.notes[0];
        if (!note) continue;
        if (!note.resolvable || note.resolved) continue;
        if (isBot(note.author?.username ?? "")) continue;

        comments.push({
          id: String(note.id),
          author: note.author?.username ?? "unknown",
          body: note.body,
          path: note.position?.new_path || undefined,
          line: note.position?.new_line ?? undefined,
          isResolved: false,
          createdAt: parseDate(note.created_at),
          url: "",
        });
      }
      return comments;
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      const discussions = await fetchDiscussions(
        pr,
        resolveHostname(pr),
        `getAutomatedComments for MR !${pr.number}`,
      );

      const comments: AutomatedComment[] = [];
      for (const d of discussions) {
        const note = d.notes[0];
        if (!note) continue;
        const author = note.author?.username ?? "";
        if (!isBot(author)) continue;

        comments.push({
          id: String(note.id),
          botName: author,
          body: note.body,
          path: note.position?.new_path || undefined,
          line: note.position?.new_line ?? undefined,
          severity: inferSeverity(note.body),
          createdAt: parseDate(note.created_at),
          url: "",
        });
      }
      return comments;
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const hostname = resolveHostname(pr);

      const mrRaw = await glab(
        ["mr", "view", String(pr.number), "--repo", repoFlag(pr), "-F", "json"],
        hostname,
      );
      const mrData = parseJSON<{ state: string; draft: boolean }>(
        mrRaw,
        `getMergeability mr view for MR !${pr.number}`,
      );

      const state = mapPRState(mrData.state);
      if (state === "merged") {
        return {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        };
      }
      if (state === "closed") {
        return {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: true,
          blockers: ["MR is closed"],
        };
      }

      const apiRaw = await glab(
        ["api", mrApiPath(pr)],
        hostname,
      );
      const apiData = parseJSON<{
        merge_status: string;
        has_conflicts: boolean;
        blocking_discussions_resolved: boolean;
      }>(apiRaw, `getMergeability api for MR !${pr.number}`);

      const blockers: string[] = [];

      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      const reviewDecision = await this.getReviewDecision(pr);
      const approved = reviewDecision === "approved";
      if (reviewDecision === "pending") {
        blockers.push("Approval required");
      }

      const noConflicts = !apiData.has_conflicts;
      if (!noConflicts) {
        blockers.push("Merge conflicts");
      }

      if (apiData.merge_status === "cannot_be_merged" && noConflicts) {
        blockers.push("Merge status: cannot be merged");
      } else if (apiData.merge_status === "checking") {
        blockers.push("Merge status unknown (GitLab is computing)");
      }

      if (!apiData.blocking_discussions_resolved) {
        blockers.push("Unresolved discussions blocking merge");
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
  description: "SCM plugin: GitLab MRs, CI pipelines, reviews, merge readiness",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): SCM {
  return createGitLabSCM(config);
}

export default { manifest, create } satisfies PluginModule<SCM>;
