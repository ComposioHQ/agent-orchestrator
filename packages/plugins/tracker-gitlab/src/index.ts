/**
 * tracker-gitlab plugin — GitLab Issues as an issue tracker.
 *
 * Uses the `glab` CLI for all GitLab API interactions.
 */

import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@aoagents/ao-core";

import { glab, parseJSON, extractHost, stripHost } from "@aoagents/ao-plugin-scm-gitlab/glab-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GitLabIssueData {
  iid: number;
  title: string;
  description: string;
  web_url: string;
  state: string;
  labels: string[];
  assignees: Array<{ username: string }>;
}

function toIssue(data: GitLabIssueData): Issue {
  return {
    id: String(data.iid),
    title: data.title,
    description: data.description ?? "",
    url: data.web_url,
    state: data.state.toLowerCase() === "closed" ? "closed" : "open",
    labels: data.labels ?? [],
    assignee: data.assignees?.[0]?.username,
  };
}

function buildGitLabBaseUrl(host: string): string {
  if (/^https?:\/\//.test(host)) return host.replace(/\/+$/, "");
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  return `${protocol}://${host}`;
}

function parseIssueIdentifierFromUrl(url: string): string | null {
  const match = url.match(/\/-\/(?:issues|work_items)\/(\d+)(?:\/)?$/);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createGitLabTracker(config?: Record<string, unknown>): Tracker {
  const configHostname = typeof config?.host === "string" ? config.host : undefined;

  /** Host for glab: YAML host, else hostname embedded in project.repo (self-hosted path). */
  function resolveHost(project: ProjectConfig): string | undefined {
    return configHostname ?? extractHost(project.repo);
  }

  return {
    name: "gitlab",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const raw = await glab(
        ["issue", "view", identifier, "--repo", project.repo, "-F", "json"],
        resolveHost(project),
      );
      return toIssue(parseJSON<GitLabIssueData>(raw, `getIssue for issue ${identifier}`));
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const raw = await glab(
        ["issue", "view", identifier, "--repo", project.repo, "-F", "json"],
        resolveHost(project),
      );
      const data = parseJSON<{ state: string }>(raw, `isCompleted for issue ${identifier}`);
      return data.state.toLowerCase() === "closed";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      const host = resolveHost(project) ?? "gitlab.com";
      return `${buildGitLabBaseUrl(host)}/${stripHost(project.repo)}/-/issues/${num}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      const issueId = parseIssueIdentifierFromUrl(url);
      if (issueId) return `#${issueId}`;
      const parts = url.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart ? `#${lastPart}` : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/issue-${identifier.replace(/^#/, "")}`;
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
        "-O",
        "json",
        "-P",
        String(filters.limit ?? 30),
      ];

      if (filters.state === "closed") {
        args.push("--closed");
      } else if (filters.state === "all") {
        args.push("--all");
      }

      if (filters.labels && filters.labels.length > 0) {
        for (const label of filters.labels) {
          args.push("--label", label);
        }
      }

      if (filters.assignee) {
        args.push("--assignee", filters.assignee);
      }

      const raw = await glab(args, resolveHost(project));
      const issues = parseJSON<GitLabIssueData[]>(raw, "listIssues");
      return issues.map(toIssue);
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      if (update.state === "closed") {
        await glab(["issue", "close", identifier, "--repo", project.repo], resolveHost(project));
      } else if (update.state === "open") {
        await glab(["issue", "reopen", identifier, "--repo", project.repo], resolveHost(project));
      }

      if (update.labels && update.labels.length > 0) {
        await glab(
          [
            "issue",
            "update",
            identifier,
            "--repo",
            project.repo,
            "--label",
            update.labels.join(","),
          ],
          resolveHost(project),
        );
      }

      if (update.removeLabels && update.removeLabels.length > 0) {
        await glab(
          [
            "issue",
            "update",
            identifier,
            "--repo",
            project.repo,
            "--unlabel",
            update.removeLabels.join(","),
          ],
          resolveHost(project),
        );
      }

      if (update.comment) {
        await glab(
          ["issue", "note", identifier, "--repo", project.repo, "-m", update.comment],
          resolveHost(project),
        );
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

      const url = await glab(args, resolveHost(project));

      const issueId = parseIssueIdentifierFromUrl(url);
      if (!issueId) {
        throw new Error(`Failed to parse issue URL from glab output: ${url}`);
      }

      return this.getIssue(issueId, project);
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

export function create(config?: Record<string, unknown>): Tracker {
  return createGitLabTracker(config);
}

export default { manifest, create } satisfies PluginModule<Tracker>;
