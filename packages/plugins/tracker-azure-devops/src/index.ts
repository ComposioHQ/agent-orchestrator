/**
 * tracker-azure-devops plugin -- Azure DevOps Work Items as an issue tracker.
 *
 * Uses the Azure DevOps REST API via fetch().
 * Auth: AZURE_DEVOPS_PAT env var (Personal Access Token), Basic auth.
 * Org: AZURE_DEVOPS_ORG env var.
 * Base URL: https://dev.azure.com/{org}/{project}/_apis/wit/workitems
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
    throw new Error(
      `${name} environment variable is required for the Azure DevOps tracker plugin`,
    );
  }
  return val;
}

function getAuthHeader(): string {
  const pat = getEnv("AZURE_DEVOPS_PAT");
  return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

function getOrg(): string {
  return getEnv("AZURE_DEVOPS_ORG");
}

function getAdoProject(project: ProjectConfig): string {
  // Allow override via tracker config, otherwise derive from repo name
  const adoProject = project.tracker?.["adoProject"] as string | undefined;
  if (adoProject) return adoProject;
  // Fallback: use the repo name part (owner/repo -> repo)
  const parts = project.repo.split("/");
  return parts[parts.length - 1] || project.repo;
}

function getBaseUrl(project: ProjectConfig): string {
  const org = getOrg();
  const adoProject = getAdoProject(project);
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(adoProject)}`;
}

interface AdoFetchOptions {
  method?: string;
  body?: unknown;
  contentType?: string;
}

async function adoFetch<T>(
  url: string,
  options: AdoFetchOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: getAuthHeader(),
    Accept: "application/json",
    "Content-Type": options.contentType ?? "application/json",
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
        `Azure DevOps API ${options.method ?? "GET"} returned ${res.status}: ${text.slice(0, 200)}`,
      );
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Azure DevOps API returned invalid JSON: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Types for Azure DevOps responses
// ---------------------------------------------------------------------------

interface AdoWorkItem {
  id: number;
  rev: number;
  fields: {
    "System.Title": string;
    "System.Description"?: string;
    "System.State": string;
    "System.Tags"?: string;
    "System.AssignedTo"?: {
      displayName: string;
      uniqueName: string;
    };
    "Microsoft.VSTS.Common.Priority"?: number;
    "System.WorkItemType": string;
  };
  url: string;
  _links?: {
    html?: { href: string };
  };
}

interface AdoWiqlResult {
  workItems: Array<{ id: number; url: string }>;
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapAdoState(state: string): Issue["state"] {
  const s = state.toLowerCase();
  if (s === "done" || s === "closed" || s === "resolved" || s === "removed") {
    return "closed";
  }
  if (s === "active" || s === "committed" || s === "in progress") {
    return "in_progress";
  }
  // "New", "To Do", etc.
  return "open";
}

function getWorkItemUrl(project: ProjectConfig, id: number): string {
  const org = getOrg();
  const adoProject = getAdoProject(project);
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(adoProject)}/_workitems/edit/${id}`;
}

function parseTags(tags: string | undefined): string[] {
  if (!tags) return [];
  return tags
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
}

function toAdoIssue(item: AdoWorkItem, project: ProjectConfig): Issue {
  const fields = item.fields;
  return {
    id: String(item.id),
    title: fields["System.Title"],
    description: fields["System.Description"] ?? "",
    url: item._links?.html?.href ?? getWorkItemUrl(project, item.id),
    state: mapAdoState(fields["System.State"]),
    labels: parseTags(fields["System.Tags"]),
    assignee: fields["System.AssignedTo"]?.displayName,
    priority: fields["Microsoft.VSTS.Common.Priority"],
  };
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createAzureDevOpsTracker(): Tracker {
  return {
    name: "azure-devops",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const baseUrl = getBaseUrl(project);
      const item = await adoFetch<AdoWorkItem>(
        `${baseUrl}/_apis/wit/workitems/${encodeURIComponent(identifier)}?$expand=links&api-version=7.1`,
      );
      return toAdoIssue(item, project);
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const baseUrl = getBaseUrl(project);
      const item = await adoFetch<AdoWorkItem>(
        `${baseUrl}/_apis/wit/workitems/${encodeURIComponent(identifier)}?$fields=System.State&api-version=7.1`,
      );
      const state = item.fields["System.State"].toLowerCase();
      return state === "done" || state === "closed" || state === "resolved" || state === "removed";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      return getWorkItemUrl(project, Number(identifier));
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract work item ID from URL like .../edit/12345
      const match = url.match(/\/(?:_workitems\/edit|workitems)\/(\d+)/);
      if (match) return `#${match[1]}`;
      const parts = url.split("/");
      return parts[parts.length - 1] || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/wi-${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Azure DevOps work item #${issue.id}: ${issue.title}`,
        `Work item URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Tags: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this work item. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const baseUrl = getBaseUrl(project);
      const adoProject = getAdoProject(project);

      // Build WIQL query
      const conditions: string[] = [`[System.TeamProject] = '${adoProject}'`];

      if (filters.state === "closed") {
        conditions.push(
          "[System.State] IN ('Done', 'Closed', 'Resolved', 'Removed')",
        );
      } else if (filters.state === "open") {
        conditions.push(
          "[System.State] NOT IN ('Done', 'Closed', 'Resolved', 'Removed')",
        );
      }
      // "all" = no state filter

      if (filters.assignee) {
        conditions.push(`[System.AssignedTo] = '${filters.assignee}'`);
      }

      if (filters.labels && filters.labels.length > 0) {
        for (const label of filters.labels) {
          conditions.push(`[System.Tags] Contains '${label}'`);
        }
      }

      const top = filters.limit ?? 30;
      const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(" AND ")} ORDER BY [System.CreatedDate] DESC`;

      const wiqlResult = await adoFetch<AdoWiqlResult>(
        `${baseUrl}/_apis/wit/wiql?api-version=7.1`,
        {
          method: "POST",
          body: { query: wiql },
        },
      );

      if (!wiqlResult.workItems || wiqlResult.workItems.length === 0) {
        return [];
      }

      // Fetch work item details in batch (max top items)
      const ids = wiqlResult.workItems.slice(0, top).map((wi) => wi.id);
      const items = await adoFetch<{ value: AdoWorkItem[] }>(
        `${baseUrl}/_apis/wit/workitems?ids=${ids.join(",")}&$expand=links&api-version=7.1`,
      );

      return (items.value ?? []).map((item) => toAdoIssue(item, project));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const baseUrl = getBaseUrl(project);
      const patchOps: Array<{ op: string; path: string; value: unknown }> = [];

      if (update.state) {
        const stateValue =
          update.state === "closed"
            ? "Closed"
            : update.state === "in_progress"
              ? "Active"
              : "New";
        patchOps.push({
          op: "replace",
          path: "/fields/System.State",
          value: stateValue,
        });
      }

      if (update.assignee) {
        patchOps.push({
          op: "replace",
          path: "/fields/System.AssignedTo",
          value: update.assignee,
        });
      }

      if (update.labels && update.labels.length > 0) {
        // Fetch existing tags to merge
        const item = await adoFetch<AdoWorkItem>(
          `${baseUrl}/_apis/wit/workitems/${encodeURIComponent(identifier)}?$fields=System.Tags&api-version=7.1`,
        );
        const existingTags = parseTags(item.fields["System.Tags"]);
        const allTags = [...new Set([...existingTags, ...update.labels])];
        patchOps.push({
          op: "replace",
          path: "/fields/System.Tags",
          value: allTags.join("; "),
        });
      }

      if (patchOps.length > 0) {
        await adoFetch(
          `${baseUrl}/_apis/wit/workitems/${encodeURIComponent(identifier)}?api-version=7.1`,
          {
            method: "PATCH",
            body: patchOps,
            contentType: "application/json-patch+json",
          },
        );
      }

      // Handle comment
      if (update.comment) {
        await adoFetch(
          `${baseUrl}/_apis/wit/workitems/${encodeURIComponent(identifier)}/comments?api-version=7.1-preview.4`,
          {
            method: "POST",
            body: { text: update.comment },
          },
        );
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const baseUrl = getBaseUrl(project);
      const workItemType = (project.tracker?.["workItemType"] as string) ?? "Task";

      const patchOps: Array<{ op: string; path: string; value: unknown }> = [
        { op: "add", path: "/fields/System.Title", value: input.title },
      ];

      if (input.description) {
        patchOps.push({
          op: "add",
          path: "/fields/System.Description",
          value: input.description,
        });
      }

      if (input.labels && input.labels.length > 0) {
        patchOps.push({
          op: "add",
          path: "/fields/System.Tags",
          value: input.labels.join("; "),
        });
      }

      if (input.assignee) {
        patchOps.push({
          op: "add",
          path: "/fields/System.AssignedTo",
          value: input.assignee,
        });
      }

      if (input.priority !== undefined) {
        patchOps.push({
          op: "add",
          path: "/fields/Microsoft.VSTS.Common.Priority",
          value: input.priority,
        });
      }

      const item = await adoFetch<AdoWorkItem>(
        `${baseUrl}/_apis/wit/workitems/$${encodeURIComponent(workItemType)}?api-version=7.1`,
        {
          method: "POST",
          body: patchOps,
          contentType: "application/json-patch+json",
        },
      );

      return toAdoIssue(item, project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "azure-devops",
  slot: "tracker" as const,
  description: "Tracker plugin: Azure DevOps Work Items",
  version: "0.1.0",
};

export function create(): Tracker {
  return createAzureDevOpsTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
