/**
 * tracker-jira plugin — Jira as an issue tracker.
 *
 * Uses the Jira REST API v3 with either:
 * - JIRA_EMAIL + JIRA_API_TOKEN (direct API access)
 * - COMPOSIO_API_KEY (via Composio SDK)
 *
 * Auto-detects which key is available and routes accordingly.
 *
 * The Jira host (e.g. mycompany.atlassian.net) is read from
 * project.tracker.host at call time, not from environment variables.
 */

import { request } from "node:https";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";
import type { Composio } from "@composio/core";

// ---------------------------------------------------------------------------
// Types for Jira responses
// ---------------------------------------------------------------------------

interface JiraStatusCategory {
  key: string; // "new" | "indeterminate" | "done" | "undefined"
  name: string;
}

interface JiraStatus {
  name: string;
  statusCategory: JiraStatusCategory;
}

/** Atlassian Document Format node */
interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
}

interface JiraIssueFields {
  summary: string;
  description: AdfNode | string | null;
  status: JiraStatus;
  labels: string[];
  assignee: { displayName: string; emailAddress?: string } | null;
  priority: { name: string; id: string } | null;
  issuetype: { name: string } | null;
  project: { key: string } | null;
}

interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
}

interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
  startAt: number;
}

interface JiraTransition {
  id: string;
  name: string;
  to: {
    statusCategory: JiraStatusCategory;
  };
}

interface JiraTransitionsResponse {
  transitions: JiraTransition[];
}

// ---------------------------------------------------------------------------
// Direct Jira API helpers
// ---------------------------------------------------------------------------

function getDirectCredentials(): { email: string; apiToken: string } {
  const email = process.env["JIRA_EMAIL"];
  const apiToken = process.env["JIRA_API_TOKEN"];
  if (!email || !apiToken) {
    throw new Error(
      "JIRA_EMAIL and JIRA_API_TOKEN environment variables are required for the direct Jira transport",
    );
  }
  return { email, apiToken };
}

