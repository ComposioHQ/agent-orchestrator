import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";

export const manifest = {
  name: "jira",
  slot: "tracker" as const,
  description: "Tracker plugin: Jira",
  version: "0.1.0",
};

type JiraFields = {
  summary?: string;
  description?: unknown;
  status?: { name?: string; statusCategory?: { key?: string } };
  labels?: string[];
  assignee?: { displayName?: string; accountId?: string } | null;
};

type JiraIssue = {
  id: string;
  key: string;
  self?: string;
  fields?: JiraFields;
};

function getJiraConfig(project: ProjectConfig): {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType?: string;
} {
  const tracker = (project.tracker ?? {}) as Record<string, unknown>;
  const baseUrl =
    (tracker["baseUrl"] as string | undefined) ??
    (process.env["JIRA_BASE_URL"] as string | undefined) ??
    "";
  const email =
    (tracker["email"] as string | undefined) ?? (process.env["JIRA_EMAIL"] as string | undefined) ?? "";
  const apiToken =
    (tracker["apiToken"] as string | undefined) ??
    (process.env["JIRA_API_TOKEN"] as string | undefined) ??
    "";
  const projectKey =
    (tracker["projectKey"] as string | undefined) ??
    (process.env["JIRA_PROJECT_KEY"] as string | undefined) ??
    "";
  const issueType =
    (tracker["issueType"] as string | undefined) ??
    (process.env["JIRA_ISSUE_TYPE"] as string | undefined);

  if (!baseUrl || !email || !apiToken || !projectKey) {
    throw new Error("Jira tracker requires baseUrl, email, apiToken, and projectKey");
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), email, apiToken, projectKey, issueType };
}

function authHeader(email: string, apiToken: string): string {
  const token = Buffer.from(`${email}:${apiToken}`).toString("base64");
  return `Basic ${token}`;
}

async function jiraRequest<T>(
  method: string,
  url: string,
  email: string,
  apiToken: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(email, apiToken),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Jira API ${method} ${url} failed (${res.status}): ${txt}`);
  }

  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

function mapStatus(fields?: JiraFields): Issue["state"] {
  const key = fields?.status?.statusCategory?.key?.toLowerCase() ?? "";
  if (key === "done") return "closed";

  const name = fields?.status?.name?.toLowerCase() ?? "";
  if (name.includes("progress")) return "in_progress";
  if (name.includes("cancel")) return "cancelled";
  return "open";
}

function descriptionToText(desc: unknown): string {
  if (typeof desc === "string") return desc;
  if (!desc || typeof desc !== "object") return "";
  return JSON.stringify(desc);
}

function quoteJqlLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toAdfDoc(text: string): Record<string, unknown> {
  return {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

async function pickIssueTypeName(
  baseUrl: string,
  email: string,
  apiToken: string,
  projectKey: string,
  configuredIssueType?: string,
): Promise<string> {
  if (configuredIssueType) return configuredIssueType;

  try {
    const data = await jiraRequest<{ issueTypes?: Array<{ name?: string }> }>(
      "GET",
      `${baseUrl}/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
      email,
      apiToken,
    );
    const names = (data.issueTypes ?? []).map((t) => t.name).filter((n): n is string => Boolean(n));
    if (names.length === 0) return "Task";

    if (names.includes("Task")) return "Task";
    if (names.includes("Story")) return "Story";
    return names[0]!;
  } catch {
    return "Task";
  }
}

