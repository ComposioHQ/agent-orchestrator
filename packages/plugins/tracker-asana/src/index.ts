/**
 * tracker-asana plugin -- Asana as an issue tracker.
 *
 * Uses the Asana REST API via fetch().
 * Auth: ASANA_ACCESS_TOKEN env var.
 * Auth header: Bearer {token}
 * Base URL: https://app.asana.com/api/1.0
 * Workspace: ASANA_WORKSPACE_GID env var.
 */

import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://app.asana.com/api/1.0";

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `${name} environment variable is required for the Asana tracker plugin`,
    );
  }
  return val;
}

function getToken(): string {
  return getEnv("ASANA_ACCESS_TOKEN");
}

function getWorkspaceGid(): string {
  return getEnv("ASANA_WORKSPACE_GID");
}

function getProjectGid(project: ProjectConfig): string | undefined {
  return project.tracker?.["projectGid"] as string | undefined;
}

interface AsanaFetchOptions {
  method?: string;
  body?: unknown;
}

async function asanaFetch<T>(path: string, options: AsanaFetchOptions = {}): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getToken()}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Asana API ${options.method ?? "GET"} ${path} returned ${res.status}: ${text.slice(0, 200)}`,
      );
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Asana API returned invalid JSON for ${path}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Types for Asana responses
// ---------------------------------------------------------------------------

interface AsanaTask {
  gid: string;
  name: string;
  notes: string;
  html_notes?: string;
  completed: boolean;
  completed_at?: string;
  assignee?: { gid: string; name: string } | null;
  tags: Array<{ gid: string; name: string }>;
  memberships?: Array<{
    project: { gid: string; name: string };
    section?: { gid: string; name: string };
  }>;
  permalink_url: string;
  custom_fields?: Array<{
    gid: string;
    name: string;
    display_value?: string;
    number_value?: number;
  }>;
}

interface AsanaSection {
  gid: string;
  name: string;
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapAsanaState(task: AsanaTask): Issue["state"] {
  if (task.completed) return "closed";

  // Check section name for in-progress indicators
  if (task.memberships && task.memberships.length > 0) {
    const sectionName = task.memberships[0]?.section?.name?.toLowerCase() ?? "";
    if (
      sectionName.includes("progress") ||
      sectionName.includes("doing") ||
      sectionName.includes("active") ||
      sectionName.includes("review")
    ) {
      return "in_progress";
    }
  }

  return "open";
}

function toAsanaIssue(task: AsanaTask): Issue {
  // Try to extract priority from custom fields
  let priority: number | undefined;
  if (task.custom_fields) {
    const priorityField = task.custom_fields.find(
      (f) => f.name.toLowerCase() === "priority",
    );
    if (priorityField?.number_value !== undefined) {
      priority = priorityField.number_value;
    }
  }

  return {
    id: task.gid,
    title: task.name,
    description: task.notes ?? "",
    url: task.permalink_url,
    state: mapAsanaState(task),
    labels: (task.tags ?? []).map((t) => t.name),
    assignee: task.assignee?.name,
    priority,
  };
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

const TASK_OPT_FIELDS =
  "gid,name,notes,completed,completed_at,assignee,assignee.name,tags,tags.name,memberships.project.name,memberships.section.name,permalink_url,custom_fields";

function createAsanaTracker(): Tracker {
  return {
    name: "asana",

    async getIssue(identifier: string, _project: ProjectConfig): Promise<Issue> {
      const data = await asanaFetch<{ data: AsanaTask }>(
        `/tasks/${encodeURIComponent(identifier)}?opt_fields=${TASK_OPT_FIELDS}`,
      );
      return toAsanaIssue(data.data);
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const data = await asanaFetch<{ data: { completed: boolean } }>(
        `/tasks/${encodeURIComponent(identifier)}?opt_fields=completed`,
      );
      return data.data.completed;
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      return `https://app.asana.com/0/0/${identifier}/f`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract task GID from URL like https://app.asana.com/0/{project_gid}/{task_gid}/f
      const match = url.match(/\/(\d+)\/f$/);
      if (match) return match[1];
      // Alternative pattern: /0/0/{task_gid}
      const match2 = url.match(/\/0\/(\d+)(?:\/|$)/);
      if (match2) return match2[1];
      const parts = url.split("/");
      return parts[parts.length - 1] || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/asana-${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Asana task ${issue.id}: ${issue.title}`,
        `Task URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Tags: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this task. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const projectGid = getProjectGid(project);
      const limit = filters.limit ?? 30;

      if (projectGid) {
        // List tasks in a specific project
        const params = new URLSearchParams();
        params.set("opt_fields", TASK_OPT_FIELDS);
        params.set("limit", String(limit));

        if (filters.state === "closed") {
          params.set("completed_since", "2000-01-01T00:00:00.000Z");
        } else if (filters.state !== "all") {
          // Open only (default) - Asana returns incomplete tasks by default
        }

        if (filters.assignee) {
          params.set("assignee", filters.assignee);
        }

        const data = await asanaFetch<{ data: AsanaTask[] }>(
          `/projects/${encodeURIComponent(projectGid)}/tasks?${params.toString()}`,
        );

        let tasks = data.data ?? [];

        // Filter by state if needed (Asana doesn't have great state filtering)
        if (filters.state === "closed") {
          tasks = tasks.filter((t) => t.completed);
        } else if (filters.state === "open" || !filters.state) {
          tasks = tasks.filter((t) => !t.completed);
        }

        // Filter by tags if specified
        if (filters.labels && filters.labels.length > 0) {
          const labelSet = new Set(filters.labels.map((l) => l.toLowerCase()));
          tasks = tasks.filter((t) =>
            (t.tags ?? []).some((tag) => labelSet.has(tag.name.toLowerCase())),
          );
        }

        return tasks.slice(0, limit).map(toAsanaIssue);
      }

      // Fallback: search tasks in workspace
      const workspaceGid = getWorkspaceGid();
      const params = new URLSearchParams();
      params.set("opt_fields", TASK_OPT_FIELDS);
      params.set("limit", String(limit));

      if (filters.state === "closed") {
        params.set("completed", "true");
      } else if (filters.state !== "all") {
        params.set("completed", "false");
      }

      if (filters.assignee) {
        params.set("assignee", filters.assignee);
      }

      const data = await asanaFetch<{ data: AsanaTask[] }>(
        `/workspaces/${encodeURIComponent(workspaceGid)}/tasks?${params.toString()}`,
      );

      let tasks = data.data ?? [];

      if (filters.labels && filters.labels.length > 0) {
        const labelSet = new Set(filters.labels.map((l) => l.toLowerCase()));
        tasks = tasks.filter((t) =>
          (t.tags ?? []).some((tag) => labelSet.has(tag.name.toLowerCase())),
        );
      }

      return tasks.slice(0, limit).map(toAsanaIssue);
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      const body: Record<string, unknown> = {};

      if (update.state) {
        body["completed"] = update.state === "closed";
      }

      if (update.assignee) {
        // Asana expects assignee GID; pass as-is
        body["assignee"] = update.assignee;
      }

      if (Object.keys(body).length > 0) {
        await asanaFetch(`/tasks/${encodeURIComponent(identifier)}`, {
          method: "PUT",
          body: { data: body },
        });
      }

      // Handle labels (tags) — add tags to the task
      if (update.labels && update.labels.length > 0) {
        for (const tagGid of update.labels) {
          await asanaFetch(
            `/tasks/${encodeURIComponent(identifier)}/addTag`,
            {
              method: "POST",
              body: { data: { tag: tagGid } },
            },
          );
        }
      }

      // Handle comment (Asana calls them "stories")
      if (update.comment) {
        await asanaFetch(
          `/tasks/${encodeURIComponent(identifier)}/stories`,
          {
            method: "POST",
            body: { data: { text: update.comment } },
          },
        );
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const workspaceGid = getWorkspaceGid();
      const projectGid = getProjectGid(project);

      const body: Record<string, unknown> = {
        name: input.title,
        notes: input.description ?? "",
        workspace: workspaceGid,
      };

      if (projectGid) {
        body["projects"] = [projectGid];
      }

      if (input.assignee) {
        body["assignee"] = input.assignee;
      }

      const data = await asanaFetch<{ data: AsanaTask }>(
        `/tasks?opt_fields=${TASK_OPT_FIELDS}`,
        {
          method: "POST",
          body: { data: body },
        },
      );

      const task = data.data;

      // Add tags after creation
      if (input.labels && input.labels.length > 0) {
        for (const tagGid of input.labels) {
          try {
            await asanaFetch(
              `/tasks/${encodeURIComponent(task.gid)}/addTag`,
              {
                method: "POST",
                body: { data: { tag: tagGid } },
              },
            );
          } catch {
            // Tags are best-effort
          }
        }
      }

      return toAsanaIssue(task);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "asana",
  slot: "tracker" as const,
  description: "Tracker plugin: Asana",
  version: "0.1.0",
};

export function create(): Tracker {
  return createAsanaTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