/** Low-level HTTPS request helper for the direct transport. */
function jiraHttpRequest<T>(
  host: string,
  auth: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const req = request(
      {
        hostname: host,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Basic ${auth}`,
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("error", (err: Error) => settle(() => reject(err)));
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          settle(() => {
            try {
              const text = Buffer.concat(chunks).toString("utf-8");
              const status = res.statusCode ?? 0;
              if (status < 200 || status >= 300) {
                reject(new Error(`Jira API returned HTTP ${status}: ${text.slice(0, 200)}`));
                return;
              }
              // Some Jira endpoints return 204 with no body
              if (!text || text.trim() === "") {
                resolve(undefined as T);
                return;
              }
              resolve(JSON.parse(text) as T);
            } catch (err) {
              reject(err);
            }
          });
        });
      },
    );

    req.setTimeout(30_000, () => {
      settle(() => {
        req.destroy();
        reject(new Error("Jira API request timed out after 30s"));
      });
    });

    req.on("error", (err) => settle(() => reject(err)));
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapJiraState(statusCategory: JiraStatusCategory, statusName: string): Issue["state"] {
  // Check for cancelled status by name
  if (statusName.toLowerCase().includes("cancel")) {
    return "cancelled";
  }

  switch (statusCategory.key) {
    case "done":
      return "closed";
    case "indeterminate":
      return "in_progress";
    case "new":
    default:
      return "open";
  }
}

/** Map priority name to a numeric value (1 = highest) */
function mapJiraPriority(priority: { name: string; id: string } | null): number | undefined {
  if (!priority) return undefined;
  // Jira default priority IDs: 1=Highest, 2=High, 3=Medium, 4=Low, 5=Lowest
  const id = parseInt(priority.id, 10);
  if (!isNaN(id) && id >= 1 && id <= 5) return id;
  return undefined;
}

// ---------------------------------------------------------------------------
// ADF -> plain text
// ---------------------------------------------------------------------------

/** Recursively extract plain text from an Atlassian Document Format tree. */
function adfToText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  if (!node.content) return "";
  const parts = node.content.map(adfToText);
  // Add newlines between block-level nodes
  if (
    node.type === "doc" ||
    node.type === "paragraph" ||
    node.type === "bulletList" ||
    node.type === "orderedList" ||
    node.type === "listItem"
  ) {
    return parts.join("\n");
  }
  return parts.join("");
}

function extractDescription(desc: AdfNode | string | null): string {
  if (desc === null || desc === undefined) return "";
  if (typeof desc === "string") return desc;
  return adfToText(desc).trim();
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ISSUE_FIELDS_PARAM = "summary,status,labels,assignee,priority,issuetype,project,description";

function getHost(project: ProjectConfig): string {
  const host = project.tracker?.["host"] as string | undefined;
  if (!host) {
    throw new Error(
      "Jira tracker requires 'host' in project tracker config (e.g. mycompany.atlassian.net)",
    );
  }
  return host;
}

function mapIssue(jiraIssue: JiraIssue, host: string): Issue {
  const fields = jiraIssue.fields;
  return {
    id: jiraIssue.key,
    title: fields.summary,
    description: extractDescription(fields.description),
    url: `https://${host}/browse/${jiraIssue.key}`,
    state: mapJiraState(fields.status.statusCategory, fields.status.name),
    labels: fields.labels ?? [],
    assignee: fields.assignee?.displayName,
    priority: mapJiraPriority(fields.priority),
  };
}

function extractIssueLabel(url: string): string {
  // Extract issue key from Jira URL
  // Examples:
  //   https://mycompany.atlassian.net/browse/PROJ-123
  //   https://mycompany.atlassian.net/browse/PROJ-123?focusedId=12345
  const match = url.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
  if (match) {
    return match[1];
  }
  // Fallback: return the last path segment
  const parts = url.split("/");
  return parts[parts.length - 1] || url;
}

function buildPromptText(issue: Issue): string {
  const lines = [
    `You are working on Jira ticket ${issue.id}: ${issue.title}`,
    `Issue URL: ${issue.url}`,
    "",
  ];

  if (issue.labels.length > 0) {
    lines.push(`Labels: ${issue.labels.join(", ")}`);
  }

  if (issue.priority !== undefined) {
    const priorityNames: Record<number, string> = {
      1: "Highest",
      2: "High",
      3: "Medium",
      4: "Low",
      5: "Lowest",
    };
    lines.push(`Priority: ${priorityNames[issue.priority] ?? String(issue.priority)}`);
  }

  if (issue.description) {
    lines.push("## Description", "", issue.description);
  }

  lines.push(
    "",
    "Please implement the changes described in this ticket. When done, commit and push your changes.",
  );

  return lines.join("\n");
}

function buildJql(
  filters: IssueFilters,
  project: ProjectConfig,
): { jql: string; maxResults: number } {
  const projectKey = project.tracker?.["projectKey"] as string | undefined;
  const clauses: string[] = [];

  if (projectKey) {
    clauses.push(`project = "${projectKey}"`);
  }

  if (filters.state === "closed") {
    clauses.push('statusCategory = "Done"');
  } else if (filters.state !== "all") {
    clauses.push('statusCategory != "Done"');
  }

  if (filters.assignee) {
    clauses.push(`assignee = "${filters.assignee}"`);
  }

  if (filters.labels && filters.labels.length > 0) {
    for (const label of filters.labels) {
      clauses.push(`labels = "${label}"`);
    }
  }

  return {
    jql: clauses.length > 0 ? clauses.join(" AND ") : "ORDER BY created DESC",
    maxResults: filters.limit ?? 30,
  };
}

function targetCategoryKey(state: "open" | "in_progress" | "closed"): string {
  if (state === "closed") return "done";
  if (state === "in_progress") return "indeterminate";
  return "new";
}

function adfCommentBody(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function buildCreateIssueFields(
  input: CreateIssueInput,
  projectKey: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    summary: input.title,
    issuetype: { name: "Task" },
  };

  if (input.description) {
    fields["description"] = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: input.description }],
        },
      ],
    };
  }

  if (input.labels && input.labels.length > 0) {
    fields["labels"] = input.labels;
  }

  if (input.assignee) {
    fields["assignee"] = { name: input.assignee };
  }

  if (input.priority !== undefined) {
    fields["priority"] = { id: String(input.priority) };
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Direct Jira tracker
// ---------------------------------------------------------------------------

function createDirectTracker(): Tracker {
  const { email, apiToken } = getDirectCredentials();
  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

  const http = <T>(host: string, method: string, path: string, body?: unknown): Promise<T> =>
    jiraHttpRequest<T>(host, auth, method, path, body);

  return {
    name: "jira",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const host = getHost(project);
      const jiraIssue = await http<JiraIssue>(
        host,
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(identifier)}`,
      );
      return mapIssue(jiraIssue, host);
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const host = getHost(project);
      const qs = `?fields=${encodeURIComponent("status")}`;
      const jiraIssue = await http<JiraIssue>(
        host,
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(identifier)}${qs}`,
      );
      return jiraIssue.fields.status.statusCategory.key === "done";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const host = getHost(project);
      return `https://${host}/browse/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      return extractIssueLabel(url);
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      return buildPromptText(issue);
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const host = getHost(project);
      const { jql, maxResults } = buildJql(filters, project);
      const params = new URLSearchParams({
        jql,
        maxResults: String(maxResults),
        fields: ISSUE_FIELDS_PARAM,
      });
      const result = await http<JiraSearchResult>(
        host,
        "GET",
        `/rest/api/3/search/jql?${params.toString()}`,
      );
      return result.issues.map((issue) => mapIssue(issue, host));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const host = getHost(project);

      if (update.state) {
        const transitionsData = await http<JiraTransitionsResponse>(
          host,
          "GET",
          `/rest/api/3/issue/${encodeURIComponent(identifier)}/transitions`,
        );
        const catKey = targetCategoryKey(update.state);
        const transition = transitionsData.transitions.find(
          (t) => t.to.statusCategory.key === catKey,
        );
        if (!transition) {
          throw new Error(
            `No transition found to status category "${catKey}" for issue ${identifier}`,
          );
        }
        await http(
          host,
          "POST",
          `/rest/api/3/issue/${encodeURIComponent(identifier)}/transitions`,
          { transition: { id: transition.id } },
        );
      }

      const fieldsUpdate: Record<string, unknown> = {};

      if (update.labels && update.labels.length > 0) {
        const existing = await http<JiraIssue>(
          host,
          "GET",
          `/rest/api/3/issue/${encodeURIComponent(identifier)}?fields=${encodeURIComponent("labels")}`,
        );
        const existingLabels = new Set(existing.fields.labels ?? []);
        for (const label of update.labels) {
          existingLabels.add(label);
        }
        fieldsUpdate["labels"] = [...existingLabels];
      }

      if (update.assignee) {
        fieldsUpdate["assignee"] = { name: update.assignee };
      }

      if (Object.keys(fieldsUpdate).length > 0) {
        await http(host, "PUT", `/rest/api/3/issue/${encodeURIComponent(identifier)}`, {
          fields: fieldsUpdate,
        });
      }

      if (update.comment) {
        await http(
          host,
          "POST",
          `/rest/api/3/issue/${encodeURIComponent(identifier)}/comment`,
          { body: adfCommentBody(update.comment) },
        );
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const host = getHost(project);
      const projectKey = project.tracker?.["projectKey"] as string | undefined;
      if (!projectKey) {
        throw new Error("Jira tracker requires 'projectKey' in project tracker config");
      }
      const fields = buildCreateIssueFields(input, projectKey);
      const created = await http<JiraIssue>(host, "POST", "/rest/api/3/issue", { fields });
      const full = await http<JiraIssue>(
        host,
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(created.key)}`,
      );
      return mapIssue(full, host);
    },
  };
}

