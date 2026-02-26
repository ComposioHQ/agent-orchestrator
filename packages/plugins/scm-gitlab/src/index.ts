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

export const manifest = {
  name: "gitlab",
  slot: "scm" as const,
  description: "SCM plugin: GitLab merge requests",
  version: "0.1.0",
};

async function glab(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("glab", args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

function repoParts(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo format '${repo}', expected owner/name`);
  return { owner, name };
}

function mapMrState(state: string): PRState {
  const s = state.toLowerCase();
  if (s === "merged") return "merged";
  if (s === "closed") return "closed";
  return "open";
}

function createGitLabSCM(): SCM {
  return {
    name: "gitlab",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;
      const { owner, name } = repoParts(project.repo);

      try {
        const raw = await glab([
          "mr",
          "list",
          "--repo",
          project.repo,
          "--source-branch",
          session.branch,
          "--per-page",
          "1",
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
        }> = JSON.parse(raw || "[]");

        const mr = mrs[0];
        if (!mr) return null;

        return {
          number: mr.iid,
          url: mr.web_url,
          title: mr.title,
          owner,
          repo: name,
          branch: mr.source_branch,
          baseBranch: mr.target_branch,
          isDraft: mr.draft,
        };
      } catch {
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const raw = await glab(["mr", "view", String(pr.number), "--repo", `${pr.owner}/${pr.repo}`, "--output", "json"]);
      const mr: { state: string } = JSON.parse(raw);
      return mapMrState(mr.state);
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const args = ["mr", "merge", String(pr.number), "--repo", `${pr.owner}/${pr.repo}`];
      if (method === "squash") args.push("--squash");
      if (method === "rebase") args.push("--rebase");
      await glab(args);
    },

    async closePR(pr: PRInfo): Promise<void> {
      await glab(["mr", "close", String(pr.number), "--repo", `${pr.owner}/${pr.repo}`]);
    },

    async getCIChecks(_pr: PRInfo): Promise<CICheck[]> {
      return [];
    },

    async getCISummary(_pr: PRInfo): Promise<CIStatus> {
      return CI_STATUS.NONE;
    },

    async getReviews(_pr: PRInfo): Promise<Review[]> {
      return [];
    },

    async getReviewDecision(_pr: PRInfo): Promise<ReviewDecision> {
      return "none";
    },

    async getPendingComments(_pr: PRInfo): Promise<ReviewComment[]> {
      return [];
    },

    async getAutomatedComments(_pr: PRInfo): Promise<AutomatedComment[]> {
      return [];
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const state = await this.getPRState(pr);
      const open = state === "open";
      return {
        mergeable: open,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: open ? [] : ["Merge request is not open"],
      };
    },
  };
}

export function create(): SCM {
  return createGitLabSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
