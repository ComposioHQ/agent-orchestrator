/**
 * tracker-clickup plugin — ClickUp as an issue tracker.
 *
 * Uses the ClickUp API v2 for all interactions.
 * Authentication via CLICKUP_API_TOKEN environment variable.
 */

import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
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
// API client
// ---------------------------------------------------------------------------

const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";
const REQUEST_TIMEOUT_MS = 30_000;

function getApiToken(): string {
  const token = process.env["CLICKUP_API_TOKEN"];
  if (!token) {
    throw new Error(
      "CLICKUP_API_TOKEN environment variable is required for the ClickUp tracker plugin",
    );
  }
  return token;
}

interface ClickUpErrorResponse {
  err?: string;
  ECODE?: string;
}

function clickUpRequest<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const token = getApiToken();
  const url = new URL(`${CLICKUP_API_BASE}${path}`);
  const payload = body ? JSON.stringify(body) : undefined;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const req = httpsRequest(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": String(Buffer.byteLength(payload)) } : {}),
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("error", (err: Error) => settle(() => reject(err)));
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          settle(() => {
            try {
              const text = Buffer.concat(chunks).toString("utf-8");
              const status = res.statusCode ?? 0;

              if (status < 200 || status >= 300) {
                reject(
                  new Error(`ClickUp API returned HTTP ${status}: ${text.slice(0, 200)}`),
                );
                return;
              }

              const json = JSON.parse(text) as T & ClickUpErrorResponse;

              if (json.err) {
                reject(new Error(`ClickUp API error: ${json.err}`));
                return;
              }

              resolve(json);
            } catch (err) {
              reject(err);
            }
          });
        });
      },
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      settle(() => {
        req.destroy();
        reject(new Error("ClickUp API request timed out after 30s"));
      });
    });

    req.on("error", (err: Error) => settle(() => reject(err)));

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// ClickUp API response types
// ---------------------------------------------------------------------------

interface ClickUpStatus {
  status: string;
  type: string; // "open" | "custom" | "closed" | "done"
}

interface ClickUpUser {
  id: number;
  username: string;
}

interface ClickUpTag {
  name: string;
}

interface ClickUpTask {
  id: string;
  custom_id: string | null;
  name: string;
  description: string | null;
  text_content: string | null;
  status: ClickUpStatus;
  priority: {
    id: string;
    priority: string; // "urgent" | "high" | "normal" | "low"
    orderindex: string;
  } | null;
  assignees: ClickUpUser[];
  tags: ClickUpTag[];
  url: string;
  list: {
    id: string;
    name: string;
  };
}

