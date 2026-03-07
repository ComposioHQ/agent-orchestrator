/**
 * tracker-trello plugin — Trello boards and cards as an issue tracker.
 *
 * Uses the Trello REST API v1 via fetch().
 * Auth: TRELLO_API_KEY + TRELLO_TOKEN env vars (passed as query params).
 * Requires TRELLO_BOARD_ID env var or tracker.boardId in project config.
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
// Constants
// ---------------------------------------------------------------------------

const TRELLO_BASE_URL = "https://api.trello.com/1";
const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const key = process.env["TRELLO_API_KEY"];
  if (!key) {
    throw new Error(
      "TRELLO_API_KEY environment variable is required for the Trello tracker plugin",
    );
  }
  return key;
}

function getToken(): string {
  const token = process.env["TRELLO_TOKEN"];
  if (!token) {
    throw new Error(
      "TRELLO_TOKEN environment variable is required for the Trello tracker plugin",
    );
  }
  return token;
}

function getBoardId(project: ProjectConfig): string {
  const fromConfig = project.tracker?.["boardId"] as string | undefined;
  const fromEnv = process.env["TRELLO_BOARD_ID"];
  const boardId = fromConfig ?? fromEnv;
  if (!boardId) {
    throw new Error(
      "Trello board ID is required: set TRELLO_BOARD_ID env var or tracker.boardId in project config",
    );
  }
  return boardId;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function trelloFetch<T>(
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<T> {
  const url = new URL(`${TRELLO_BASE_URL}${path}`);
  url.searchParams.set("key", getApiKey());
  url.searchParams.set("token", getToken());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const fetchOptions: RequestInit = {
      method: options.method ?? "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    };

    if (options.body) {
      fetchOptions.headers = {
        ...fetchOptions.headers,
        "Content-Type": "application/json",
      };
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), fetchOptions);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Trello API returned HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    const data: unknown = await response.json();
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Trello API types
// ---------------------------------------------------------------------------

interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  url: string;
  shortUrl: string;
  idList: string;
  idLabels: string[];
  labels: Array<{ id: string; name: string; color: string }>;
  idMembers: string[];
  closed: boolean;
}

interface TrelloList {
  id: string;
  name: string;
  closed: boolean;
}

interface TrelloMember {
  id: string;
  username: string;
  fullName: string;
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

/** Well-known list names that map to issue states */
const CLOSED_LIST_NAMES = new Set(["done", "closed", "complete", "completed", "archived"]);
const IN_PROGRESS_LIST_NAMES = new Set([
  "in progress",
  "doing",
  "in review",
  "review",
  "testing",
  "in development",
]);

function mapCardState(
  card: TrelloCard,
  listName: string,
): Issue["state"] {
  if (card.closed) return "closed";
  const lower = listName.toLowerCase();
  if (CLOSED_LIST_NAMES.has(lower)) return "closed";
  if (IN_PROGRESS_LIST_NAMES.has(lower)) return "in_progress";
  return "open";
}

// ---------------------------------------------------------------------------
// Board list cache (avoids re-fetching on every call)
// ---------------------------------------------------------------------------

