/**
 * tracker-jira plugin -- Jira as an issue tracker.
 *
 * Uses the Jira REST API v3 via fetch().
 * Auth: Basic Auth from JIRA_EMAIL + JIRA_API_TOKEN env vars.
 * Host: JIRA_HOST env var (e.g. "https://mycompany.atlassian.net").
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
    throw new Error(`${name} environment variable is required for the Jira tracker plugin`);
  }
  return val;
}

function getAuthHeader(): string {
  const email = getEnv("JIRA_EMAIL");
  const token = getEnv("JIRA_API_TOKEN");
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

function getBaseUrl(): string {
  const host = getEnv("JIRA_HOST");
  return host.replace(/\/+$/, "");
}

interface JiraFetchOptions {
  method?: string;
  body?: unknown;
}

async function jiraFetch<T>(path: string, options: JiraFetchOptions = {}): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    Authorization: getAuthHeader(),
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
      throw new Error(`Jira API ${options.method ?? "GET"} ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    }

    // Some Jira endpoints return 204 No Content
    if (res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Jira API returned invalid JSON for ${path}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Types for Jira responses
// ---------------------------------------------------------------------------

interface JiraIssue {
  key: string;
  id: string;
  self: string;
  fields: {
    summary: string;
    description: unknown;
    status: {
      name: string;
      statusCategory: {
        key: string; // "new" | "indeterminate" | "done"
      };
    };
    labels: string[];
    assignee: { displayName: string; accountId: string } | null;
    priority: { name: string; id: string } | null;
    issuetype: { name: string };
    project: { key: string };
  };
}

interface JiraTransition {
  id: string;
  name: string;
  to: {
    statusCategory: { key: string };
  };
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapJiraState(statusCategoryKey: string): Issue["state"] {
  switch (statusCategoryKey) {
    case "done":
      return "closed";
    case "indeterminate":
      return "in_progress";
    case "new":
    default:
      return "open";
  }
}

function descriptionToText(desc: unknown): string {
  if (!desc) return "";
  if (typeof desc === "string") return desc;
  // Jira uses ADF (Atlassian Document Format). Extract text nodes recursively.
  try {
    return extractAdfText(desc);
  } catch {
    return JSON.stringify(desc);
  }
}

function extractAdfText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as Record<string, unknown>;
  if (n["type"] === "text" && typeof n["text"] === "string") {
    return n["text"];
  }
  if (Array.isArray(n["content"])) {
    return (n["content"] as unknown[]).map(extractAdfText).join("");
  }
  return "";
}

function toJiraIssue(data: JiraIssue): Issue {
  return {
    id: data.key,
    title: data.fields.summary,
    description: descriptionToText(data.fields.description),
    url: `${getBaseUrl()}/browse/${data.key}`,
    state: mapJiraState(data.fields.status.statusCategory.key),
    labels: data.fields.labels ?? [],
    assignee: data.fields.assignee?.displayName,
    priority: data.fields.priority ? Number(data.fields.priority.id) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createJiraTracker(): Tracker {
  return {
    name: "jira",

    async getIssue(identifier: string, _project: ProjectConfig): Promise<Issue> {
      const data = await jiraFetch<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(identifier)}`);
      return toJiraIssue(data);
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const data = await jiraFetch<JiraIssue>(
        `/rest/api/3/issue/${encodeURIComponent(identifier)}?fields=status`,
      );
      return data.fields.status.statusCategory.key === "done";
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      return `${getBaseUrl()}/browse/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract "PROJ-123" from URL like https://mycompany.atlassian.net/browse/PROJ-123
      const match = url.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
      if (match) return match[1];
      const parts = url.split("/");
      return parts[parts.length - 1] || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/${identifier.toLowerCase()}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Jira issue ${issue.id}: ${issue.title}`,
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
      const jqlParts: string[] = [];

      // Determine project key from tracker config or identifier pattern
      const projectKey = project.tracker?.["projectKey"] as string | undefined;
      if (projectKey) {
        jqlParts.push(`project = "${projectKey}"`);
      }

      if (filters.state === "closed") {
        jqlParts.push("statusCategory = Done");
      } else if (filters.state === "open") {
        jqlParts.push("statusCategory != Done");
      }
      // "all" = no state filter

      if (filters.labels && filters.labels.length > 0) {
        const labelClauses = filters.labels.map((l) => `labels = "${l}"`);
        jqlParts.push(`(${labelClauses.join(" OR ")})`);
      }

      if (filters.assignee) {
        jqlParts.push(`assignee = "${filters.assignee}"`);
      }

      const jql = jqlParts.length > 0 ? jqlParts.join(" AND ") : "ORDER BY created DESC";
      const maxResults = filters.limit ?? 30;

      const data = await jiraFetch<{ issues: JiraIssue[] }>("/rest/api/3/search", {
        method: "POST",
        body: {
          jql: jqlParts.length > 0 ? `${jql} ORDER BY created DESC` : jql,
          maxResults,
          fields: ["summary", "description", "status", "labels", "assignee", "priority", "issuetype", "project"],
        },
      });

      return data.issues.map(toJiraIssue);
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      // Handle state change via transitions
      if (update.state) {
        const transitions = await jiraFetch<{ transitions: JiraTransition[] }>(
          `/rest/api/3/issue/${encodeURIComponent(identifier)}/transitions`,
        );

        const targetCategory =
          update.state === "closed"
            ? "done"
            : update.state === "in_progress"
              ? "indeterminate"
              : "new";

        const transition = transitions.transitions.find(
          (t) => t.to.statusCategory.key === targetCategory,
        );

        if (transition) {
          await jiraFetch(
            `/rest/api/3/issue/${encodeURIComponent(identifier)}/transitions`,
            {
              method: "POST",
              body: { transition: { id: transition.id } },
            },
          );
        }
      }

      // Handle comment
      if (update.comment) {
        await jiraFetch(
          `/rest/api/3/issue/${encodeURIComponent(identifier)}/comment`,
          {
            method: "POST",
            body: {
              body: {
                type: "doc",
                version: 1,
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: update.comment }],
                  },
                ],
              },
            },
          },
        );
      }

      // Handle labels and assignee via issue update
      const updateFields: Record<string, unknown> = {};

      if (update.labels && update.labels.length > 0) {
        // Jira labels are additive via update operations
        updateFields["labels"] = update.labels.map((l) => ({ add: l }));
      }

      if (update.assignee) {
        // Jira requires accountId; search for user by displayName to resolve it
        const users = await jiraFetch<Array<{ accountId: string; displayName: string }>>(
          `/rest/api/3/user/search?query=${encodeURIComponent(update.assignee)}`,
        );
        const matchedUser = users.find((u) => u.displayName === update.assignee);
        if (matchedUser) {
          updateFields["assignee"] = { accountId: matchedUser.accountId };
        } else if (users.length > 0 && users[0]) {
          updateFields["assignee"] = { accountId: users[0].accountId };
        }
      }

      if (Object.keys(updateFields).length > 0) {
        await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(identifier)}`, {
          method: "PUT",
          body: {
            update: update.labels ? { labels: updateFields["labels"] } : undefined,
            fields: update.assignee ? { assignee: updateFields["assignee"] } : undefined,
          },
        });
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const projectKey = project.tracker?.["projectKey"] as string | undefined;
      if (!projectKey) {
        throw new Error("Jira tracker requires 'projectKey' in project tracker config");
      }

      const fields: Record<string, unknown> = {
        project: { key: projectKey },
        summary: input.title,
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: input.description || "" }],
            },
          ],
        },
        issuetype: { name: "Task" },
      };

      if (input.labels && input.labels.length > 0) {
        fields["labels"] = input.labels;
      }

      const data = await jiraFetch<{ key: string }>("/rest/api/3/issue", {
        method: "POST",
        body: { fields },
      });

      return this.getIssue(data.key, project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "jira",
  slot: "tracker" as const,
  description: "Tracker plugin: Jira",
  version: "0.1.0",
};

export function create(): Tracker {
  return createJiraTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
