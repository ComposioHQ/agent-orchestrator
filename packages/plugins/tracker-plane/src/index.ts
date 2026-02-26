/**
 * tracker-plane plugin -- Plane as an issue tracker.
 *
 * Uses the Plane API via fetch().
 * Auth: PLANE_API_TOKEN env var.
 * Host: PLANE_HOST env var (self-hosted or cloud, e.g. "https://app.plane.so").
 * Auth header: X-API-Key: {token}
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

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `${name} environment variable is required for the Plane tracker plugin`,
    );
  }
  return val;
}

function getBaseUrl(): string {
  const host = getEnv("PLANE_HOST");
  return host.replace(/\/+$/, "");
}

function getToken(): string {
  return getEnv("PLANE_API_TOKEN");
}

function getWorkspaceSlug(project: ProjectConfig): string {
  const slug = project.tracker?.["workspaceSlug"] as string | undefined;
  if (!slug) {
    throw new Error(
      "Plane tracker requires 'workspaceSlug' in project tracker config",
    );
  }
  return slug;
}

function getProjectId(project: ProjectConfig): string {
  const pid = project.tracker?.["projectId"] as string | undefined;
  if (!pid) {
    throw new Error(
      "Plane tracker requires 'projectId' in project tracker config",
    );
  }
  return pid;
}

interface PlaneFetchOptions {
  method?: string;
  body?: unknown;
}

async function planeFetch<T>(path: string, options: PlaneFetchOptions = {}): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    "X-API-Key": getToken(),
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
        `Plane API ${options.method ?? "GET"} ${path} returned ${res.status}: ${text.slice(0, 200)}`,
      );
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Plane API returned invalid JSON for ${path}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Types for Plane responses
// ---------------------------------------------------------------------------

interface PlaneIssue {
  id: string;
  sequence_id: number;
  name: string;
  description_html?: string;
  description_stripped?: string;
  state: string; // state UUID
  state_detail?: {
    id: string;
    name: string;
    group: string; // "backlog" | "unstarted" | "started" | "completed" | "cancelled"
  };
  labels: string[];
  label_detail?: Array<{ id: string; name: string }>;
  assignees: string[];
  assignee_detail?: Array<{ id: string; display_name: string }>;
  priority?: string; // "urgent" | "high" | "medium" | "low" | "none"
  project: string;
  workspace: string;
}

interface PlaneState {
  id: string;
  name: string;
  group: string; // "backlog" | "unstarted" | "started" | "completed" | "cancelled"
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapPlaneState(group: string): Issue["state"] {
  switch (group) {
    case "completed":
      return "closed";
    case "cancelled":
      return "cancelled";
    case "started":
      return "in_progress";
    case "backlog":
    case "unstarted":
    default:
      return "open";
  }
}

function mapPriority(priority: string | undefined): number | undefined {
  if (!priority) return undefined;
  const map: Record<string, number> = {
    urgent: 1,
    high: 2,
    medium: 3,
    low: 4,
    none: 0,
  };
  return map[priority];
}

function getIssueUrl(project: ProjectConfig, issue: PlaneIssue): string {
  const slug = getWorkspaceSlug(project);
  const pid = getProjectId(project);
  return `${getBaseUrl()}/${slug}/projects/${pid}/issues/${issue.id}`;
}

function toPlaneIssue(data: PlaneIssue, project: ProjectConfig): Issue {
  const stateGroup = data.state_detail?.group ?? "unstarted";
  return {
    id: String(data.sequence_id),
    title: data.name,
    description: data.description_stripped ?? "",
    url: getIssueUrl(project, data),
    state: mapPlaneState(stateGroup),
    labels: (data.label_detail ?? []).map((l) => l.name),
    assignee: data.assignee_detail?.[0]?.display_name,
    priority: mapPriority(data.priority),
  };
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createPlaneTracker(): Tracker {
  return {
    name: "plane",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const slug = getWorkspaceSlug(project);
      const pid = getProjectId(project);
      const data = await planeFetch<PlaneIssue>(
        `/api/v1/workspaces/${encodeURIComponent(slug)}/projects/${encodeURIComponent(pid)}/issues/${encodeURIComponent(identifier)}/`,
      );
      return toPlaneIssue(data, project);
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const slug = getWorkspaceSlug(project);
      const pid = getProjectId(project);
      const data = await planeFetch<PlaneIssue>(
        `/api/v1/workspaces/${encodeURIComponent(slug)}/projects/${encodeURIComponent(pid)}/issues/${encodeURIComponent(identifier)}/`,
      );
      const group = data.state_detail?.group ?? "unstarted";
      return group === "completed" || group === "cancelled";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const slug = getWorkspaceSlug(project);
      const pid = getProjectId(project);
      return `${getBaseUrl()}/${slug}/projects/${pid}/issues/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue ID from URL like .../issues/{uuid}
      const match = url.match(/\/issues\/([a-f0-9-]+)/i);
      if (match) return match[1].slice(0, 8);
      const parts = url.split("/");
      return parts[parts.length - 1] || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/plane-${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Plane issue #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.priority !== undefined) {
        const priorityNames: Record<number, string> = {
          0: "None",
          1: "Urgent",
          2: "High",
          3: "Medium",
          4: "Low",
        };
        lines.push(`Priority: ${priorityNames[issue.priority] ?? String(issue.priority)}`);
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
      const slug = getWorkspaceSlug(project);
      const pid = getProjectId(project);

      // First fetch states so we can filter by group
      const states = await planeFetch<PlaneState[]>(
        `/api/v1/workspaces/${encodeURIComponent(slug)}/projects/${encodeURIComponent(pid)}/states/`,
      );

      const params = new URLSearchParams();

      if (filters.state === "closed") {
        const closedStates = states
          .filter((s) => s.group === "completed" || s.group === "cancelled")
          .map((s) => s.id);
        if (closedStates.length > 0) {
          params.set("state__in", closedStates.join(","));
        }
      } else if (filters.state === "open") {
        const openStates = states
          .filter((s) => s.group !== "completed" && s.group !== "cancelled")
          .map((s) => s.id);
        if (openStates.length > 0) {
          params.set("state__in", openStates.join(","));
        }
      }
      // "all" = no state filter

      if (filters.assignee) {
        params.set("assignees", filters.assignee);
      }

      if (filters.labels && filters.labels.length > 0) {
        params.set("labels", filters.labels.join(","));
      }

      const queryStr = params.toString() ? `?${params.toString()}` : "";

      const data = await planeFetch<{ results: PlaneIssue[] } | PlaneIssue[]>(
        `/api/v1/workspaces/${encodeURIComponent(slug)}/projects/${encodeURIComponent(pid)}/issues/${queryStr}`,
      );

      // Plane API may return paginated or flat array
      const issues = Array.isArray(data) ? data : (data.results ?? []);
      const limit = filters.limit ?? 30;

      return issues.slice(0, limit).map((issue) => toPlaneIssue(issue, project));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const slug = getWorkspaceSlug(project);
      const pid = getProjectId(project);
      const basePath = `/api/v1/workspaces/${encodeURIComponent(slug)}/projects/${encodeURIComponent(pid)}/issues/${encodeURIComponent(identifier)}/`;

      const body: Record<string, unknown> = {};

      if (update.state) {
        // Fetch project states to find the correct state ID
        const states = await planeFetch<PlaneState[]>(
          `/api/v1/workspaces/${encodeURIComponent(slug)}/projects/${encodeURIComponent(pid)}/states/`,
        );

        const targetGroup =
          update.state === "closed"
            ? "completed"
            : update.state === "in_progress"
              ? "started"
              : "unstarted";

        const targetState = states.find((s) => s.group === targetGroup);
        if (targetState) {
          body["state"] = targetState.id;
        }
      }

      if (update.assignee) {
        // Plane expects assignee UUIDs; pass as-is
        body["assignees"] = [update.assignee];
      }

      if (update.labels && update.labels.length > 0) {
        // Plane expects label UUIDs; pass as-is
        body["labels"] = update.labels;
      }

      if (Object.keys(body).length > 0) {
        await planeFetch(basePath, {
          method: "PATCH",
          body,
        });
      }

      // Handle comment via issue activities/comments endpoint
      if (update.comment) {
        await planeFetch(
          `/api/v1/workspaces/${encodeURIComponent(slug)}/projects/${encodeURIComponent(pid)}/issues/${encodeURIComponent(identifier)}/comments/`,
          {
            method: "POST",
            body: { comment_html: `<p>${update.comment}</p>` },
          },
        );
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const slug = getWorkspaceSlug(project);
      const pid = getProjectId(project);

      const body: Record<string, unknown> = {
        name: input.title,
      };

      if (input.description) {
        body["description_html"] = `<p>${input.description}</p>`;
      }

      if (input.labels && input.labels.length > 0) {
        body["labels"] = input.labels;
      }

      if (input.assignee) {
        body["assignees"] = [input.assignee];
      }

      if (input.priority !== undefined) {
        const priorityMap: Record<number, string> = {
          0: "none",
          1: "urgent",
          2: "high",
          3: "medium",
          4: "low",
        };
        body["priority"] = priorityMap[input.priority] ?? "none";
      }

      const data = await planeFetch<PlaneIssue>(
        `/api/v1/workspaces/${encodeURIComponent(slug)}/projects/${encodeURIComponent(pid)}/issues/`,
        {
          method: "POST",
          body,
        },
      );

      return toPlaneIssue(data, project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "plane",
  slot: "tracker" as const,
  description: "Tracker plugin: Plane",
  version: "0.1.0",
};

export function create(): Tracker {
  return createPlaneTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
