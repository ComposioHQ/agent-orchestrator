/**
 * tracker-clickup plugin -- ClickUp as an issue tracker.
 *
 * Uses the ClickUp API v2 via fetch().
 * Auth: CLICKUP_API_TOKEN env var.
 * Auth header: Authorization: {token}
 * Base URL: https://api.clickup.com/api/v2
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

const BASE_URL = "https://api.clickup.com/api/v2";

function getToken(): string {
  const token = process.env["CLICKUP_API_TOKEN"];
  if (!token) {
    throw new Error(
      "CLICKUP_API_TOKEN environment variable is required for the ClickUp tracker plugin",
    );
  }
  return token;
}

function getListId(project: ProjectConfig): string {
  const listId = project.tracker?.["listId"] as string | undefined;
  if (!listId) {
    throw new Error(
      "ClickUp tracker requires 'listId' in project tracker config",
    );
  }
  return listId;
}

interface ClickUpFetchOptions {
  method?: string;
  body?: unknown;
}

async function clickupFetch<T>(path: string, options: ClickUpFetchOptions = {}): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: getToken(),
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
        `ClickUp API ${options.method ?? "GET"} ${path} returned ${res.status}: ${text.slice(0, 200)}`,
      );
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`ClickUp API returned invalid JSON for ${path}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Types for ClickUp responses
// ---------------------------------------------------------------------------

interface ClickUpTask {
  id: string;
  custom_id?: string;
  name: string;
  description?: string;
  text_content?: string;
  status: {
    status: string;
    type: string; // "open" | "custom" | "closed" | "done"
  };
  tags: Array<{ name: string }>;
  assignees: Array<{ username: string; profilePicture?: string }>;
  priority?: {
    id: string;
    priority: string; // "urgent" | "high" | "normal" | "low"
  };
  url: string;
  list: { id: string };
}

interface ClickUpStatus {
  status: string;
  type: string;
  orderindex: number;
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapClickUpState(task: ClickUpTask): Issue["state"] {
  const type = task.status.type.toLowerCase();
  if (type === "closed" || type === "done") return "closed";
  if (type === "custom") {
    // Custom statuses — check the status name for common patterns
    const name = task.status.status.toLowerCase();
    if (name.includes("done") || name.includes("complete") || name.includes("closed")) {
      return "closed";
    }
    if (name.includes("progress") || name.includes("review") || name.includes("active")) {
      return "in_progress";
    }
    return "open";
  }
  if (type === "open") return "open";
  return "open";
}

function mapPriority(priority: ClickUpTask["priority"]): number | undefined {
  if (!priority) return undefined;
  // ClickUp priority: 1=urgent, 2=high, 3=normal, 4=low
  const val = Number(priority.id);
  return Number.isFinite(val) ? val : undefined;
}

function toClickUpIssue(task: ClickUpTask): Issue {
  return {
    id: task.custom_id ?? task.id,
    title: task.name,
    description: task.text_content ?? task.description ?? "",
    url: task.url,
    state: mapClickUpState(task),
    labels: (task.tags ?? []).map((t) => t.name),
    assignee: task.assignees?.[0]?.username,
    priority: mapPriority(task.priority),
  };
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createClickUpTracker(): Tracker {
  return {
    name: "clickup",

    async getIssue(identifier: string, _project: ProjectConfig): Promise<Issue> {
      const task = await clickupFetch<ClickUpTask>(
        `/task/${encodeURIComponent(identifier)}`,
      );
      return toClickUpIssue(task);
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const task = await clickupFetch<ClickUpTask>(
        `/task/${encodeURIComponent(identifier)}`,
      );
      const type = task.status.type.toLowerCase();
      return type === "closed" || type === "done";
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      return `https://app.clickup.com/t/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract task ID from URL like https://app.clickup.com/t/86abcdef
      const match = url.match(/\/t\/([a-z0-9]+)/i);
      if (match) return `CU-${match[1]}`;
      const parts = url.split("/");
      return parts[parts.length - 1] || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/cu-${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on ClickUp task ${issue.id}: ${issue.title}`,
        `Task URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Tags: ${issue.labels.join(", ")}`);
      }

      if (issue.priority !== undefined) {
        const priorityNames: Record<number, string> = {
          1: "Urgent",
          2: "High",
          3: "Normal",
          4: "Low",
        };
        lines.push(`Priority: ${priorityNames[issue.priority] ?? String(issue.priority)}`);
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
      const listId = getListId(project);
      const params = new URLSearchParams();

      if (filters.state === "closed") {
        params.set("include_closed", "true");
        params.set("statuses[]", "closed");
      } else if (filters.state === "all") {
        params.set("include_closed", "true");
      }
      // default is open only

      if (filters.assignee) {
        // ClickUp expects assignee user IDs; use assignee as-is (caller provides user ID or name)
        params.set("assignees[]", filters.assignee);
      }

      if (filters.labels && filters.labels.length > 0) {
        for (const label of filters.labels) {
          params.append("tags[]", label);
        }
      }

      const page = 0;
      const limit = filters.limit ?? 30;
      params.set("page", String(page));
      params.set("subtasks", "true");

      const data = await clickupFetch<{ tasks: ClickUpTask[] }>(
        `/list/${encodeURIComponent(listId)}/task?${params.toString()}`,
      );

      return (data.tasks ?? []).slice(0, limit).map(toClickUpIssue);
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const body: Record<string, unknown> = {};

      if (update.state) {
        // Need to find the actual status name from the list's statuses
        const listId = getListId(project);
        const list = await clickupFetch<{ statuses: ClickUpStatus[] }>(
          `/list/${encodeURIComponent(listId)}`,
        );

        let targetStatus: string | undefined;

        if (update.state === "closed") {
          const closedStatus = list.statuses.find(
            (s) => s.type === "closed" || s.type === "done",
          );
          targetStatus = closedStatus?.status ?? "closed";
        } else if (update.state === "in_progress") {
          const inProgressStatus = list.statuses.find(
            (s) =>
              s.type === "custom" &&
              (s.status.toLowerCase().includes("progress") ||
                s.status.toLowerCase().includes("active")),
          );
          targetStatus = inProgressStatus?.status ?? "in progress";
        } else {
          const openStatus = list.statuses.find((s) => s.type === "open");
          targetStatus = openStatus?.status ?? "to do";
        }

        body["status"] = targetStatus;
      }

      if (update.assignee) {
        // ClickUp needs user IDs for assignees; pass as-is
        body["assignees"] = { add: [update.assignee] };
      }

      if (update.labels && update.labels.length > 0) {
        // ClickUp tags via separate endpoint
        for (const tag of update.labels) {
          await clickupFetch(
            `/task/${encodeURIComponent(identifier)}/tag/${encodeURIComponent(tag)}`,
            { method: "POST" },
          );
        }
      }

      if (Object.keys(body).length > 0) {
        await clickupFetch(`/task/${encodeURIComponent(identifier)}`, {
          method: "PUT",
          body,
        });
      }

      // Handle comment
      if (update.comment) {
        await clickupFetch(
          `/task/${encodeURIComponent(identifier)}/comment`,
          {
            method: "POST",
            body: { comment_text: update.comment },
          },
        );
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const listId = getListId(project);

      const body: Record<string, unknown> = {
        name: input.title,
        description: input.description ?? "",
      };

      if (input.assignee) {
        body["assignees"] = [input.assignee];
      }

      if (input.priority !== undefined) {
        body["priority"] = input.priority;
      }

      if (input.labels && input.labels.length > 0) {
        body["tags"] = input.labels;
      }

      const task = await clickupFetch<ClickUpTask>(
        `/list/${encodeURIComponent(listId)}/task`,
        {
          method: "POST",
          body,
        },
      );

      return toClickUpIssue(task);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "clickup",
  slot: "tracker" as const,
  description: "Tracker plugin: ClickUp",
  version: "0.1.0",
};

export function create(): Tracker {
  return createClickUpTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
