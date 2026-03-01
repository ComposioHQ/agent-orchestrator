import { describe, it, expect, beforeEach, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

import pluginDefault, { create, manifest } from "./index.js";
import type { ProjectConfig } from "@composio/ao-core";

const project: ProjectConfig = {
  name: "test",
  repo: "acme/app",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: { plugin: "trello", boardId: "board-abc" },
};

const sampleCard = {
  id: "card-123",
  name: "Fix login bug",
  desc: "Users cannot log in with SSO.",
  url: "https://trello.com/c/card-123",
  shortUrl: "https://trello.com/c/card-123",
  idList: "list-todo",
  idLabels: ["lbl-1"],
  labels: [{ id: "lbl-1", name: "bug", color: "red" }],
  idMembers: ["user-1"],
  closed: false,
};

const sampleLists = [
  { id: "list-todo", name: "To Do", closed: false },
  { id: "list-doing", name: "In Progress", closed: false },
  { id: "list-done", name: "Done", closed: false },
];

const sampleMembers = [
  { id: "user-1", username: "alice", fullName: "Alice Smith" },
];

function mockFetchOk(data: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockFetchError(status: number, body = "Error") {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.reject(new Error("not json")),
    text: () => Promise.resolve(body),
  });
}

// The Trello plugin has a module-level board list cache with 60s TTL.
// To ensure each test gets predictable mock consumption, we advance
// Date.now by a large amount before each test so the cache is always expired.
let testTimeOffset = 0;
const realDateNow = Date.now;