// ---------------------------------------------------------------------------
// Composio Jira tracker
// ---------------------------------------------------------------------------

type ComposioTools = Composio["tools"];

function createComposioTracker(apiKey: string, entityId: string): Tracker {
  let clientPromise: Promise<ComposioTools> | undefined;

  function getClient(): Promise<ComposioTools> {
    if (!clientPromise) {
      clientPromise = (async () => {
        try {
          const { Composio } = await import("@composio/core");
          const client = new Composio({ apiKey });
          return client.tools;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            msg.includes("Cannot find module") ||
            msg.includes("Cannot find package") ||
            msg.includes("ERR_MODULE_NOT_FOUND")
          ) {
            throw new Error(
              "Composio SDK (@composio/core) is not installed. " +
                "Install it with: pnpm add @composio/core",
              { cause: err },
            );
          }
          throw err;
        }
      })();
    }
    return clientPromise;
  }

  async function exec<T>(action: string, args: Record<string, unknown>): Promise<T> {
    const tools = await getClient();

    const resultPromise = tools.execute(action, {
      entityId,
      arguments: args,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Composio Jira API request timed out after 30s"));
      }, 30_000);
    });

    resultPromise.catch(() => {});
    timeoutPromise.catch(() => {});

    try {
      const result = await Promise.race([resultPromise, timeoutPromise]);

      if (!result.successful) {
        throw new Error(`Composio Jira API error: ${result.error ?? "unknown error"}`);
      }

      if (!result.data) {
        throw new Error("Composio Jira API returned no data");
      }

      return result.data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "jira",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const host = getHost(project);
      const jiraIssue = await exec<JiraIssue>("JIRA_GET_ISSUE", {
        issue_id_or_key: identifier,
      });
      return mapIssue(jiraIssue, host);
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const jiraIssue = await exec<JiraIssue>("JIRA_GET_ISSUE", {
        issue_id_or_key: identifier,
        fields: "status",
      });
      return jiraIssue.fields.status.statusCategory.key === "done";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const host = getHost(project);
      return `https://${host}/browse/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      return extractIssueLabel(url);
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      return buildPromptText(issue);
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const host = getHost(project);
      const { jql, maxResults } = buildJql(filters, project);
      const result = await exec<JiraSearchResult>("JIRA_SEARCH_ISSUES", {
        jql,
        max_results: maxResults,
        fields: ISSUE_FIELDS_PARAM,
      });
      return result.issues.map((issue) => mapIssue(issue, host));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      if (update.state) {
        const transitionsData = await exec<JiraTransitionsResponse>("JIRA_GET_TRANSITIONS", {
          issue_id_or_key: identifier,
        });
        const catKey = targetCategoryKey(update.state);
        const transition = transitionsData.transitions.find(
          (t) => t.to.statusCategory.key === catKey,
        );
        if (!transition) {
          throw new Error(
            `No transition found to status category "${catKey}" for issue ${identifier}`,
          );
        }
        await exec("JIRA_TRANSITION_ISSUE", {
          issue_id_or_key: identifier,
          transition_id: transition.id,
        });
      }

      const fieldsUpdate: Record<string, unknown> = {};

      if (update.labels && update.labels.length > 0) {
        const existing = await exec<JiraIssue>("JIRA_GET_ISSUE", {
          issue_id_or_key: identifier,
          fields: "labels",
        });
        const existingLabels = new Set(existing.fields.labels ?? []);
        for (const label of update.labels) {
          existingLabels.add(label);
        }
        fieldsUpdate["labels"] = [...existingLabels];
      }

      if (update.assignee) {
        fieldsUpdate["assignee"] = { name: update.assignee };
      }

      if (Object.keys(fieldsUpdate).length > 0) {
        await exec("JIRA_UPDATE_ISSUE", {
          issue_id_or_key: identifier,
          fields: JSON.stringify(fieldsUpdate),
        });
      }

      if (update.comment) {
        await exec("JIRA_ADD_COMMENT", {
          issue_id_or_key: identifier,
          body: JSON.stringify(adfCommentBody(update.comment)),
        });
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const host = getHost(project);
      const projectKey = project.tracker?.["projectKey"] as string | undefined;
      if (!projectKey) {
        throw new Error("Jira tracker requires 'projectKey' in project tracker config");
      }
      const fields = buildCreateIssueFields(input, projectKey);
      const created = await exec<JiraIssue>("JIRA_CREATE_ISSUE", {
        fields: JSON.stringify(fields),
      });
      const full = await exec<JiraIssue>("JIRA_GET_ISSUE", {
        issue_id_or_key: created.key,
      });
      return mapIssue(full, host);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "jira",
  slot: "tracker" as const,
  description: "Tracker plugin: Jira issue tracker",
  version: "0.1.0",
};

export function create(): Tracker {
  const composioKey = process.env["COMPOSIO_API_KEY"];
  if (composioKey) {
    const entityId = process.env["COMPOSIO_ENTITY_ID"] ?? "default";
    return createComposioTracker(composioKey, entityId);
  }
  return createDirectTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
