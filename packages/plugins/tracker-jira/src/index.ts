import { request } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { PluginModule, ProjectConfig, Issue, IssueFilters, Tracker } from "@aoagents/ao-core";

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey?: string;
  jql?: string;
}

interface JiraIssueResponse {
  id: string;
  key: string;
  self?: string;
  fields: {
    summary?: string | null;
    description?: unknown;
    labels?: string[];
    assignee?: {
      displayName?: string | null;
      emailAddress?: string | null;
      accountId?: string | null;
    } | null;
    priority?: {
      id?: string | null;
      name?: string | null;
    } | null;
    status?: {
      name?: string | null;
      statusCategory?: {
        key?: string | null;
        name?: string | null;
      } | null;
    } | null;
  };
}

interface JiraSearchResponse {
  issues: JiraIssueResponse[];
}

interface JiraApiResponse<T> {
  body: T;
  statusCode: number;
  headers: IncomingHttpHeaders;
}

const ISSUE_FIELDS = ["summary", "description", "labels", "assignee", "priority", "status"].join(",");

function getTrackerConfig(project: ProjectConfig): Record<string, unknown> {
  return (project.tracker ?? {}) as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveJiraConfig(project: ProjectConfig): JiraConfig {
  const tracker = getTrackerConfig(project);
  const baseUrl = readString(tracker.baseUrl) ?? readString(process.env["JIRA_BASE_URL"]);
  const email = readString(tracker.email) ?? readString(process.env["JIRA_EMAIL"]);
  const apiToken = readString(tracker.apiToken) ?? readString(process.env["JIRA_API_TOKEN"]);
  const projectKey = readString(tracker.projectKey);
  const jql = readString(tracker.jql);

  if (!baseUrl) {
    throw new Error("Jira tracker requires JIRA_BASE_URL or tracker.baseUrl");
  }
  if (!email) {
    throw new Error("Jira tracker requires JIRA_EMAIL or tracker.email");
  }
  if (!apiToken) {
    throw new Error("Jira tracker requires JIRA_API_TOKEN or tracker.apiToken");
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    email,
    apiToken,
    projectKey,
    jql,
  };
}

export function extractDocumentText(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    return node.map((item) => extractDocumentText(item)).filter(Boolean).join("\n").trim();
  }
  if (typeof node !== "object") return "";

  const record = node as { type?: string; text?: string; content?: unknown[] };
  if (record.type === "text") return record.text ?? "";

  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content.map((item) => extractDocumentText(item)).filter(Boolean);
  if (parts.length === 0) return "";

  if (["paragraph", "heading", "blockquote", "listItem"].includes(record.type ?? "")) {
    return parts.join("").trim();
  }
  if (["bulletList", "orderedList"].includes(record.type ?? "")) {
    return parts.map((part) => `- ${part}`).join("\n").trim();
  }
  if (record.type === "hardBreak") return "\n";

  return parts.join("\n").trim();
}

function mapJiraState(status: JiraIssueResponse["fields"]["status"]): Issue["state"] {
  const categoryKey = status?.statusCategory?.key?.toLowerCase();
  if (categoryKey === "done") return "closed";
  if (categoryKey === "indeterminate") return "in_progress";
  if (categoryKey === "new") return "open";

  const name = status?.name?.toLowerCase() ?? "";
  if (["done", "closed", "resolved"].includes(name)) return "closed";
  if (["cancelled", "canceled"].includes(name)) return "cancelled";
  if (["in progress", "in review", "selected for development", "implementing"].includes(name)) {
    return "in_progress";
  }
  return "open";
}

function mapPriority(priority: JiraIssueResponse["fields"]["priority"]): number | undefined {
  const name = priority?.name?.toLowerCase();
  if (!name) return undefined;
  if (name.includes("highest")) return 1;
  if (name.includes("high")) return 2;
  if (name.includes("medium")) return 3;
  if (name.includes("low")) return 4;
  if (name.includes("lowest")) return 5;
  return undefined;
}

