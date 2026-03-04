/**
 * tracker-jira plugin — Jira Issues as an issue tracker.
 *
 * Uses the Jira REST API v3 via Node's built-in fetch.
 *
 * Required environment variables:
 *   JIRA_BASE_URL  — e.g. https://mycompany.atlassian.net
 *   JIRA_EMAIL     — Jira account email
 *   JIRA_API_TOKEN — API token (https://id.atlassian.com/manage-profile/security/api-tokens)
 *
 * Config (in agent-orchestrator.yaml):
 *   projects:
 *     my-app:
 *       tracker:
 *         plugin: jira
 *         projectKey: PROJ   # Jira project key
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

// =============================================================================
// Jira API Client
// =============================================================================

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

function getJiraConfig(): JiraConfig {
  const baseUrl = process.env["JIRA_BASE_URL"];
  const email = process.env["JIRA_EMAIL"];
  const apiToken = process.env["JIRA_API_TOKEN"];

  if (!baseUrl) throw new Error("JIRA_BASE_URL environment variable is required");
  if (!email) throw new Error("JIRA_EMAIL environment variable is required");
  if (!apiToken) throw new Error("JIRA_API_TOKEN environment variable is required");

  return { baseUrl: baseUrl.replace(/\/+$/, ""), email, apiToken };
}

function authHeader(config: JiraConfig): string {
  const credentials = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  return `Basic ${credentials}`;
}

async function jiraFetch(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const config = getJiraConfig();
  const url = `${config.baseUrl}/rest/api/3${path}`;

  const headers: Record<string, string> = {
    Authorization: authHeader(config),
    Accept: "application/json",
  };

  const fetchInit: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchInit.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchInit);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Jira API ${options.method ?? "GET"} ${path} failed (${response.status}): ${text}`,
    );
  }

  // Some endpoints (204 No Content) return no body
  if (response.status === 204) return null;

  return response.json();
}

// =============================================================================
// Jira Data Mapping
// =============================================================================

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: unknown;
    status: { name: string; statusCategory: { key: string } };
    labels: string[];
    assignee: { displayName: string; emailAddress: string } | null;
    priority: { id: string; name: string } | null;
  };
}

/** Extract plain text from Jira's ADF (Atlassian Document Format) description. */
function adfToPlainText(adf: unknown): string {
  if (typeof adf === "string") return adf;
  if (adf === null || adf === undefined) return "";
  if (typeof adf !== "object") return "";

  const doc = adf as Record<string, unknown>;
  if (!Array.isArray(doc["content"])) return "";

  const parts: string[] = [];
  for (const node of doc["content"] as Array<Record<string, unknown>>) {
    if (node["type"] === "paragraph" && Array.isArray(node["content"])) {
      const texts = (node["content"] as Array<Record<string, unknown>>)
        .filter((c) => c["type"] === "text" && typeof c["text"] === "string")
        .map((c) => c["text"] as string);
      parts.push(texts.join(""));
    } else if (node["type"] === "heading" && Array.isArray(node["content"])) {
      const texts = (node["content"] as Array<Record<string, unknown>>)
        .filter((c) => c["type"] === "text" && typeof c["text"] === "string")
        .map((c) => c["text"] as string);
      parts.push(texts.join(""));
    } else if (node["type"] === "codeBlock" && Array.isArray(node["content"])) {
      const texts = (node["content"] as Array<Record<string, unknown>>)
        .filter((c) => c["type"] === "text" && typeof c["text"] === "string")
        .map((c) => c["text"] as string);
      parts.push(texts.join(""));
    } else if (node["type"] === "bulletList" || node["type"] === "orderedList") {
      if (Array.isArray(node["content"])) {
        for (const item of node["content"] as Array<Record<string, unknown>>) {
          if (item["type"] === "listItem" && Array.isArray(item["content"])) {
            parts.push("- " + adfToPlainText({ type: "doc", content: item["content"] }));
          }
        }
      }
    }
  }
  return parts.join("\n");
}

function mapState(statusCategory: string): Issue["state"] {
  // Jira status categories: "new", "indeterminate", "done", "undefined"
  switch (statusCategory.toLowerCase()) {
    case "done":
      return "closed";
    case "indeterminate":
      return "in_progress";
    default:
      return "open";
  }
}

function jiraToIssue(data: JiraIssue, baseUrl: string): Issue {
  return {
    id: data.key,
    title: data.fields.summary,
    description: adfToPlainText(data.fields.description),
    url: `${baseUrl}/browse/${data.key}`,
    state: mapState(data.fields.status.statusCategory.key),
    labels: data.fields.labels ?? [],
    assignee: data.fields.assignee?.displayName,
    priority: data.fields.priority ? parseInt(data.fields.priority.id, 10) : undefined,
  };
}

