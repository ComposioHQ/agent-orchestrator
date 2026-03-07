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
  tracker: { plugin: "monday", boardId: "board-123" },
};

const sampleItem = {
  id: "item-456",
  name: "Fix login bug",
  state: "active",
  column_values: [
    { id: "status", title: "Status", text: "Working on it", value: null, type: "status" },
    { id: "long_text", title: "Description", text: "Users cannot log in", value: null, type: "long_text" },
  ],
  group: { id: "group1", title: "Sprint 1" },
  subscribers: [{ id: "user1", name: "Alice" }],
  updates: [],
};

function mockFetchOk(data: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ data })),
  });
}

function mockFetchError(status: number, body = "Error") {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
}

describe("tracker-monday plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MONDAY_API_TOKEN", "test-token");
    vi.stubEnv("MONDAY_BOARD_ID", "board-123");
    tracker = create();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("monday");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("default export", () => {
    it("is a valid PluginModule", () => {
      expect(pluginDefault.manifest.name).toBe("monday");
      expect(typeof pluginDefault.create).toBe("function");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("monday");
    });
  });

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockFetchOk({ items: [sampleItem] });
      const issue = await tracker.getIssue("item-456", project);
      expect(issue.id).toBe("item-456");
      expect(issue.title).toBe("Fix login bug");
      expect(issue.description).toBe("Users cannot log in");
      expect(issue.state).toBe("in_progress");
      expect(issue.labels).toContain("Sprint 1");
    });

    it("throws when item not found", async () => {
      mockFetchOk({ items: [] });
      await expect(tracker.getIssue("item-999", project)).rejects.toThrow("not found");
    });

    it("maps archived item to closed", async () => {
      mockFetchOk({ items: [{ ...sampleItem, state: "archived" }] });
      const issue = await tracker.getIssue("item-456", project);
      expect(issue.state).toBe("closed");
    });

    it("maps done status column to closed", async () => {
      mockFetchOk({
        items: [{
          ...sampleItem,
          column_values: [
            { id: "status", title: "Status", text: "Done", value: null, type: "status" },
          ],
        }],
      });
      const issue = await tracker.getIssue("item-456", project);
      expect(issue.state).toBe("closed");
    });
  });

  describe("isCompleted", () => {
    it("returns true when state is closed", async () => {
      mockFetchOk({ items: [{ ...sampleItem, state: "archived" }] });
      expect(await tracker.isCompleted("item-456", project)).toBe(true);
    });

    it("returns false when state is active", async () => {
      mockFetchOk({ items: [sampleItem] });
      expect(await tracker.isCompleted("item-456", project)).toBe(false);
    });
  });

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("item-456", project)).toBe(
        "https://monday.com/boards/board-123/pulses/item-456",
      );
    });
  });

  describe("issueLabel", () => {
    it("extracts item ID from URL", () => {
      expect(
        tracker.issueLabel("https://monday.com/boards/123/pulses/456", project),
      ).toBe("#456");
    });
  });

  describe("branchName", () => {
    it("generates correct branch name", () => {
      expect(tracker.branchName("item-456", project)).toBe("feat/monday-item-456");
    });
  });

  describe("generatePrompt", () => {
    it("includes title and description", async () => {
      mockFetchOk({ items: [sampleItem] });
      const prompt = await tracker.generatePrompt("item-456", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("Users cannot log in");
    });
  });

  describe("listIssues", () => {
    it("returns mapped issues from board", async () => {
      mockFetchOk({
        boards: [{ items_page: { items: [sampleItem] } }],
      });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("item-456");
    });

    it("returns empty array when no boards", async () => {
      mockFetchOk({ boards: [] });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toEqual([]);
    });
  });

  describe("updateIssue", () => {
    it("adds a comment as update", async () => {
      mockFetchOk({ create_update: { id: "1" } });
      await tracker.updateIssue!("item-456", { comment: "Working on it" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.variables.body).toBe("Working on it");
    });
  });

  describe("createIssue", () => {
    it("creates an item on the board", async () => {
      mockFetchOk({ create_item: sampleItem });
      const issue = await tracker.createIssue!(
        { title: "New bug" },
        project,
      );
      expect(issue.id).toBe("item-456");
    });
  });

  describe("error handling", () => {
    it("throws when MONDAY_API_TOKEN is missing", async () => {
      vi.stubEnv("MONDAY_API_TOKEN", "");
      await expect(tracker.getIssue("item-456", project)).rejects.toThrow("MONDAY_API_TOKEN");
    });

    it("throws on GraphQL errors", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({ errors: [{ message: "Something went wrong" }] }),
          ),
      });
      await expect(tracker.getIssue("item-456", project)).rejects.toThrow(
        "Something went wrong",
      );
    });

    it("throws on HTTP error", async () => {
      mockFetchError(500, "Server error");
      await expect(tracker.getIssue("item-456", project)).rejects.toThrow("returned 500");
    });
  });
});