export function mapJiraIssue(issue: JiraIssueResponse, config: JiraConfig): Issue {
  const description = extractDocumentText(issue.fields.description);
  const assignee = issue.fields.assignee?.displayName ?? issue.fields.assignee?.emailAddress ?? issue.fields.assignee?.accountId ?? undefined;

  return {
    id: issue.key,
    title: issue.fields.summary ?? issue.key,
    description,
    url: `${config.baseUrl}/browse/${issue.key}`,
    state: mapJiraState(issue.fields.status),
    labels: issue.fields.labels ?? [],
    assignee,
    priority: mapPriority(issue.fields.priority),
    branchName: `feat/${issue.key.toLowerCase()}`,
  };
}

function buildAuthHeader(config: JiraConfig): string {
  return `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;
}

function jiraRequest<T>(config: JiraConfig, path: string): Promise<JiraApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, config.baseUrl);
    const req = request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: buildAuthHeader(config),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            const statusCode = res.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`Jira API request failed (${statusCode}): ${text.slice(0, 300)}`));
              return;
            }
            resolve({
              body: JSON.parse(text) as T,
              statusCode,
              headers: res.headers,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.setTimeout(30_000, () => req.destroy(new Error("Jira API request timed out after 30s")));
    req.on("error", reject);
    req.end();
  });
}

function buildListJql(filters: IssueFilters, config: JiraConfig): string {
  if (config.jql) return config.jql;
  if (!config.projectKey) {
    throw new Error("Jira tracker listIssues requires tracker.projectKey or tracker.jql");
  }

  const clauses = [`project = ${JSON.stringify(config.projectKey)}`];

  if (filters.state === "closed") {
    clauses.push("statusCategory = Done");
  } else if (filters.state !== "all") {
    clauses.push("statusCategory != Done");
  }

  if (filters.assignee) {
    clauses.push(`assignee = ${JSON.stringify(filters.assignee)}`);
  }

  if (filters.labels && filters.labels.length > 0) {
    for (const label of filters.labels) {
      clauses.push(`labels = ${JSON.stringify(label)}`);
    }
  }

  return `${clauses.join(" AND ")} ORDER BY updated DESC`;
}

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().replace(/^#/, "").toUpperCase();
}

function createJiraTracker(): Tracker {
  return {
    name: "jira",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const config = resolveJiraConfig(project);
      const key = normalizeIdentifier(identifier);
      const response = await jiraRequest<JiraIssueResponse>(
        config,
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(ISSUE_FIELDS)}`,
      );
      return mapJiraIssue(response.body, config);
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const issue = await this.getIssue(identifier, project);
      return issue.state === "closed" || issue.state === "cancelled";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const config = resolveJiraConfig(project);
      return `${config.baseUrl}/browse/${normalizeIdentifier(identifier)}`;
    },

    issueLabel(url: string): string {
      const browseMatch = url.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i);
      if (browseMatch?.[1]) return browseMatch[1].toUpperCase();
      const issueKey = url.split("/").pop();
      return issueKey?.toUpperCase() ?? url;
    },

    branchName(identifier: string): string {
      return `feat/${normalizeIdentifier(identifier).toLowerCase()}`;
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
      const config = resolveJiraConfig(project);
      const jql = buildListJql(filters, config);
      const maxResults = String(filters.limit ?? 30);
      const response = await jiraRequest<JiraSearchResponse>(
        config,
        `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${encodeURIComponent(maxResults)}&fields=${encodeURIComponent(ISSUE_FIELDS)}`,
      );
      return response.body.issues.map((issue) => mapJiraIssue(issue, config));
    },
  };
}

export const manifest = {
  name: "jira",
  slot: "tracker" as const,
  description: "Tracker plugin: Jira issues",
  version: "0.1.0",
};

export function create(): Tracker {
  return createJiraTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
