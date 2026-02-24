/**
 * tracker-azure-devops plugin — Azure DevOps Work Items as an issue tracker.
 *
 * Uses the Azure DevOps Work Item REST API with PAT authentication.
 */

import { request } from "node:https";
import type { PluginModule, Tracker, Issue, ProjectConfig } from "@composio/ao-core";

const API_VERSION = "7.1";
const WORK_ITEM_FIELDS = [
  "System.Title",
  "System.Description",
  "System.State",
  "System.Tags",
  "System.AssignedTo",
];

interface AzureDevOpsIdentityRef {
  displayName?: string;
  uniqueName?: string;
}

interface AzureDevOpsWorkItem {
  id: number;
  fields: Record<string, unknown>;
  _links?: {
    html?: {
      href?: string;
    };
  };
}

interface TrackerSettings {
  organizationUrl: string;
  projectName: string;
}

function getTrackerSettings(project: ProjectConfig): TrackerSettings {
  const tracker = project.tracker;
  const orgValue = tracker?.["organizationUrl"] ?? process.env["AZURE_DEVOPS_ORG_URL"];
  const projectValue = tracker?.["project"] ?? process.env["AZURE_DEVOPS_PROJECT"];

  if (typeof orgValue !== "string" || orgValue.trim() === "") {
    throw new Error(
      "Azure DevOps tracker requires tracker.organizationUrl (or AZURE_DEVOPS_ORG_URL)",
    );
  }

  if (typeof projectValue !== "string" || projectValue.trim() === "") {
    throw new Error("Azure DevOps tracker requires tracker.project (or AZURE_DEVOPS_PROJECT)");
  }

  const organizationUrl = orgValue.trim().replace(/\/+$/, "");
  const projectName = projectValue.trim();
  return { organizationUrl, projectName };
}

function getPat(): string {
  const pat = process.env["AZURE_DEVOPS_PAT"];
  if (!pat || pat.trim() === "") {
    throw new Error("AZURE_DEVOPS_PAT environment variable is required for Azure DevOps tracker");
  }
  return pat;
}

function normalizeIdentifier(identifier: string): string {
  const normalized = identifier.trim().replace(/^#/, "");
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `Azure DevOps work item identifier must be numeric (received "${identifier}")`,
    );
  }
  return normalized;
}

function mapState(state: string): Issue["state"] {
  const normalized = state.toLowerCase();

  if (normalized.includes("cancel") || normalized.includes("removed")) {
    return "cancelled";
  }
  if (
    normalized.includes("closed") ||
    normalized.includes("done") ||
    normalized.includes("resolved") ||
    normalized.includes("completed")
  ) {
    return "closed";
  }
  if (normalized.includes("active") || normalized.includes("progress") || normalized.includes("doing")) {
    return "in_progress";
  }
  return "open";
}

function parseTags(value: unknown): string[] {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }
  return value
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function parseAssignee(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const identity = value as AzureDevOpsIdentityRef;
    if (typeof identity.displayName === "string" && identity.displayName.trim() !== "") {
      return identity.displayName;
    }
    if (typeof identity.uniqueName === "string" && identity.uniqueName.trim() !== "") {
      return identity.uniqueName;
    }
  }
  return undefined;
}

function buildWorkItemUrl(settings: TrackerSettings, identifier: string): string {
  return `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_workitems/edit/${identifier}`;
}

function toIssue(item: AzureDevOpsWorkItem, settings: TrackerSettings): Issue {
  const title = item.fields["System.Title"];
  if (typeof title !== "string" || title.trim() === "") {
    throw new Error(`Azure DevOps work item ${item.id} has no valid System.Title`);
  }

  const stateValue = item.fields["System.State"];
  if (typeof stateValue !== "string" || stateValue.trim() === "") {
    throw new Error(`Azure DevOps work item ${item.id} has no valid System.State`);
  }

  const description = item.fields["System.Description"];
  const issueUrl =
    typeof item._links?.html?.href === "string" && item._links.html.href.trim() !== ""
      ? item._links.html.href
      : buildWorkItemUrl(settings, String(item.id));

  return {
    id: String(item.id),
    title,
    description: typeof description === "string" ? description : "",
    url: issueUrl,
    state: mapState(stateValue),
    labels: parseTags(item.fields["System.Tags"]),
    assignee: parseAssignee(item.fields["System.AssignedTo"]),
  };
}

function requestAzureDevOps<T>(
  method: "GET" | "POST" | "PATCH",
  url: URL,
  body?: unknown,
): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const auth = `Basic ${Buffer.from(`:${getPat()}`).toString("base64")}`;

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
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          Accept: "application/json",
          Authorization: auth,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("error", (err: Error) => settle(() => reject(err)));
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          settle(() => {
            const text = Buffer.concat(chunks).toString("utf-8");
            const status = res.statusCode ?? 0;

            if (status < 200 || status >= 300) {
              reject(new Error(`Azure DevOps API returned HTTP ${status}: ${text.slice(0, 400)}`));
              return;
            }

            if (text.trim() === "") {
              reject(new Error("Azure DevOps API returned an empty response body"));
              return;
            }

            try {
              resolve(JSON.parse(text) as T);
            } catch (err) {
              reject(
                new Error(`Failed to parse Azure DevOps API JSON response: ${(err as Error).message}`),
              );
            }
          });
        });
      },
    );

    req.setTimeout(30_000, () => {
      settle(() => {
        req.destroy();
        reject(new Error("Azure DevOps API request timed out after 30s"));
      });
    });

    req.on("error", (err) => settle(() => reject(err)));
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function fetchWorkItem(identifier: string, project: ProjectConfig): Promise<Issue> {
  const settings = getTrackerSettings(project);
  const id = normalizeIdentifier(identifier);

  const url = new URL(
    `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_apis/wit/workitems/${id}`,
  );
  url.searchParams.set("api-version", API_VERSION);
  url.searchParams.set("fields", WORK_ITEM_FIELDS.join(","));

  const data = await requestAzureDevOps<AzureDevOpsWorkItem>("GET", url);
  return toIssue(data, settings);
}

function createAzureDevOpsTracker(): Tracker {
  return {
    name: "azure-devops",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      return fetchWorkItem(identifier, project);
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const issue = await fetchWorkItem(identifier, project);
      return issue.state === "closed" || issue.state === "cancelled";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const settings = getTrackerSettings(project);
      const id = normalizeIdentifier(identifier);
      return buildWorkItemUrl(settings, id);
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      const match = url.match(/\/_workitems\/edit\/(\d+)/);
      if (match) {
        return `#${match[1]}`;
      }
      const parts = url.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const id = normalizeIdentifier(identifier);
      return `feat/workitem-${id}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Azure DevOps work item #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
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
  };
}

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