let cachedBoardId: string | null = null;
let cachedLists: TrelloList[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

async function getBoardLists(boardId: string): Promise<TrelloList[]> {
  const now = Date.now();
  if (cachedBoardId === boardId && cachedLists && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedLists;
  }
  cachedLists = await trelloFetch<TrelloList[]>(`/boards/${boardId}/lists`);
  cachedBoardId = boardId;
  cacheTimestamp = now;
  return cachedLists;
}

async function getListName(boardId: string, listId: string): Promise<string> {
  const lists = await getBoardLists(boardId);
  const list = lists.find((l) => l.id === listId);
  return list?.name ?? "Unknown";
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createTrelloTracker(): Tracker {
  return {
    name: "trello",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const boardId = getBoardId(project);
      const card = await trelloFetch<TrelloCard>(
        `/cards/${identifier}?fields=id,name,desc,url,shortUrl,idList,idLabels,idMembers,closed&members=true&member_fields=username,fullName`,
      );

      const listName = await getListName(boardId, card.idList);
      const members = await trelloFetch<TrelloMember[]>(`/cards/${identifier}/members`);

      return {
        id: card.id,
        title: card.name,
        description: card.desc,
        url: card.url,
        state: mapCardState(card, listName),
        labels: card.labels.map((l) => l.name),
        assignee: members[0]?.username,
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const boardId = getBoardId(project);
      const card = await trelloFetch<TrelloCard>(
        `/cards/${identifier}?fields=id,closed,idList`,
      );
      if (card.closed) return true;
      const listName = await getListName(boardId, card.idList);
      return CLOSED_LIST_NAMES.has(listName.toLowerCase());
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      return `https://trello.com/c/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract card short ID from Trello URL
      // Example: https://trello.com/c/AbCdEfGh/42-card-title -> AbCdEfGh
      const match = url.match(/\/c\/([a-zA-Z0-9]+)/);
      return match ? match[1] : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      // Use a short prefix + card ID
      return `feat/trello-${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Trello card: ${issue.title}`,
        `Card URL: ${issue.url}`,
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
        "Please implement the changes described in this card. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const boardId = getBoardId(project);
      const lists = await getBoardLists(boardId);

      // Build list filter based on state
      let targetListIds: string[] | undefined;
      if (filters.state === "closed") {
        targetListIds = lists
          .filter((l) => CLOSED_LIST_NAMES.has(l.name.toLowerCase()))
          .map((l) => l.id);
      } else if (filters.state === "open") {
        targetListIds = lists
          .filter((l) => !CLOSED_LIST_NAMES.has(l.name.toLowerCase()))
          .map((l) => l.id);
      }
      // "all" = no filter

      // Fetch cards from the board
      const cards = await trelloFetch<TrelloCard[]>(
        `/boards/${boardId}/cards?fields=id,name,desc,url,shortUrl,idList,idLabels,idMembers,closed&members=true&member_fields=username,fullName`,
      );

      let filtered = cards;

      // Filter by list (state)
      if (targetListIds) {
        const listIdSet = new Set(targetListIds);
        filtered = filtered.filter((c) => listIdSet.has(c.idList));
      }

      // Filter by labels
      if (filters.labels && filters.labels.length > 0) {
        const labelSet = new Set(filters.labels.map((l) => l.toLowerCase()));
        filtered = filtered.filter((c) =>
          c.labels.some((l) => labelSet.has(l.name.toLowerCase())),
        );
      }

      // Filter by assignee
      if (filters.assignee) {
        const memberCards = await trelloFetch<TrelloCard[]>(
          `/boards/${boardId}/members/${filters.assignee}/cards`,
        ).catch(() => [] as TrelloCard[]);
        const memberCardIds = new Set(memberCards.map((c) => c.id));
        filtered = filtered.filter((c) => memberCardIds.has(c.id));
      }

      // Apply limit
      const limit = filters.limit ?? 30;
      filtered = filtered.slice(0, limit);

      // Build list name lookup
      const listMap = new Map(lists.map((l) => [l.id, l.name]));

      return filtered.map((card) => {
        const listName = listMap.get(card.idList) ?? "Unknown";
        return {
          id: card.id,
          title: card.name,
          description: card.desc,
          url: card.url,
          state: mapCardState(card, listName),
          labels: card.labels.map((l) => l.name),
        };
      });
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const boardId = getBoardId(project);

      // Handle state change by moving to appropriate list
      if (update.state) {
        const lists = await getBoardLists(boardId);
        let targetList: TrelloList | undefined;

        if (update.state === "closed") {
          targetList = lists.find((l) => CLOSED_LIST_NAMES.has(l.name.toLowerCase()));
        } else if (update.state === "in_progress") {
          targetList = lists.find((l) => IN_PROGRESS_LIST_NAMES.has(l.name.toLowerCase()));
        } else {
          // "open" — move to first non-closed, non-in-progress list
          targetList = lists.find(
            (l) =>
              !CLOSED_LIST_NAMES.has(l.name.toLowerCase()) &&
              !IN_PROGRESS_LIST_NAMES.has(l.name.toLowerCase()),
          );
        }

        if (targetList) {
          await trelloFetch(`/cards/${identifier}`, {
            method: "PUT",
            body: { idList: targetList.id },
          });
        }

        // Also handle closed flag for "closed" state
        if (update.state === "closed") {
          await trelloFetch(`/cards/${identifier}`, {
            method: "PUT",
            body: { closed: true },
          });
        } else {
          // Reopen if moving to open/in_progress
          await trelloFetch(`/cards/${identifier}`, {
            method: "PUT",
            body: { closed: false },
          });
        }
      }

      // Handle labels (additive)
      if (update.labels && update.labels.length > 0) {
        // Get board labels
        const boardLabels = await trelloFetch<Array<{ id: string; name: string }>>(
          `/boards/${boardId}/labels`,
        );
        const labelMap = new Map(boardLabels.map((l) => [l.name.toLowerCase(), l.id]));

        for (const labelName of update.labels) {
          const labelId = labelMap.get(labelName.toLowerCase());
          if (labelId) {
            await trelloFetch(`/cards/${identifier}/idLabels`, {
              method: "POST",
              body: { value: labelId },
            });
          }
        }
      }

      // Handle comment
      if (update.comment) {
        await trelloFetch(`/cards/${identifier}/actions/comments`, {
          method: "POST",
          body: { text: update.comment },
        });
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const boardId = getBoardId(project);
      const lists = await getBoardLists(boardId);

      // Put new cards in the first non-closed list
      const targetList = lists.find(
        (l) => !l.closed && !CLOSED_LIST_NAMES.has(l.name.toLowerCase()),
      );
      if (!targetList) {
        throw new Error("No open list found on the Trello board to create a card");
      }

      const body: Record<string, unknown> = {
        name: input.title,
        desc: input.description ?? "",
        idList: targetList.id,
      };

      // Resolve labels
      if (input.labels && input.labels.length > 0) {
        const boardLabels = await trelloFetch<Array<{ id: string; name: string }>>(
          `/boards/${boardId}/labels`,
        );
        const labelMap = new Map(boardLabels.map((l) => [l.name.toLowerCase(), l.id]));
        const labelIds = input.labels
          .map((name) => labelMap.get(name.toLowerCase()))
          .filter((id): id is string => id !== undefined);
        if (labelIds.length > 0) {
          body["idLabels"] = labelIds.join(",");
        }
      }

      // Resolve assignee (member username)
      if (input.assignee) {
        try {
          const members = await trelloFetch<TrelloMember[]>(`/boards/${boardId}/members`);
          const member = members.find(
            (m) => m.username === input.assignee || m.fullName === input.assignee,
          );
          if (member) {
            body["idMembers"] = member.id;
          }
        } catch {
          // Assignee is best-effort
        }
      }

      const card = await trelloFetch<TrelloCard>("/cards", {
        method: "POST",
        body,
      });

      return {
        id: card.id,
        title: card.name,
        description: card.desc,
        url: card.url,
        state: "open",
        labels: card.labels?.map((l) => l.name) ?? [],
        assignee: input.assignee,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "trello",
  slot: "tracker" as const,
  description: "Tracker plugin: Trello boards and cards",
  version: "0.1.0",
};

export function create(): Tracker {
  return createTrelloTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
