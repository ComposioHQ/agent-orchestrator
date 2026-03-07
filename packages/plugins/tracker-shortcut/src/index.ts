/**
 * tracker-shortcut plugin -- Shortcut (formerly Clubhouse) as an issue tracker.
 *
 * Uses the Shortcut REST API v3 via fetch().
 * Auth: SHORTCUT_API_TOKEN env var.
 * Base URL: https://api.app.shortcut.com/api/v3
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

const BASE_URL = "https://api.app.shortcut.com/api/v3";

function getToken(): string {
  const token = process.env["SHORTCUT_API_TOKEN"];
  if (!token) {
    throw new Error(
      "SHORTCUT_API_TOKEN environment variable is required for the Shortcut tracker plugin",
    );
  }
  return token;
}

interface ShortcutFetchOptions {
  method?: string;
  body?: unknown;
}

async function shortcutFetch<T>(path: string, options: ShortcutFetchOptions = {}): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Shortcut-Token": getToken(),
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
      throw new Error(
        `Shortcut API ${options.method ?? "GET"} ${path} returned ${res.status}: ${text.slice(0, 200)}`,
      );
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Shortcut API returned invalid JSON for ${path}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Types for Shortcut responses
// ---------------------------------------------------------------------------

interface ShortcutStory {
  id: number;
  name: string;
  description: string;
  app_url: string;
  story_type: string;
  workflow_state_id: number;
  labels: Array<{ name: string }>;
  owner_ids: string[];
  owners: Array<{ profile: { mention_name: string } }>;
  estimate?: number;
  completed: boolean;
  started: boolean;
  archived: boolean;
}

interface ShortcutWorkflowState {
  id: number;
  name: string;
  type: string; // "unstarted" | "started" | "done"
}

interface ShortcutMember {
  id: string;
  profile: { mention_name: string; name: string };
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapShortcutState(story: ShortcutStory): Issue["state"] {
  if (story.completed || story.archived) return "closed";
  if (story.started) return "in_progress";
  return "open";
}

function toShortcutIssue(story: ShortcutStory): Issue {
  return {
    id: String(story.id),
    title: story.name,
    description: story.description ?? "",
    url: story.app_url,
    state: mapShortcutState(story),
    labels: (story.labels ?? []).map((l) => l.name),
    assignee: story.owners?.[0]?.profile?.mention_name,
  };
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createShortcutTracker(): Tracker {
  return {
    name: "shortcut",

    async getIssue(identifier: string, _project: ProjectConfig): Promise<Issue> {
      const story = await shortcutFetch<ShortcutStory>(
        `/stories/${encodeURIComponent(identifier)}`,
      );
      return toShortcutIssue(story);
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const story = await shortcutFetch<ShortcutStory>(
        `/stories/${encodeURIComponent(identifier)}`,
      );
      return story.completed || story.archived;
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      return `https://app.shortcut.com/story/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract story ID from URL like https://app.shortcut.com/workspace/story/12345/title
      const match = url.match(/\/story\/(\d+)/);
      if (match) return `sc-${match[1]}`;
      const parts = url.split("/");
      return parts[parts.length - 1] || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/sc-${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Shortcut story #${issue.id}: ${issue.title}`,
        `Story URL: ${issue.url}`,
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
        "Please implement the changes described in this story. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, _project: ProjectConfig): Promise<Issue[]> {
      // Shortcut uses a search endpoint for filtered queries
      const queryParts: string[] = [];

      if (filters.state === "closed") {
        queryParts.push("is:done");
      } else if (filters.state === "open") {
        queryParts.push("!is:done !is:archived");
      }
      // "all" = no state filter

      if (filters.labels && filters.labels.length > 0) {
        for (const label of filters.labels) {
          queryParts.push(`label:"${label}"`);
        }
      }

      if (filters.assignee) {
        queryParts.push(`owner:${filters.assignee}`);
      }

      const query = queryParts.join(" ") || "!is:archived";
      const pageSize = filters.limit ?? 30;

      const searchResult = await shortcutFetch<{ data: ShortcutStory[] }>(
        `/search/stories`,
        {
          method: "POST",
          body: {
            query,
            page_size: pageSize,
          },
        },
      );

      return (searchResult.data ?? []).map(toShortcutIssue);
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      const body: Record<string, unknown> = {};

      // Handle state change
      if (update.state) {
        // Need to find the workflow state ID for the target state
        const workflows = await shortcutFetch<
          Array<{ states: ShortcutWorkflowState[] }>
        >("/workflows");

        const targetType =
          update.state === "closed"
            ? "done"
            : update.state === "in_progress"
              ? "started"
              : "unstarted";

        let targetState: ShortcutWorkflowState | undefined;
        for (const workflow of workflows) {
          targetState = workflow.states.find((s) => s.type === targetType);
          if (targetState) break;
        }

        if (targetState) {
          body["workflow_state_id"] = targetState.id;
        }
      }

      // Handle labels (additive)
      if (update.labels && update.labels.length > 0) {
        // Fetch current story to get existing labels
        const story = await shortcutFetch<ShortcutStory>(
          `/stories/${encodeURIComponent(identifier)}`,
        );
        const existingLabels = (story.labels ?? []).map((l) => ({ name: l.name }));
        const newLabels = update.labels.map((n: string) => ({ name: n }));
        const allLabels = [...existingLabels, ...newLabels];
        // Deduplicate by name
        const seen = new Set<string>();
        body["labels"] = allLabels.filter((l) => {
          if (seen.has(l.name)) return false;
          seen.add(l.name);
          return true;
        });
      }

      // Handle assignee
      if (update.assignee) {
        const members = await shortcutFetch<ShortcutMember[]>("/members");
        const member = members.find(
          (m) =>
            m.profile.mention_name === update.assignee ||
            m.profile.name === update.assignee,
        );
        if (member) {
          body["owner_ids"] = [member.id];
        }
      }

      if (Object.keys(body).length > 0) {
        await shortcutFetch(`/stories/${encodeURIComponent(identifier)}`, {
          method: "PUT",
          body,
        });
      }

      // Handle comment
      if (update.comment) {
        await shortcutFetch(
          `/stories/${encodeURIComponent(identifier)}/comments`,
          {
            method: "POST",
            body: { text: update.comment },
          },
        );
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const projectId = project.tracker?.["projectId"] as string | undefined;

      const body: Record<string, unknown> = {
        name: input.title,
        description: input.description ?? "",
        story_type: "feature",
      };

      if (projectId) {
        body["project_id"] = Number(projectId);
      }

      if (input.labels && input.labels.length > 0) {
        body["labels"] = input.labels.map((n: string) => ({ name: n }));
      }

      if (input.assignee) {
        const members = await shortcutFetch<ShortcutMember[]>("/members");
        const member = members.find(
          (m) =>
            m.profile.mention_name === input.assignee ||
            m.profile.name === input.assignee,
        );
        if (member) {
          body["owner_ids"] = [member.id];
        }
      }

      const story = await shortcutFetch<ShortcutStory>("/stories", {
        method: "POST",
        body,
      });

      return toShortcutIssue(story);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "shortcut",
  slot: "tracker" as const,
  description: "Tracker plugin: Shortcut",
  version: "0.1.0",
};

export function create(): Tracker {
  return createShortcutTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