/** Get the Jira project key from tracker config or extract from issue key. */
function getProjectKey(project: ProjectConfig): string {
  const tracker = project.tracker as Record<string, unknown> | undefined;
  const key = tracker?.["projectKey"];
  if (typeof key === "string" && key.length > 0) return key;
  throw new Error(
    "Jira tracker requires 'projectKey' in tracker config (e.g. tracker: { plugin: jira, projectKey: PROJ })",
  );
}

// =============================================================================
// Tracker Implementation
// =============================================================================

function createJiraTracker(): Tracker {
  return {
    name: "jira",

    async getIssue(identifier: string, _project: ProjectConfig): Promise<Issue> {
      const config = getJiraConfig();
      const data = (await jiraFetch(
        `/issue/${encodeURIComponent(identifier)}?fields=summary,description,status,labels,assignee,priority`,
      )) as JiraIssue;
      return jiraToIssue(data, config.baseUrl);
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const data = (await jiraFetch(
        `/issue/${encodeURIComponent(identifier)}?fields=status`,
      )) as JiraIssue;
      return data.fields.status.statusCategory.key.toLowerCase() === "done";
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      const config = getJiraConfig();
      return `${config.baseUrl}/browse/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue key from Jira URL
      // Example: https://mycompany.atlassian.net/browse/PROJ-42 → "PROJ-42"
      const match = url.match(/\/browse\/([A-Z][\w]+-\d+)/i);
      if (match) return match[1];
      // Fallback: return the last segment of the URL
      const parts = url.split("/");
      return parts[parts.length - 1] ?? url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      // PROJ-123 → feat/PROJ-123
      return `feat/${identifier}`;
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
      const config = getJiraConfig();
      const projectKey = getProjectKey(project);
      const jqlParts: string[] = [`project = "${projectKey}"`];

      if (filters.state === "closed") {
        jqlParts.push("statusCategory = Done");
      } else if (filters.state === "open") {
        jqlParts.push("statusCategory != Done");
      }
      // "all" = no state filter

      if (filters.labels && filters.labels.length > 0) {
        const labelClauses = filters.labels.map((label: string) => `labels = "${label}"`);
        jqlParts.push(`(${labelClauses.join(" OR ")})`);
      }

      if (filters.assignee) {
        jqlParts.push(`assignee = "${filters.assignee}"`);
      }

      const jql = jqlParts.join(" AND ");
      const maxResults = filters.limit ?? 30;

      const data = (await jiraFetch(
        `/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,description,status,labels,assignee,priority`,
      )) as { issues: JiraIssue[] };

      return data.issues.map((issue) => jiraToIssue(issue, config.baseUrl));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      // Handle state change via transition
      if (update.state) {
        // Get available transitions for this issue
        const transitionsData = (await jiraFetch(
          `/issue/${encodeURIComponent(identifier)}/transitions`,
        )) as { transitions: Array<{ id: string; name: string; to: { statusCategory: { key: string } } }> };

        let targetCategory: string;
        if (update.state === "closed") {
          targetCategory = "done";
        } else if (update.state === "in_progress") {
          targetCategory = "indeterminate";
        } else {
          targetCategory = "new";
        }

        const transition = transitionsData.transitions.find(
          (t) => t.to.statusCategory.key.toLowerCase() === targetCategory,
        );

        if (transition) {
          await jiraFetch(`/issue/${encodeURIComponent(identifier)}/transitions`, {
            method: "POST",
            body: { transition: { id: transition.id } },
          });
        }
      }

      // Handle label additions via Jira's update (not fields) API
      if (update.labels && update.labels.length > 0) {
        await jiraFetch(`/issue/${encodeURIComponent(identifier)}`, {
          method: "PUT",
          body: {
            update: {
              labels: update.labels.map((l: string) => ({ add: l })),
            },
          },
        });
      }

      // Handle assignee change
      if (update.assignee) {
        await jiraFetch(`/issue/${encodeURIComponent(identifier)}`, {
          method: "PUT",
          body: { fields: { assignee: { name: update.assignee } } },
        });
      }

      // Handle comment
      if (update.comment) {
        await jiraFetch(`/issue/${encodeURIComponent(identifier)}/comment`, {
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
        });
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const projectKey = getProjectKey(project);

      const fields: Record<string, unknown> = {
        project: { key: projectKey },
        summary: input.title,
        issuetype: { name: "Task" },
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
      };

      if (input.labels && input.labels.length > 0) {
        fields["labels"] = input.labels;
      }

      if (input.assignee) {
        fields["assignee"] = { name: input.assignee };
      }

      const data = (await jiraFetch("/issue", {
        method: "POST",
        body: { fields },
      })) as { key: string };

      return this.getIssue(data.key, project);
    },
  };
}

// =============================================================================
// Plugin Module Export
// =============================================================================

export const manifest = {
  name: "jira",
  slot: "tracker" as const,
  description: "Tracker plugin: Jira Issues",
  version: "0.1.0",
};

export function create(): Tracker {
  return createJiraTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