describe("tracker-trello plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TRELLO_API_KEY", "test-key");
    vi.stubEnv("TRELLO_TOKEN", "test-token");
    vi.stubEnv("TRELLO_BOARD_ID", "board-abc");

    // Move Date.now far ahead so any cached data from previous tests is expired.
    // Each test gets its own 2-minute window to avoid cross-test cache hits.
    testTimeOffset += 120_000;
    const offset = testTimeOffset;
    vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + offset);

    tracker = create();
  });

  /**
   * Mock the three fetches needed by getIssue:
   * 1. card fetch
   * 2. board lists fetch (via getListName -> getBoardLists)
   * 3. card members fetch
   */
  function mockGetIssueFetches(
    cardOverrides: Record<string, unknown> = {},
    lists = sampleLists,
    members = sampleMembers,
  ) {
    mockFetchOk({ ...sampleCard, ...cardOverrides }); // card
    mockFetchOk(lists); // board lists
    mockFetchOk(members); // card members
  }

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("trello");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("default export", () => {
    it("is a valid PluginModule", () => {
      expect(pluginDefault.manifest.name).toBe("trello");
      expect(typeof pluginDefault.create).toBe("function");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("trello");
    });
  });

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockGetIssueFetches();
      const issue = await tracker.getIssue("card-123", project);
      expect(issue.id).toBe("card-123");
      expect(issue.title).toBe("Fix login bug");
      expect(issue.description).toBe("Users cannot log in with SSO.");
      expect(issue.state).toBe("open");
      expect(issue.labels).toEqual(["bug"]);
      expect(issue.assignee).toBe("alice");
    });

    it("maps card in Done list to closed", async () => {
      mockGetIssueFetches({ idList: "list-done" });
      const issue = await tracker.getIssue("card-123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps card in In Progress list to in_progress", async () => {
      mockGetIssueFetches({ idList: "list-doing" });
      const issue = await tracker.getIssue("card-123", project);
      expect(issue.state).toBe("in_progress");
    });

    it("maps closed card to closed state", async () => {
      mockGetIssueFetches({ closed: true });
      const issue = await tracker.getIssue("card-123", project);
      expect(issue.state).toBe("closed");
    });

    it("throws on API error", async () => {
      mockFetchError(404, "Not found");
      await expect(tracker.getIssue("card-999", project)).rejects.toThrow("404");
    });
  });

  describe("isCompleted", () => {
    it("returns true when card is closed", async () => {
      mockFetchOk({ ...sampleCard, closed: true }); // card
      // isCompleted returns early for closed cards
      expect(await tracker.isCompleted("card-123", project)).toBe(true);
    });

    it("returns true when card is in Done list", async () => {
      mockFetchOk({ ...sampleCard, idList: "list-done", closed: false }); // card
      mockFetchOk(sampleLists); // board lists
      expect(await tracker.isCompleted("card-123", project)).toBe(true);
    });

    it("returns false when card is active in To Do", async () => {
      mockFetchOk({ ...sampleCard, closed: false }); // card
      mockFetchOk(sampleLists); // board lists
      expect(await tracker.isCompleted("card-123", project)).toBe(false);
    });
  });

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("card-123", project)).toBe(
        "https://trello.com/c/card-123",
      );
    });
  });

  describe("issueLabel", () => {
    it("extracts card short ID from URL", () => {
      expect(
        tracker.issueLabel("https://trello.com/c/AbCdEfGh/42-card-title", project),
      ).toBe("AbCdEfGh");
    });

    it("returns full URL when pattern does not match", () => {
      const url = "https://example.com/something";
      expect(tracker.issueLabel(url, project)).toBe(url);
    });
  });

  describe("branchName", () => {
    it("generates correct branch name", () => {
      expect(tracker.branchName("card-123", project)).toBe("feat/trello-card-123");
    });
  });

  describe("generatePrompt", () => {
    it("includes title and description", async () => {
      mockGetIssueFetches();
      const prompt = await tracker.generatePrompt("card-123", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("Users cannot log in with SSO.");
      expect(prompt).toContain("bug");
    });
  });

  describe("listIssues", () => {
    it("returns mapped issues from board", async () => {
      mockFetchOk(sampleLists); // board lists
      mockFetchOk([sampleCard]); // board cards
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("card-123");
      expect(issues[0].title).toBe("Fix login bug");
    });

    it("filters by closed state", async () => {
      mockFetchOk(sampleLists); // board lists
      const closedCard = { ...sampleCard, id: "card-456", idList: "list-done" };
      mockFetchOk([sampleCard, closedCard]); // board cards
      const issues = await tracker.listIssues!({ state: "closed" }, project);
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("card-456");
    });

    it("filters by open state", async () => {
      mockFetchOk(sampleLists); // board lists
      const closedCard = { ...sampleCard, id: "card-456", idList: "list-done" };
      mockFetchOk([sampleCard, closedCard]); // board cards
      const issues = await tracker.listIssues!({ state: "open" }, project);
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("card-123");
    });
  });

  describe("updateIssue", () => {
    it("moves card to closed list and sets closed flag", async () => {
      mockFetchOk(sampleLists); // board lists for state lookup
      mockFetchOk({}); // PUT card idList
      mockFetchOk({}); // PUT card closed=true
      await tracker.updateIssue!("card-123", { state: "closed" }, project);
      const calls = fetchMock.mock.calls;
      // calls[0] = board lists GET
      // calls[1] = PUT card (move to list)
      // calls[2] = PUT card (set closed)
      const moveBody = JSON.parse(calls[1][1].body);
      expect(moveBody.idList).toBe("list-done");
      const closeBody = JSON.parse(calls[2][1].body);
      expect(closeBody.closed).toBe(true);
    });

    it("adds a comment", async () => {
      mockFetchOk({}); // POST comment
      await tracker.updateIssue!("card-123", { comment: "Working on it" }, project);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/actions/comments");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toBe("Working on it");
    });
  });

  describe("createIssue", () => {
    it("creates a card on the board", async () => {
      mockFetchOk(sampleLists); // board lists for target list
      mockFetchOk({ ...sampleCard, name: "New bug" }); // POST card
      const issue = await tracker.createIssue!(
        { title: "New bug", description: "Desc" },
        project,
      );
      expect(issue.id).toBe("card-123");
      expect(issue.title).toBe("New bug");
    });

    it("throws when no open list found", async () => {
      const closedOnlyLists = [
        { id: "list-done", name: "Done", closed: false },
      ];
      mockFetchOk(closedOnlyLists);
      await expect(
        tracker.createIssue!({ title: "New" }, project),
      ).rejects.toThrow("No open list found");
    });
  });

  describe("error handling", () => {
    it("throws when TRELLO_API_KEY is missing", async () => {
      vi.stubEnv("TRELLO_API_KEY", "");
      await expect(tracker.getIssue("card-123", project)).rejects.toThrow(
        "TRELLO_API_KEY",
      );
    });

    it("throws when TRELLO_TOKEN is missing", async () => {
      vi.stubEnv("TRELLO_TOKEN", "");
      await expect(tracker.getIssue("card-123", project)).rejects.toThrow(
        "TRELLO_TOKEN",
      );
    });

    it("throws when board ID is missing", async () => {
      vi.stubEnv("TRELLO_BOARD_ID", "");
      const badProject = {
        ...project,
        tracker: { plugin: "trello" },
      } as ProjectConfig;
      await expect(tracker.getIssue("card-123", badProject)).rejects.toThrow(
        "board ID",
      );
    });
  });
});