interface ClickUpTaskList {
  tasks: ClickUpTask[];
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapClickUpState(status: ClickUpStatus): Issue["state"] {
  const type = status.type.toLowerCase();
  if (type === "closed" || type === "done") return "closed";
  if (type === "open") return "open";
  // "custom" statuses: infer from the status name
  const name = status.status.toLowerCase();
  if (name === "in progress" || name === "in review" || name === "doing") return "in_progress";
  if (name === "closed" || name === "done" || name === "complete" || name === "resolved") {
    return "closed";
  }
  return "open";
}

function mapClickUpPriority(priority: ClickUpTask["priority"]): number | undefined {
  if (!priority) return undefined;
  // ClickUp priority: 1=urgent, 2=high, 3=normal, 4=low
  // This matches the Issue.priority convention used by Linear
  return Number(priority.id);
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Extract the ClickUp list ID from project tracker config. */
function getListId(project: ProjectConfig): string | undefined {
  return project.tracker?.["listId"] as string | undefined;
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function toIssue(task: ClickUpTask): Issue {
  return {
    id: task.id,
    title: task.name,
    description: task.text_content ?? task.description ?? "",
    url: task.url,
    state: mapClickUpState(task.status),
    labels: task.tags.map((t) => t.name),
    assignee: task.assignees[0]?.username,
    priority: mapClickUpPriority(task.priority),
  };
}

function createClickUpTracker(): Tracker {
  return {
    name: "clickup",

    async getIssue(identifier: string, _project: ProjectConfig): Promise<Issue> {
      const taskId = identifier.replace(/^#/, "");
      const task = await clickUpRequest<ClickUpTask>(
        "GET",
        `/task/${taskId}?include_subtasks=true`,
      );
      return toIssue(task);
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const taskId = identifier.replace(/^#/, "");
      const task = await clickUpRequest<ClickUpTask>("GET", `/task/${taskId}`);
      const state = mapClickUpState(task.status);
      return state === "closed";
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      const taskId = identifier.replace(/^#/, "");
      return `https://app.clickup.com/t/${taskId}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract task ID from ClickUp URL
      // Examples:
      //   https://app.clickup.com/t/86abc123
      //   https://app.clickup.com/t/PROJ-123
      //   https://app.clickup.com/12345/v/li/67890
      const shortMatch = url.match(/\/t\/([A-Za-z0-9-]+)/);
      if (shortMatch) {
        return shortMatch[1];
      }
      // Fallback: return the last segment
      const parts = url.split("/");
      return parts[parts.length - 1] || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const taskId = identifier.replace(/^#/, "");
      return `feat/cu-${taskId}`;
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
      if (!listId) {
        throw new Error("ClickUp tracker requires 'listId' in project tracker config");
      }

      const params = new URLSearchParams();

      if (filters.state === "closed") {
        // Don't filter by status name — ClickUp spaces use custom names
        // like "Done", "Complete", "Resolved" for closed-type statuses.
        // Fetch all (including closed) and filter client-side via mapClickUpState.
        params.set("include_closed", "true");
      } else if (filters.state !== "all") {
        // Default: open tasks only (exclude closed)
        params.set("include_closed", "false");
      } else {
        params.set("include_closed", "true");
      }

      if (filters.assignee) {
        // ClickUp filters by user ID, but we accept usernames.
        // The assignee filter is best-effort with username.
        params.set("assignees[]", filters.assignee);
      }

      if (filters.labels && filters.labels.length > 0) {
        for (const tag of filters.labels) {
          params.append("tags[]", tag);
        }
      }

      const limit = filters.limit ?? 30;
      params.set("page", "0");
      // ClickUp doesn't have a direct "limit" param — uses subtask_limit or pagination.
      // We fetch and slice.

      const queryStr = params.toString();
      const data = await clickUpRequest<ClickUpTaskList>(
        "GET",
        `/list/${listId}/task${queryStr ? `?${queryStr}` : ""}`,
      );

      let tasks = data.tasks;

      if (filters.state === "closed") {
        tasks = tasks.filter((t) => mapClickUpState(t.status) === "closed");
      }

      return tasks.slice(0, limit).map(toIssue);
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      const taskId = identifier.replace(/^#/, "");

      // Handle state change
      if (update.state) {
        const statusName =
          update.state === "closed"
            ? "closed"
            : update.state === "in_progress"
              ? "in progress"
              : "open";
        await clickUpRequest("PUT", `/task/${taskId}`, {
          status: statusName,
        });
      }

      // Handle assignee
      if (update.assignee) {
        // ClickUp requires user IDs for assignment. We pass the username
        // and let ClickUp resolve it via the assignees.add field.
        // In practice, the caller would need to provide a ClickUp user ID.
        await clickUpRequest("PUT", `/task/${taskId}`, {
          assignees: { add: [update.assignee] },
        });
      }

      // Handle adding tags (labels)
      if (update.labels && update.labels.length > 0) {
        for (const tag of update.labels) {
          await clickUpRequest("POST", `/task/${taskId}/tag/${encodeURIComponent(tag)}`, {});
        }
      }

      // Handle removing tags
      if (update.removeLabels && update.removeLabels.length > 0) {
        for (const tag of update.removeLabels) {
          await clickUpRequest("DELETE", `/task/${taskId}/tag/${encodeURIComponent(tag)}`);
        }
      }

      // Handle comment
      if (update.comment) {
        await clickUpRequest("POST", `/task/${taskId}/comment`, {
          comment_text: update.comment,
        });
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const listId = getListId(project);
      if (!listId) {
        throw new Error("ClickUp tracker requires 'listId' in project tracker config");
      }

      const body: Record<string, unknown> = {
        name: input.title,
        description: input.description ?? "",
      };

      if (input.priority !== undefined) {
        body["priority"] = input.priority;
      }

      if (input.assignee) {
        body["assignees"] = [input.assignee];
      }

      if (input.labels && input.labels.length > 0) {
        body["tags"] = input.labels;
      }

      const task = await clickUpRequest<ClickUpTask>(
        "POST",
        `/list/${listId}/task`,
        body,
      );

      return toIssue(task);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "clickup",
  slot: "tracker" as const,
  description: "Tracker plugin: ClickUp task management",
  version: "0.1.0",
};

export function create(): Tracker {
  return createClickUpTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