async function findTransitionId(
  issueKey: string,
  targetState: "open" | "in_progress" | "closed",
  baseUrl: string,
  email: string,
  apiToken: string,
): Promise<string | null> {
  const data = await jiraRequest<{ transitions?: Array<{ id: string; name: string }> }>(
    "GET",
    `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    email,
    apiToken,
  );

  const preferred =
    targetState === "closed"
      ? ["done", "close", "closed", "resolve", "complete", "finished"]
      : targetState === "in_progress"
        ? ["in progress", "start", "doing"]
        : ["to do", "todo", "open", "reopen", "backlog"];

  const transitions = Array.isArray(data.transitions) ? data.transitions : [];
  const found = transitions.find((t) => {
    const n = (t.name ?? "").toLowerCase();
    return preferred.some((p) => n.includes(p));
  });
  return found?.id ?? null;
}

function mapIssue(issue: JiraIssue, baseUrl: string): Issue {
  const fields = issue.fields ?? {};
  return {
    id: issue.key,
    title: fields.summary ?? issue.key,
    description: descriptionToText(fields.description),
    url: `${baseUrl}/browse/${issue.key}`,
    state: mapStatus(fields),
    labels: fields.labels ?? [],
    assignee: fields.assignee?.displayName,
  };
}

function createJiraTracker(): Tracker {
  return {
    name: "jira",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const { baseUrl, email, apiToken } = getJiraConfig(project);
      const issue = await jiraRequest<JiraIssue>(
        "GET",
        `${baseUrl}/rest/api/3/issue/${encodeURIComponent(identifier)}?fields=summary,description,status,labels,assignee`,
        email,
        apiToken,
      );
      return mapIssue(issue, baseUrl);
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const issue = await this.getIssue(identifier, project);
      return issue.state === "closed" || issue.state === "cancelled";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const { baseUrl } = getJiraConfig(project);
      return `${baseUrl}/browse/${identifier}`;
    },

    issueLabel(url: string): string {
      const m = /\/browse\/([A-Z][A-Z0-9]+-\d+)/i.exec(url);
      return m?.[1] ?? url;
    },

    branchName(identifier: string): string {
      const normalized = identifier.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      return `feat/${normalized}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      return [
        `You are working on Jira issue ${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
        issue.description ? `Description:\n${issue.description}` : "No issue description provided.",
        "",
        "Implement the required changes, run relevant tests, and prepare a PR.",
      ].join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const { baseUrl, email, apiToken, projectKey } = getJiraConfig(project);
      const states: string[] = [];
      if (filters.state === "open") states.push("statusCategory != Done");
      if (filters.state === "closed") states.push("statusCategory = Done");
      const assignee = filters.assignee ? `assignee = "${quoteJqlLiteral(filters.assignee)}"` : "";
      const escapedProjectKey = quoteJqlLiteral(projectKey);
      const jqlParts = [`project = "${escapedProjectKey}"`, ...states, assignee].filter(Boolean);
      const jql = jqlParts.join(" AND ");
      const params = new URLSearchParams();
      params.set("jql", jql);
      params.set("maxResults", String(filters.limit ?? 30));
      params.set("fields", "summary,description,status,labels,assignee");

      const data = await jiraRequest<{ issues?: JiraIssue[] }>(
        "GET",
        `${baseUrl}/rest/api/3/search?${params.toString()}`,
        email,
        apiToken,
      );
      return (data.issues ?? []).map((i) => mapIssue(i, baseUrl));
    },

    async updateIssue(identifier: string, update: IssueUpdate, project: ProjectConfig): Promise<void> {
      const { baseUrl, email, apiToken } = getJiraConfig(project);

      if (update.state) {
        const transitionId = await findTransitionId(identifier, update.state, baseUrl, email, apiToken);
        if (transitionId) {
          await jiraRequest(
            "POST",
            `${baseUrl}/rest/api/3/issue/${encodeURIComponent(identifier)}/transitions`,
            email,
            apiToken,
            { transition: { id: transitionId } },
          );
        }
      }

      if (update.comment) {
        await jiraRequest(
          "POST",
          `${baseUrl}/rest/api/3/issue/${encodeURIComponent(identifier)}/comment`,
          email,
          apiToken,
          { body: toAdfDoc(update.comment) },
        );
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const { baseUrl, email, apiToken, projectKey, issueType } = getJiraConfig(project);
      const issueTypeName = await pickIssueTypeName(
        baseUrl,
        email,
        apiToken,
        projectKey,
        issueType,
      );

      const created = await jiraRequest<{ key: string }>(
        "POST",
        `${baseUrl}/rest/api/3/issue`,
        email,
        apiToken,
        {
          fields: {
            project: { key: projectKey },
            summary: input.title,
            description: input.description,
            issuetype: { name: issueTypeName },
            labels: input.labels ?? [],
          },
        },
      );

      return this.getIssue(created.key, project);
    },
  };
}

export function create(): Tracker {
  return createJiraTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
