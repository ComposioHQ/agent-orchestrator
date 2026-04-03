import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";
import { JiraClient, adfToMarkdown } from "./jira-client.js";
import type { JiraIssue } from "./jira-client.js";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const manifest = {
  name: "jira" as const,
  slot: "tracker" as const,
  description: "Tracker plugin: Jira Cloud issue tracker",
  version: "0.1.0",
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface JiraPluginConfig {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  projectKey?: string;
  jql?: string;
  statusMap?: Record<string, string>;
}

function resolveConfig(pluginConfig?: Record<string, unknown>): {
  client: JiraClient;
  projectKey: string;
  jql: string | undefined;
  statusMap: Record<string, string>;
} {
  const cfg = (pluginConfig ?? {}) as JiraPluginConfig;

  const baseUrl = cfg.baseUrl ?? process.env.JIRA_BASE_URL;
  const email = cfg.email ?? process.env.JIRA_EMAIL;
  const apiToken = cfg.apiToken ?? process.env.JIRA_API_TOKEN;

  if (!baseUrl) throw new Error("Jira tracker: baseUrl is required (config or JIRA_BASE_URL env)");
  if (!email) throw new Error("Jira tracker: email is required (config or JIRA_EMAIL env)");
  if (!apiToken) throw new Error("Jira tracker: apiToken is required (config or JIRA_API_TOKEN env)");

  const projectKey = cfg.projectKey ?? "";

  return {
    client: new JiraClient({ baseUrl, email, apiToken }),
    projectKey,
    jql: cfg.jql,
    statusMap: cfg.statusMap ?? {},
  };
}

// ---------------------------------------------------------------------------
// Jira → AO mapping
// ---------------------------------------------------------------------------

function mapState(jiraStatus: string): Issue["state"] {
  const lower = jiraStatus.toLowerCase();
  if (lower === "done" || lower === "closed" || lower === "resolved") return "closed";
  if (lower === "in progress" || lower === "in review") return "in_progress";
  if (lower === "cancelled" || lower === "canceled" || lower === "rejected") return "cancelled";
  return "open";
}

function mapIssue(issue: JiraIssue, baseUrl: string): Issue {
  return {
    id: issue.key,
    title: issue.fields.summary,
    description: adfToMarkdown(issue.fields.description),
    url: `${baseUrl.replace(/\/+$/, "")}/browse/${issue.key}`,
    state: mapState(issue.fields.status.name),
    labels: issue.fields.labels ?? [],
    assignee: issue.fields.assignee?.displayName,
    priority: mapPriority(issue.fields.priority?.name),
  };
}

function mapPriority(name?: string | null): number | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  if (lower === "highest" || lower === "critical") return 1;
  if (lower === "high") return 2;
  if (lower === "medium") return 3;
  if (lower === "low") return 4;
  if (lower === "lowest") return 5;
  return undefined;
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

export function create(config?: Record<string, unknown>): Tracker {
  const { client, projectKey, jql, statusMap } = resolveConfig(config);
  const baseUrl = (config?.baseUrl as string | undefined) ?? process.env.JIRA_BASE_URL ?? "";

  const tracker: Tracker = {
    name: "jira",

    async getIssue(identifier: string, _project: ProjectConfig): Promise<Issue> {
      const issue = await client.getIssue(identifier);
      return mapIssue(issue, baseUrl);
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const issue = await client.getIssue(identifier);
      const state = mapState(issue.fields.status.name);
      return state === "closed" || state === "cancelled";
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      return `${baseUrl.replace(/\/+$/, "")}/browse/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      const match = /\/browse\/([A-Z][\w]+-\d+)/.exec(url);
      return match?.[1] ?? url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await tracker.getIssue(identifier, project);
      const lines: string[] = [];

      lines.push(`Jira issue ${identifier}: ${issue.title}`);
      lines.push(`URL: ${issue.url}`);

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }
      if (issue.priority !== undefined) {
        lines.push(`Priority: ${issue.priority}`);
      }
      if (issue.description) {
        lines.push("");
        lines.push("## Description");
        lines.push("");
        lines.push(issue.description);
      }

      return lines.join("\n");
    },

    async listIssues(
      filters: IssueFilters,
      _project: ProjectConfig,
    ): Promise<Issue[]> {
      const effectiveJql = buildJql(jql, projectKey, filters);
      const limit = filters.limit ?? 50;
      const issues = await client.searchIssues(effectiveJql, limit);
      return issues.map((i) => mapIssue(i, baseUrl));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      if (update.state) {
        const transitionName = statusMap[update.state];
        if (transitionName) {
          await client.transitionIssue(identifier, transitionName);
        }
      }
      if (update.labels && update.labels.length > 0) {
        const issue = await client.getIssue(identifier);
        const existing = issue.fields.labels ?? [];
        const merged = [...new Set([...existing, ...update.labels])];
        await client.updateIssue(identifier, { labels: merged });
      }
      if (update.removeLabels && update.removeLabels.length > 0) {
        const issue = await client.getIssue(identifier);
        const existing = issue.fields.labels ?? [];
        const filtered = existing.filter((l) => !update.removeLabels!.includes(l));
        await client.updateIssue(identifier, { labels: filtered });
      }
      if (update.assignee) {
        // Jira requires accountId, but we accept displayName — best effort
        await client.updateIssue(identifier, {
          assignee: { accountId: update.assignee },
        });
      }
      if (update.comment) {
        await client.addComment(identifier, update.comment);
      }
    },

    async createIssue(
      input: CreateIssueInput,
      _project: ProjectConfig,
    ): Promise<Issue> {
      const fields: Record<string, unknown> = {
        summary: input.title,
        description: {
          version: 1,
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: input.description || " " }],
            },
          ],
        },
      };
      if (projectKey) {
        fields.project = { key: projectKey };
      }
      if (input.labels && input.labels.length > 0) {
        fields.labels = input.labels;
      }
      if (input.assignee) {
        fields.assignee = { accountId: input.assignee };
      }

      // Jira create returns the new issue key
      const result = await client.createIssue(fields);
      return tracker.getIssue(result.key, _project);
    },
  };

  return tracker;
}

// ---------------------------------------------------------------------------
// JQL builder
// ---------------------------------------------------------------------------

function buildJql(
  customJql: string | undefined,
  projectKey: string,
  filters: IssueFilters,
): string {
  if (customJql) return customJql;

  const clauses: string[] = [];
  if (projectKey) {
    clauses.push(`project = "${projectKey}"`);
  }
  if (filters.state && filters.state !== "all") {
    if (filters.state === "open") {
      clauses.push(`statusCategory != "Done"`);
    } else {
      clauses.push(`statusCategory = "Done"`);
    }
  }
  if (filters.labels && filters.labels.length > 0) {
    for (const label of filters.labels) {
      clauses.push(`labels = "${label}"`);
    }
  }
  if (filters.assignee) {
    clauses.push(`assignee = "${filters.assignee}"`);
  }

  return clauses.length > 0
    ? clauses.join(" AND ") + " ORDER BY priority ASC, created DESC"
    : "ORDER BY created DESC";
}

// ---------------------------------------------------------------------------
// Detect
// ---------------------------------------------------------------------------

export function detect(): boolean {
  return !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default { manifest, create, detect } satisfies PluginModule<Tracker>;
