/**
 * tracker-gitlab plugin — GitLab Issues as an issue tracker.
 *
 * Uses the `glab` CLI (official GitLab CLI) for all API interactions.
 * Supports self-hosted GitLab instances (configured via `glab config`).
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

function mapState(glState: string): Issue["state"] {
  const s = glState.toLowerCase();
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
      const num = identifier.replace(/^#/, "");
      const raw = await glab([
        "issue",
        "view",
        num,
        "--repo",
        project.repo,
        "--output",
        "json",
      ]);

      const data: {
        iid: number;
        title: string;
        description: string;
        state: string;
        labels: string[];
        assignees: Array<{ username: string }>;
        web_url: string;
      } = JSON.parse(raw);

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
      const num = identifier.replace(/^#/, "");
      const raw = await glab([
        "issue",
        "view",
        num,
        "--repo",
        project.repo,
        "--output",
        "json",
      ]);
      const data: { state: string } = JSON.parse(raw);
      return data.state.toLowerCase() === "closed";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `https://gitlab.com/${project.repo}/-/issues/${num}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue number from GitLab URL
      // Example: https://gitlab.com/group/project/-/issues/42 → "#42"
      const match = url.match(/\/-\/issues\/(\d+)/);
      if (match) {
        return `#${match[1]}`;
      }
      // Fallback: return the last segment of the URL
      const parts = url.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart ? `#${lastPart}` : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `feat/issue-${num}`;
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
      // default: open issues

      if (filters.labels && filters.labels.length > 0) {
        args.push("--label", filters.labels.join(","));
      }

      if (filters.assignee) {
        args.push("--assignee", filters.assignee);
      }

      const raw = await glab(args);
      const issues: Array<{
        iid: number;
        title: string;
        description: string;
        state: string;
        labels: string[];
        assignees: Array<{ username: string }>;
        web_url: string;
      }> = JSON.parse(raw);

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
      const num = identifier.replace(/^#/, "");

      // Handle state change
      if (update.state === "closed") {
        await glab(["issue", "close", num, "--repo", project.repo]);
      } else if (update.state === "open") {
        await glab(["issue", "reopen", num, "--repo", project.repo]);
      }

      // Handle label and assignee changes via edit
      const editArgs: string[] = [];

      if (update.labels && update.labels.length > 0) {
        editArgs.push("--label", update.labels.join(","));
      }

      if (update.assignee) {
        editArgs.push("--assignee", update.assignee);
      }

      if (editArgs.length > 0) {
        await glab(["issue", "update", num, "--repo", project.repo, ...editArgs]);
      }

      // Handle comment
      if (update.comment) {
        await glab([
          "issue",
          "note",
          num,
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
        "--output",
        "json",
      ];

      if (input.labels && input.labels.length > 0) {
        args.push("--label", input.labels.join(","));
      }

      if (input.assignee) {
        args.push("--assignee", input.assignee);
      }

      const raw = await glab(args);
      const data: { iid: number } = JSON.parse(raw);

      return this.getIssue(String(data.iid), project);
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
