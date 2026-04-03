/**
 * Jira Cloud REST API v3 client.
 *
 * Auth: Basic auth with email + API token.
 * Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: AdfNode | null;
    status: { name: string };
    priority?: { name: string } | null;
    labels: string[];
    assignee?: { displayName: string; accountId: string } | null;
    issuetype?: { name: string } | null;
  };
}

export interface JiraTransition {
  id: string;
  name: string;
}

export interface JiraSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

/** Atlassian Document Format node (recursive). */
export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string }>;
}

// ---------------------------------------------------------------------------
// ADF → Markdown converter
// ---------------------------------------------------------------------------

export function adfToMarkdown(node: AdfNode | null): string {
  if (!node) return "";
  return renderNode(node).trim();
}

function renderNode(node: AdfNode, listDepth = 0): string {
  switch (node.type) {
    case "doc":
      return (node.content ?? []).map((c) => renderNode(c, listDepth)).join("");

    case "paragraph":
      return (node.content ?? []).map((c) => renderNode(c, listDepth)).join("") + "\n\n";

    case "heading": {
      const level = (node.attrs?.level as number) ?? 1;
      const prefix = "#".repeat(level);
      const text = (node.content ?? []).map((c) => renderNode(c, listDepth)).join("");
      return `${prefix} ${text}\n\n`;
    }

    case "text": {
      let text = node.text ?? "";
      const marks = node.marks ?? [];
      for (const mark of marks) {
        if (mark.type === "strong") text = `**${text}**`;
        else if (mark.type === "em") text = `*${text}*`;
        else if (mark.type === "code") text = `\`${text}\``;
        else if (mark.type === "strike") text = `~~${text}~~`;
      }
      return text;
    }

    case "codeBlock": {
      const lang = (node.attrs?.language as string) ?? "";
      const code = (node.content ?? []).map((c) => c.text ?? "").join("");
      return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    }

    case "bulletList":
      return (node.content ?? []).map((c) => renderNode(c, listDepth)).join("");

    case "orderedList":
      return (node.content ?? []).map((c) => renderNode(c, listDepth)).join("");

    case "listItem": {
      const indent = "  ".repeat(listDepth);
      const body = (node.content ?? [])
        .map((c) => renderNode(c, listDepth + 1))
        .join("")
        .trimEnd();
      return `${indent}- ${body}\n`;
    }

    case "hardBreak":
      return "\n";

    case "blockquote": {
      const inner = (node.content ?? []).map((c) => renderNode(c, listDepth)).join("");
      return inner
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n") + "\n";
    }

    case "rule":
      return "---\n\n";

    default:
      // Best effort: recurse into children
      return (node.content ?? []).map((c) => renderNode(c, listDepth)).join("");
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(config: JiraClientConfig) {
    // Strip trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    const credentials = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
    this.authHeader = `Basic ${credentials}`;
  }

  // ---- helpers ------------------------------------------------------------

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}/rest/api/3/${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401) {
        throw new Error(`Jira authentication failed (401). Check JIRA_EMAIL and JIRA_API_TOKEN.`);
      }
      if (res.status === 404) {
        throw new Error(`Jira resource not found (404): ${path}`);
      }
      if (res.status === 429) {
        throw new Error(`Jira rate limit exceeded (429). Retry later.`);
      }
      throw new Error(`Jira API error ${res.status}: ${body}`);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ---- public API ---------------------------------------------------------

  /** Search issues using JQL. Handles pagination internally. */
  async searchIssues(jql: string, limit = 50): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    let startAt = 0;

    while (issues.length < limit) {
      const pageSize = Math.min(limit - issues.length, 100);
      const result = await this.request<JiraSearchResponse>(
        `search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${pageSize}&fields=summary,description,status,priority,labels,assignee,issuetype`,
      );
      issues.push(...result.issues);
      if (issues.length >= result.total || result.issues.length === 0) break;
      startAt += result.issues.length;
    }

    return issues.slice(0, limit);
  }

  /** Get a single issue by key (e.g. "PROJ-123"). */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.request<JiraIssue>(
      `issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,priority,labels,assignee,issuetype`,
    );
  }

  /** Get available transitions for an issue. */
  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const result = await this.request<{ transitions: JiraTransition[] }>(
      `issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    return result.transitions;
  }

  /** Transition an issue by transition name. */
  async transitionIssue(issueKey: string, transitionName: string): Promise<void> {
    const transitions = await this.getTransitions(issueKey);
    const match = transitions.find(
      (t) => t.name.toLowerCase() === transitionName.toLowerCase(),
    );
    if (!match) {
      const available = transitions.map((t) => t.name).join(", ");
      throw new Error(
        `Transition "${transitionName}" not found for ${issueKey}. Available: ${available}`,
      );
    }
    await this.request(`issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: match.id } }),
    });
  }

  /** Add a plain-text comment (converted to ADF). */
  async addComment(issueKey: string, body: string): Promise<void> {
    const adfBody = {
      body: {
        version: 1,
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: body }],
          },
        ],
      },
    };
    await this.request(`issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      body: JSON.stringify(adfBody),
    });
  }

  /** Create a new issue. Returns the created issue key and id. */
  async createIssue(
    fields: Record<string, unknown>,
  ): Promise<{ id: string; key: string }> {
    return this.request<{ id: string; key: string }>("issue", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });
  }

  /** Update issue fields. */
  async updateIssue(
    issueKey: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await this.request(`issue/${encodeURIComponent(issueKey)}`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    });
  }
}
