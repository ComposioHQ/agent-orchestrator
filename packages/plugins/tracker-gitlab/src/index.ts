/**
 * tracker-gitlab plugin — GitLab Issues as an issue tracker.
 *
 * Uses the `glab` CLI for all GitLab API interactions.
 * Supports both GitLab.com and self-hosted GitLab instances.
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

function getGitLabHost(project: ProjectConfig): string {
  const host = (project.scm?.["host"] as string) || (project.tracker?.["host"] as string);
  if (host) {
    return host.replace(/^https?:\/\//, "");
  }
  return process.env["GITLAB_HOST"] || "gitlab.com";
}

function getProjectPath(project: ProjectConfig): string {
  const projectPath =
    (project.tracker?.["projectPath"] as string) || (project.scm?.["projectPath"] as string);
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
        args.push("-f", `${key}=${String(value)}`);
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

function parseIssueIdentifier(identifier: string): string {
  const urlMatch = identifier.match(/\/-\/issues\/(\d+)/);
  if (urlMatch) {
    return urlMatch[1];
  }

  const scopedMatch = identifier.match(/#(\d+)$/);
  if (scopedMatch) {
    return scopedMatch[1];
  }

  return identifier.replace(/^#/, "");
}

function mapIssueState(state: string): Issue["state"] {
  const s = state.toLowerCase();
  if (s === "closed") {
    return "closed";
  }
  return "open";
}

function buildIssueUrl(host: string, projectPath: string, iid: string): string {
  return `https://${host}/${projectPath}/-/issues/${iid}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createGitLabTracker(): Tracker {
  return {
    name: "gitlab",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const host = getGitLabHost(project);
      const projectPath = getProjectPath(project);
      const iid = parseIssueIdentifier(identifier);

      const data = await glabApi<{
        iid: number;
        title: string;
        description: string | null;
        web_url: string;
        state: string;
        labels: string[];
        assignees: Array<{ username: string }> | null;
      }>(host, projectPath, `/issues/${iid}`);

      return {
        id: String(data.iid),
        title: data.title,
        description: data.description ?? "",
        url: data.web_url,
        state: mapIssueState(data.state),
        labels: Array.isArray(data.labels) ? data.labels : [],
        assignee: data.assignees?.[0]?.username,
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const host = getGitLabHost(project);
      const projectPath = getProjectPath(project);
      const iid = parseIssueIdentifier(identifier);

      const data = await glabApi<{ state: string }>(host, projectPath, `/issues/${iid}`);

      return data.state.toLowerCase() === "closed";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const host = getGitLabHost(project);
      const projectPath = getProjectPath(project);
      const iid = parseIssueIdentifier(identifier);
      return buildIssueUrl(host, projectPath, iid);
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      const match = url.match(/\/-\/issues\/(\d+)/);
      if (match) {
        return `#${match[1]}`;
      }
      const parts = url.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart ? `#${lastPart}` : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const iid = parseIssueIdentifier(identifier);
      return `issue/${iid}`;
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
      const host = getGitLabHost(project);
      const projectPath = getProjectPath(project);

      const params: Record<string, unknown> = {
        per_page: filters.limit ?? 30,
      };

      if (filters.state === "closed") {
        params["state"] = "closed";
      } else if (filters.state === "all") {
        params["state"] = "all";
      } else {
        params["state"] = "opened";
      }

      if (filters.labels && filters.labels.length > 0) {
        params["labels"] = filters.labels.join(",");
      }

      const queryString = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&");

      const data = await glabApi<
        Array<{
          iid: number;
          title: string;
          description: string | null;
          web_url: string;
          state: string;
          labels: string[];
          assignees: Array<{ username: string }> | null;
        }>
      >(host, projectPath, `/issues?${queryString}`);

      return data.map((item) => ({
        id: String(item.iid),
        title: item.title,
        description: item.description ?? "",
        url: item.web_url,
        state: mapIssueState(item.state),
        labels: Array.isArray(item.labels) ? item.labels : [],
        assignee: item.assignees?.[0]?.username,
      }));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const host = getGitLabHost(project);
      const projectPath = getProjectPath(project);
      const iid = parseIssueIdentifier(identifier);

      if (update.state === "closed") {
        await glabApi(host, projectPath, `/issues/${iid}`, "PUT", {
          state_event: "close",
        });
      } else if (update.state === "open") {
        await glabApi(host, projectPath, `/issues/${iid}`, "PUT", {
          state_event: "reopen",
        });
      }

      if (update.labels && update.labels.length > 0) {
        await glabApi(host, projectPath, `/issues/${iid}`, "PUT", {
          add_labels: update.labels.join(","),
        });
      }

      if (update.assignee) {
        const users = await glabApi<Array<{ id: number }>>(
          host,
          projectPath,
          `/users?username=${update.assignee}`,
        );
        if (users.length > 0) {
          await glabApi(host, projectPath, `/issues/${iid}`, "PUT", {
            assignee_ids: [users[0].id],
          });
        }
      }

      if (update.comment) {
        await glabApi(host, projectPath, `/issues/${iid}/notes`, "POST", {
          body: update.comment,
        });
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const host = getGitLabHost(project);
      const projectPath = getProjectPath(project);

      const data: Record<string, unknown> = {
        title: input.title,
        description: input.description ?? "",
      };

      if (input.labels && input.labels.length > 0) {
        data["labels"] = input.labels.join(",");
      }

      if (input.assignee) {
        const users = await glabApi<Array<{ id: number }>>(
          host,
          projectPath,
          `/users?username=${input.assignee}`,
        );
        if (users.length > 0) {
          data["assignee_ids"] = [users[0].id];
        }
      }

      const result = await glabApi<{
        iid: number;
        title: string;
        description: string | null;
        web_url: string;
        state: string;
        labels: string[];
        assignees: Array<{ username: string }> | null;
      }>(host, projectPath, "/issues", "POST", data);

      return {
        id: String(result.iid),
        title: result.title,
        description: result.description ?? "",
        url: result.web_url,
        state: mapIssueState(result.state),
        labels: Array.isArray(result.labels) ? result.labels : [],
        assignee: result.assignees?.[0]?.username,
      };
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
