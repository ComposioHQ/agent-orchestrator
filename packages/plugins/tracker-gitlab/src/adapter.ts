import type {
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";
import { GitLabClient } from "./client.js";

export type GitLabPluginConfig = {
  token?: string;
  baseUrl?: string;
  webhookSecret?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

function parseIid(identifier: string): number {
  const m = identifier.replace(/^#/, "").trim();
  const n = Number(m);
  if (!Number.isFinite(n)) throw new Error(`Invalid issue identifier: ${identifier}`);
  return n;
}

function mapState(state: string | undefined): Issue["state"] {
  const s = (state ?? "").toLowerCase();
  if (s === "closed") return "closed";
  if (s === "reopened" || s === "opened") return "open";
  return "open";
}

function projectToPath(project: ProjectConfig): string {
  // Expect project.repo to be "group/project" or numeric id
  const repo = project.repo;
  if (!repo) throw new Error("project.repo is required for GitLab tracker");
  return encodeURIComponent(String(repo));
}

export function createGitLabTracker(cfg: GitLabPluginConfig = {}): Tracker {
  const token = cfg.token ?? process.env["GITLAB_TOKEN"];
  if (!token) throw new Error("GITLAB_TOKEN (or plugin config.token) is required for tracker-gitlab");

  const client = new GitLabClient({
    baseUrl: cfg.baseUrl,
    token,
    timeoutMs: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
  });

  return {
    name: "gitlab",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const iid = parseIid(identifier);
      const proj = projectToPath(project);
      const data = await client.get<any>(`/projects/${proj}/issues/${iid}`);
      if (data == null) {
        throw new Error(`GitLab API returned empty body for GET /projects/${proj}/issues/${iid}`);
      }
      return {
        id: String(data.iid),
        title: data.title,
        description: data.description ?? "",
        url: data.web_url ?? "",
        state: mapState(data.state),
        labels: (data.labels ?? []) as string[],
        assignee: (data.assignees && data.assignees[0]?.username) ?? undefined,
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const iid = parseIid(identifier);
      const proj = projectToPath(project);
      const data = await client.get<any>(`/projects/${proj}/issues/${iid}`);
      return String(data.state).toLowerCase() === "closed";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      // GitLab issue URL format: <origin>/<group>/<project>/-/issues/<iid>
      const num = identifier.replace(/^#/, "").trim();

      let origin: string;
      try {
        const apiUrl = new URL((client as any).baseUrl);
        origin = apiUrl.origin;
      } catch {
        origin = "https://";
      }

      const repoRaw = String(project.repo ?? "").trim();
      const repoPath =
        repoRaw === "" ? "" : repoRaw.split("/").map((s) => encodeURIComponent(s)).join("/");

      return repoPath ? `${origin}/${repoPath}/-/issues/${encodeURIComponent(num)}` : `${origin}/-/issues/${encodeURIComponent(num)}`;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `feat/issue-${num}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines: string[] = [
        `You are working on GitLab issue #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];
      if (issue.labels && issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }
      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }
      lines.push("", "Please implement the changes described in this issue. When done, commit and push your changes.");
      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const proj = projectToPath(project);
      const query: Record<string, string | number | undefined> = { per_page: filters.limit ?? 30 };
      if (filters.state === "closed") query["state"] = "closed";
      else if (filters.state === "all") query["state"] = undefined;
      else query["state"] = "opened";

      if (filters.assignee) query["assignee_username"] = filters.assignee;
      if (filters.labels && filters.labels.length > 0) query["labels"] = filters.labels.join(",");

      const data = await client.get<any[]>(`/projects/${proj}/issues`, query);
      return (data ?? []).map((d) => ({
        id: String(d.iid),
        title: d.title,
        description: d.description ?? "",
        url: d.web_url,
        state: mapState(d.state),
        labels: d.labels ?? [],
        assignee: d.assignees && d.assignees[0]?.username,
      }));
    },

    async updateIssue(identifier: string, update: IssueUpdate, project: ProjectConfig): Promise<void> {
      const iid = parseIid(identifier);
      const proj = projectToPath(project);
      const payload: Record<string, unknown> = {};

      if (update.state) {
        if (update.state === "closed") payload["state_event"] = "close";
        else if (update.state === "open") payload["state_event"] = "reopen";
        // in_progress has no direct mapping — skip
      }

      if (update.labels && update.labels.length > 0) {
        payload["labels"] = update.labels.join(",");
      }

      if (update.assignee) {
        // GitLab requires assignee_ids (array). Try to resolve username -> id via users endpoint
        try {
          const users = await client.get<any[]>("/users", { username: update.assignee });
          const uid = users?.[0]?.id;
          if (uid) payload["assignee_ids"] = [uid];
        } catch {
          // Best-effort; don't fail update if user lookup fails
        }
      }

      if (update.comment) {
        // Add note first (comments are separate)
        await client.post(`/projects/${proj}/issues/${iid}/notes`, { body: update.comment });
      }

      // If there is something to update, call update endpoint
      if (Object.keys(payload).length > 0) {
        await client.put(`/projects/${proj}/issues/${iid}`, payload);
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const proj = projectToPath(project);
      const payload: Record<string, unknown> = {
        title: input.title,
        description: input.description ?? "",
      };
      if (input.labels && input.labels.length > 0) payload["labels"] = input.labels.join(",");
      if (input.assignee) {
        // Try best-effort to resolve username to id
        try {
          const users = await client.get<any[]>("/users", { username: input.assignee });
          const uid = users?.[0]?.id;
          if (uid) payload["assignee_ids"] = [uid];
        } catch {
          // ignore
        }
      }

      const created = await client.post<any>(`/projects/${proj}/issues`, payload);
      if (created == null) {
          throw new Error(`GitLab API returned empty body for POST /projects/${proj}/issues`);
      }
      return {
          id: String(created.iid),
          title: created.title,
          description: created.description ?? "",
          url: created.web_url,
          state: mapState(created.state),
          labels: created.labels ?? [],
          assignee: created.assignees && created.assignees[0]?.username,
      };
    },
  };
}