/**
 * tracker-monday plugin -- Monday.com as an issue tracker.
 *
 * Uses the Monday.com GraphQL API via fetch().
 * Auth: MONDAY_API_TOKEN env var.
 * Auth header: Authorization: {token}
 * Base URL: https://api.monday.com/v2
 * Board: MONDAY_BOARD_ID env var.
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

const API_URL = "https://api.monday.com/v2";

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `${name} environment variable is required for the Monday.com tracker plugin`,
    );
  }
  return val;
}

function getToken(): string {
  return getEnv("MONDAY_API_TOKEN");
}

function getBoardId(project: ProjectConfig): string {
  const boardId = project.tracker?.["boardId"] as string | undefined;
  if (boardId) return boardId;
  return getEnv("MONDAY_BOARD_ID");
}

interface MondayResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function mondayQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: getToken(),
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Monday.com API returned ${res.status}: ${text.slice(0, 200)}`,
      );
    }

    const text = await res.text();
    let json: MondayResponse<T>;
    try {
      json = JSON.parse(text) as MondayResponse<T>;
    } catch {
      throw new Error(`Monday.com API returned invalid JSON: ${text.slice(0, 200)}`);
    }

    if (json.errors && json.errors.length > 0) {
      throw new Error(`Monday.com API error: ${json.errors[0].message}`);
    }

    if (!json.data) {
      throw new Error("Monday.com API returned no data");
    }

    return json.data;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Types for Monday responses
// ---------------------------------------------------------------------------

interface MondayItem {
  id: string;
  name: string;
  state: string; // "active" | "archived" | "deleted" | "all"
  column_values: Array<{
    id: string;
    title: string;
    text?: string;
    value?: string;
    type: string;
  }>;
  group?: {
    id: string;
    title: string;
  };
  subscribers?: Array<{
    id: string;
    name: string;
  }>;
  board?: {
    id: string;
  };
  updates?: Array<{
    id: string;
    text_body: string;
    body: string;
  }>;
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapMondayState(item: MondayItem): Issue["state"] {
  // Check item state
  if (item.state === "archived" || item.state === "deleted") {
    return "closed";
  }

  // Check status column if present
  const statusColumn = item.column_values?.find(
    (c) => c.type === "status" || c.id === "status",
  );
  if (statusColumn?.text) {
    const status = statusColumn.text.toLowerCase();
    if (
      status.includes("done") ||
      status.includes("complete") ||
      status.includes("closed")
    ) {
      return "closed";
    }
    if (
      status.includes("progress") ||
      status.includes("working") ||
      status.includes("active")
    ) {
      return "in_progress";
    }
  }

  return "open";
}

function getDescription(item: MondayItem): string {
  // Check for a long text / description column
  const descColumn = item.column_values?.find(
    (c) =>
      c.type === "long_text" ||
      c.id === "long_text" ||
      c.title?.toLowerCase().includes("description") ||
      c.title?.toLowerCase().includes("notes"),
  );
  if (descColumn?.text) return descColumn.text;

  // Fallback to first update body
  if (item.updates && item.updates.length > 0) {
    return item.updates[0].text_body ?? "";
  }

  return "";
}

function getAssignee(item: MondayItem): string | undefined {
  // Check people column
  const peopleColumn = item.column_values?.find(
    (c) => c.type === "people" || c.id === "person" || c.id === "people",
  );
  if (peopleColumn?.text) return peopleColumn.text;

  // Check subscribers
  return item.subscribers?.[0]?.name;
}

function getLabels(item: MondayItem): string[] {
  const labels: string[] = [];

  // Group title can serve as a label
  if (item.group?.title) {
    labels.push(item.group.title);
  }

  // Check tags column
  const tagsColumn = item.column_values?.find(
    (c) => c.type === "tags" || c.id === "tags",
  );
  if (tagsColumn?.text) {
    labels.push(...tagsColumn.text.split(",").map((t) => t.trim()).filter(Boolean));
  }

  return labels;
}

function getPriority(item: MondayItem): number | undefined {
  const priorityColumn = item.column_values?.find(
    (c) =>
      c.id === "priority" ||
      c.title?.toLowerCase() === "priority",
  );
  if (!priorityColumn?.text) return undefined;

  const text = priorityColumn.text.toLowerCase();
  if (text.includes("critical") || text.includes("urgent")) return 1;
  if (text.includes("high")) return 2;
  if (text.includes("medium") || text.includes("normal")) return 3;
  if (text.includes("low")) return 4;
  return undefined;
}

function getItemUrl(boardId: string, itemId: string): string {
  return `https://monday.com/boards/${boardId}/pulses/${itemId}`;
}

function toMondayIssue(item: MondayItem, boardId: string): Issue {
  return {
    id: item.id,
    title: item.name,
    description: getDescription(item),
    url: getItemUrl(boardId, item.id),
    state: mapMondayState(item),
    labels: getLabels(item),
    assignee: getAssignee(item),
    priority: getPriority(item),
  };
}

// ---------------------------------------------------------------------------
// Item fields fragment
// ---------------------------------------------------------------------------

const ITEM_FIELDS = `
  id
  name
  state
  column_values {
    id
    title
    text
    value
    type
  }
  group {
    id
    title
  }
  subscribers {
    id
    name
  }
  updates(limit: 1) {
    id
    text_body
    body
  }
`;

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createMondayTracker(): Tracker {
  return {
    name: "monday",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const boardId = getBoardId(project);
      const data = await mondayQuery<{ items: MondayItem[] }>(
        `query($ids: [ID!]) {
          items(ids: $ids) {
            ${ITEM_FIELDS}
          }
        }`,
        { ids: [identifier] },
      );

      if (!data.items || data.items.length === 0) {
        throw new Error(`Monday.com issue ${identifier} not found`);
      }

      return toMondayIssue(data.items[0], boardId);
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const issue = await this.getIssue(identifier, project);
      return issue.state === "closed";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const boardId = getBoardId(project);
      return getItemUrl(boardId, identifier);
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract item ID from URL like https://monday.com/boards/{boardId}/pulses/{itemId}
      const match = url.match(/\/pulses\/(\d+)/);
      if (match) return `#${match[1]}`;
      const parts = url.split("/");
      return parts[parts.length - 1] || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/monday-${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Monday.com item #${issue.id}: ${issue.title}`,
        `Item URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.priority !== undefined) {
        const priorityNames: Record<number, string> = {
          1: "Critical/Urgent",
          2: "High",
          3: "Medium",
          4: "Low",
        };
        lines.push(`Priority: ${priorityNames[issue.priority] ?? String(issue.priority)}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this item. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const boardId = getBoardId(project);
      const limit = filters.limit ?? 30;

      // Monday.com uses board items; use items_page for pagination
      const data = await mondayQuery<{
        boards: Array<{
          items_page: {
            items: MondayItem[];
          };
        }>;
      }>(
        `query($boardId: [ID!], $limit: Int!) {
          boards(ids: $boardId) {
            items_page(limit: $limit) {
              items {
                ${ITEM_FIELDS}
              }
            }
          }
        }`,
        { boardId: [boardId], limit: Math.min(limit * 2, 100) },
      );

      if (!data.boards || data.boards.length === 0) {
        return [];
      }

      let items = data.boards[0].items_page?.items ?? [];

      // Apply state filter
      if (filters.state === "closed") {
        items = items.filter((item) => {
          const issue = toMondayIssue(item, boardId);
          return issue.state === "closed";
        });
      } else if (filters.state === "open") {
        items = items.filter((item) => {
          const issue = toMondayIssue(item, boardId);
          return issue.state !== "closed";
        });
      }

      // Apply assignee filter
      if (filters.assignee) {
        items = items.filter((item) => {
          const assignee = getAssignee(item);
          return assignee?.toLowerCase().includes(filters.assignee!.toLowerCase());
        });
      }

      // Apply label filter
      if (filters.labels && filters.labels.length > 0) {
        const labelSet = new Set(filters.labels.map((l) => l.toLowerCase()));
        items = items.filter((item) => {
          const labels = getLabels(item);
          return labels.some((l) => labelSet.has(l.toLowerCase()));
        });
      }

      return items.slice(0, limit).map((item) => toMondayIssue(item, boardId));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const boardId = getBoardId(project);

      // Handle state change via status column
      if (update.state) {
        // First, find the status column and its settings
        const boardData = await mondayQuery<{
          boards: Array<{
            columns: Array<{
              id: string;
              type: string;
              settings_str: string;
            }>;
          }>;
        }>(
          `query($boardId: [ID!]) {
            boards(ids: $boardId) {
              columns {
                id
                type
                settings_str
              }
            }
          }`,
          { boardId: [boardId] },
        );

        const statusColumn = boardData.boards?.[0]?.columns?.find(
          (c) => c.type === "status" || c.id === "status",
        );

        if (statusColumn) {
          // Parse status settings to find label index for target state
          let settings: { labels?: Record<string, string> } = {};
          try {
            settings = JSON.parse(statusColumn.settings_str) as typeof settings;
          } catch {
            // Ignore parse errors
          }

          let targetIndex: string | undefined;
          const labels = settings.labels ?? {};

          for (const [index, label] of Object.entries(labels)) {
            const labelLower = label.toLowerCase();
            if (
              update.state === "closed" &&
              (labelLower.includes("done") || labelLower.includes("complete"))
            ) {
              targetIndex = index;
              break;
            }
            if (
              update.state === "in_progress" &&
              (labelLower.includes("progress") || labelLower.includes("working"))
            ) {
              targetIndex = index;
              break;
            }
            if (
              update.state === "open" &&
              (labelLower.includes("open") ||
                labelLower.includes("todo") ||
                labelLower.includes("to do") ||
                labelLower.includes("new"))
            ) {
              targetIndex = index;
              break;
            }
          }

          if (targetIndex !== undefined) {
            await mondayQuery(
              `mutation($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
                change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
                  id
                }
              }`,
              {
                boardId,
                itemId: identifier,
                columnId: statusColumn.id,
                value: JSON.stringify({ index: Number(targetIndex) }),
              },
            );
          }
        }
      }

      // Handle assignee
      if (update.assignee) {
        // Find the people column
        const boardData = await mondayQuery<{
          boards: Array<{
            columns: Array<{ id: string; type: string }>;
          }>;
        }>(
          `query($boardId: [ID!]) {
            boards(ids: $boardId) {
              columns { id type }
            }
          }`,
          { boardId: [boardId] },
        );

        const peopleColumn = boardData.boards?.[0]?.columns?.find(
          (c) => c.type === "people" || c.id === "person" || c.id === "people",
        );

        if (peopleColumn) {
          await mondayQuery(
            `mutation($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
              change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
                id
              }
            }`,
            {
              boardId,
              itemId: identifier,
              columnId: peopleColumn.id,
              value: JSON.stringify({
                personsAndTeams: [{ id: Number(update.assignee), kind: "person" }],
              }),
            },
          );
        }
      }

      // Handle comment (Monday uses "updates" for comments)
      if (update.comment) {
        await mondayQuery(
          `mutation($itemId: ID!, $body: String!) {
            create_update(item_id: $itemId, body: $body) {
              id
            }
          }`,
          { itemId: identifier, body: update.comment },
        );
      }

      // Handle labels (archive item state for "closed" is already handled above)
      // Monday.com doesn't have a direct "labels" concept beyond tags columns
      // Labels would need to be mapped to a specific tags/dropdown column per board
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const boardId = getBoardId(project);

      // Build column_values for the new item
      const columnValues: Record<string, unknown> = {};

      if (input.description) {
        // Attempt to set a long text column named "description" or "notes"
        const boardData = await mondayQuery<{
          boards: Array<{
            columns: Array<{ id: string; type: string; title: string }>;
          }>;
        }>(
          `query($boardId: [ID!]) {
            boards(ids: $boardId) {
              columns { id type title }
            }
          }`,
          { boardId: [boardId] },
        );

        const longTextColumn = boardData.boards?.[0]?.columns?.find(
          (c) =>
            c.type === "long_text" ||
            c.title.toLowerCase().includes("description") ||
            c.title.toLowerCase().includes("notes"),
        );

        if (longTextColumn) {
          columnValues[longTextColumn.id] = { text: input.description };
        }
      }

      if (input.assignee) {
        // Find people column and set assignee
        const boardData = await mondayQuery<{
          boards: Array<{
            columns: Array<{ id: string; type: string }>;
          }>;
        }>(
          `query($boardId: [ID!]) {
            boards(ids: $boardId) {
              columns { id type }
            }
          }`,
          { boardId: [boardId] },
        );

        const peopleColumn = boardData.boards?.[0]?.columns?.find(
          (c) => c.type === "people" || c.id === "person" || c.id === "people",
        );

        if (peopleColumn) {
          columnValues[peopleColumn.id] = {
            personsAndTeams: [{ id: Number(input.assignee), kind: "person" }],
          };
        }
      }

      const columnValuesStr =
        Object.keys(columnValues).length > 0
          ? JSON.stringify(columnValues)
          : "{}";

      const data = await mondayQuery<{
        create_item: MondayItem;
      }>(
        `mutation($boardId: ID!, $itemName: String!, $columnValues: JSON) {
          create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
            ${ITEM_FIELDS}
          }
        }`,
        {
          boardId,
          itemName: input.title,
          columnValues: columnValuesStr,
        },
      );

      const item = data.create_item;

      // Add description as an update (comment) if no long text column was found
      if (input.description && Object.keys(columnValues).length === 0) {
        try {
          await mondayQuery(
            `mutation($itemId: ID!, $body: String!) {
              create_update(item_id: $itemId, body: $body) {
                id
              }
            }`,
            { itemId: item.id, body: input.description },
          );
        } catch {
          // Best effort
        }
      }

      return toMondayIssue(item, boardId);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "monday",
  slot: "tracker" as const,
  description: "Tracker plugin: Monday.com",
  version: "0.1.0",
};

export function create(): Tracker {
  return createMondayTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
