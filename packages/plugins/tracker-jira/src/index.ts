import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";
import { JiraClient, adfToMarkdown, type JiraIssue } from "./jira-client.js";

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
// Helpers — read per-project config from project.tracker
// ---------------------------------------------------------------------------

function getBaseUrl(project: ProjectConfig): string {
  return (
    (project.tracker?.["baseUrl"] as string | undefined) ??
    process.env.JIRA_BASE_URL ??
    ""
  );
}

function getProjectKey(project: ProjectConfig): string {
  return (project.tracker?.["projectKey"] as string | undefined) ?? "";
}

function getJql(project: ProjectConfig): string | undefined {
  return project.tracker?.["jql"] as string | undefined;
}

function getStatusMap(project: ProjectConfig): Record<string, string> {
  return (project.tracker?.["statusMap"] as Record<string, string> | undefined) ?? {};
}

function getBranchPrefix(project: ProjectConfig): string {
  return (project.tracker?.["branchPrefix"] as string | undefined) ?? "feat";
}

function getIssueType(project: ProjectConfig): string {
  return (project.tracker?.["issueType"] as string | undefined) ?? "Task";
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

function extractSprintNumber(sprintName: string): string {
  const match = /sprint[\s\-_]*(\d+)/i.exec(sprintName);
  return match ? match[1] : sprintName;
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

export function create(): Tracker {
  // Client cache keyed by baseUrl+email (supports multiple Jira instances and
  // credential rotation). Credentials are read fresh on every call so the
  // plugin can register before .env is loaded and still pick up env vars later.
  const clients = new Map<string, JiraClient>();

  function getClient(project: ProjectConfig): JiraClient {
    const baseUrl = getBaseUrl(project);
    const email = process.env.JIRA_EMAIL;
    const apiToken = process.env.JIRA_API_TOKEN;
    if (!baseUrl) throw new Error("Jira tracker: baseUrl is required (project.tracker.baseUrl or JIRA_BASE_URL env)");
    if (!email) throw new Error("Jira tracker: JIRA_EMAIL env var is required");
    if (!apiToken) throw new Error("Jira tracker: JIRA_API_TOKEN env var is required");

    const cacheKey = `${baseUrl}|${email}`;
    let client = clients.get(cacheKey);
    if (!client) {
      client = new JiraClient({ baseUrl, email, apiToken });
      clients.set(cacheKey, client);
    }
    return client;
  }

  // Cache active sprint per projectKey (resolved lazily)
  const sprintCache = new Map<string, string | null>();

  async function resolveActiveSprint(project: ProjectConfig): Promise<string | null> {
    const projectKey = getProjectKey(project);
    if (!projectKey) return null;

    const cached = sprintCache.get(projectKey);
    if (cached !== undefined) return cached;

    try {
      const client = getClient(project);
      const boardId = await client.findBoardId(projectKey);
      if (boardId) {
        const sprint = await client.getActiveSprint(boardId);
        sprintCache.set(projectKey, sprint);
        return sprint;
      }
    } catch {
      // Non-fatal — fall back to no sprint
    }
    sprintCache.set(projectKey, null);
    return null;
  }

  const tracker: Tracker = {
    name: "jira",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      await resolveActiveSprint(project);
      const client = getClient(project);
      const issue = await client.getIssue(identifier);
      return mapIssue(issue, getBaseUrl(project));
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const client = getClient(project);
      const issue = await client.getIssue(identifier);
      const state = mapState(issue.fields.status.name);
      return state === "closed" || state === "cancelled";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const baseUrl = getBaseUrl(project);
      return `${baseUrl.replace(/\/+$/, "")}/browse/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      const match = /\/browse\/([A-Z][\w]+-\d+)/.exec(url);
      return match?.[1] ?? url;
    },

    branchName(identifier: string, project: ProjectConfig): string {
      const prefix = getBranchPrefix(project);
      const projectKey = getProjectKey(project);
      const sprintName = sprintCache.get(projectKey);
      if (sprintName) {
        const sprintNum = extractSprintNumber(sprintName);
        return `${prefix}/Sprint${sprintNum}/${identifier}`;
      }
      return `${prefix}/${identifier}`;
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
      project: ProjectConfig,
    ): Promise<Issue[]> {
      const client = getClient(project);
      const effectiveJql = buildJql(getJql(project), getProjectKey(project), filters);
      const limit = filters.limit ?? 50;
      const issues = await client.searchIssues(effectiveJql, limit);
      return issues.map((i) => mapIssue(i, getBaseUrl(project)));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const client = getClient(project);
      const statusMap = getStatusMap(project);

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
      project: ProjectConfig,
    ): Promise<Issue> {
      const client = getClient(project);
      const projectKey = getProjectKey(project);

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
      fields.issuetype = { name: getIssueType(project) };
      if (input.labels && input.labels.length > 0) {
        fields.labels = input.labels;
      }
      if (input.assignee) {
        fields.assignee = { accountId: input.assignee };
      }

      const result = await client.createIssue(fields);
      return tracker.getIssue(result.key, project);
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
