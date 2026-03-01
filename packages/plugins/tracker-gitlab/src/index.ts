/**
 * tracker-gitlab plugin -- GitLab Issues as an issue tracker.
 *
 * Uses the `glab` CLI for all GitLab API interactions (mirrors tracker-github pattern).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

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

function mapState(glabState: string): Issue["state"] {
  const s = glabState.toLowerCase();
  if (s === "closed") return "closed";
  return "open";
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createGitLabTracker(): Tracker {
  return {
    name: "gitlab",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const raw = await glab([
        "issue",
        "view",
        identifier,
        "--repo",
        project.repo,
        "--output",
        "json",
      ]);

      let data: {
        iid: number;
        title: string;
        description: string;
        web_url: string;
        state: string;
        labels: string[];
        assignees: Array<{ username: string }>;
      };
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Failed to parse glab output for issue ${identifier}: ${raw.slice(0, 200)}`);
      }

      return {
        id: String(data.iid),
        title: data.title,
        description: data.description ?? "",
        url: data.web_url,
        state: mapState(data.state),
        labels: data.labels ?? [],
        assignee: data.assignees?.[0]?.username,
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const raw = await glab([
        "issue",
        "view",
        identifier,
        "--repo",
        project.repo,
        "--output",
        "json",
      ]);

      let data: { state: string };
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Failed to parse glab output: ${raw.slice(0, 200)}`);
      }

      return data.state.toLowerCase() === "closed";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      // GitLab URL: https://gitlab.com/{owner}/{repo}/-/issues/{iid}
      const host = process.env["GITLAB_HOST"] ?? "https://gitlab.com";
      return `${host.replace(/\/+$/, "")}/${project.repo}/-/issues/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue IID from GitLab URL
      // Example: https://gitlab.com/owner/repo/-/issues/42 -> "#42"
      const match = url.match(/\/-\/issues\/(\d+)/);
      if (match) return `#${match[1]}`;
      const parts = url.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart ? `#${lastPart}` : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/issue-${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on GitLab issue #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const args = [
        "issue",
        "list",
        "--repo",
        project.repo,
        "--output",
        "json",
        "--per-page",
        String(filters.limit ?? 30),
      ];

      if (filters.state === "closed") {
        args.push("--closed");
      } else if (filters.state === "all") {
        args.push("--all");
      }
      // default is open

      if (filters.labels && filters.labels.length > 0) {
        args.push("--label", filters.labels.join(","));
      }

      if (filters.assignee) {
        args.push("--assignee", filters.assignee);
      }

      const raw = await glab(args);
      let issues: Array<{
        iid: number;
        title: string;
        description: string;
        web_url: string;
        state: string;
        labels: string[];
        assignees: Array<{ username: string }>;
      }>;
      try {
        issues = JSON.parse(raw);
      } catch {
        throw new Error(`Failed to parse glab issue list output: ${raw.slice(0, 200)}`);
      }

      return issues.map((data) => ({
        id: String(data.iid),
        title: data.title,
        description: data.description ?? "",
        url: data.web_url,
        state: mapState(data.state),
        labels: data.labels ?? [],
        assignee: data.assignees?.[0]?.username,
      }));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      if (update.state === "closed") {
        await glab(["issue", "close", identifier, "--repo", project.repo]);
      } else if (update.state === "open") {
        await glab(["issue", "reopen", identifier, "--repo", project.repo]);
      }

      if (update.labels && update.labels.length > 0) {
        await glab([
          "issue",
          "update",
          identifier,
          "--repo",
          project.repo,
          "--label",
          update.labels.join(","),
        ]);
      }

      if (update.assignee) {
        await glab([
          "issue",
          "update",
          identifier,
          "--repo",
          project.repo,
          "--assignee",
          update.assignee,
        ]);
      }

      if (update.comment) {
        await glab([
          "issue",
          "note",
          identifier,
          "--repo",
          project.repo,
          "--message",
          update.comment,
        ]);
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const args = [
        "issue",
        "create",
        "--repo",
        project.repo,
        "--title",
        input.title,
        "--description",
        input.description ?? "",
      ];

      if (input.labels && input.labels.length > 0) {
        args.push("--label", input.labels.join(","));
      }

      if (input.assignee) {
        args.push("--assignee", input.assignee);
      }

      const raw = await glab(args);

      // glab issue create outputs the URL; extract iid
      const match = raw.match(/\/-\/issues\/(\d+)/);
      if (!match) {
        throw new Error(`Failed to parse issue IID from glab output: ${raw}`);
      }

      return this.getIssue(match[1], project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "gitlab",
  slot: "tracker" as const,
  description: "Tracker plugin: GitLab Issues",
  version: "0.1.0",
};

export function create(): Tracker {
  return createGitLabTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
