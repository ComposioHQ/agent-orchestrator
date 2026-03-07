import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

import pluginDefault, { create, manifest } from "./index.js";
import type { ProjectConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectConfig = {
  name: "test",
  repo: "acme/repo",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: {
    plugin: "shortcut",
    projectId: "12345",
  },
};

const projectNoId: ProjectConfig = {
  ...project,
  tracker: { plugin: "shortcut" },
};

const sampleStory = {
  id: 67890,
  name: "Fix login bug",
  description: "Users can't log in with SSO",
  app_url: "https://app.shortcut.com/acme/story/67890/fix-login-bug",
  story_type: "feature",
  workflow_state_id: 500,
  labels: [{ name: "bug" }, { name: "high-priority" }],
  owner_ids: ["user-1"],
  owners: [{ profile: { mention_name: "alice" } }],
  estimate: 3,
  completed: false,
  started: true,
  archived: false,
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockFetchOk(data: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status,
    text: () => Promise.resolve(status === 204 ? "" : JSON.stringify(data)),
  });
}

function mockFetchError(status: number, body = "Error") {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-shortcut plugin", () => {
  let tracker: ReturnType<typeof create>;
  let savedToken: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);

    savedToken = process.env["SHORTCUT_API_TOKEN"];
    process.env["SHORTCUT_API_TOKEN"] = "sc-test-token";

    tracker = create();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedToken === undefined) {
      delete process.env["SHORTCUT_API_TOKEN"];
    } else {
      process.env["SHORTCUT_API_TOKEN"] = savedToken;
    }
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("shortcut");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
      expect(manifest.description).toBe("Tracker plugin: Shortcut");
    });
  });

  // ---- default export ----------------------------------------------------

  describe("default export", () => {
    it("is a valid PluginModule", () => {
      expect(pluginDefault).toHaveProperty("manifest");
      expect(pluginDefault).toHaveProperty("create");
      expect(pluginDefault.manifest.name).toBe("shortcut");
      expect(pluginDefault.manifest.slot).toBe("tracker");
      expect(typeof pluginDefault.create).toBe("function");
    });
  });

  // ---- create() ----------------------------------------------------------

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("shortcut");
    });

    it("returns an object with all Tracker methods", () => {
      expect(typeof tracker.getIssue).toBe("function");
      expect(typeof tracker.isCompleted).toBe("function");
      expect(typeof tracker.issueUrl).toBe("function");
      expect(typeof tracker.issueLabel).toBe("function");
      expect(typeof tracker.branchName).toBe("function");
      expect(typeof tracker.generatePrompt).toBe("function");
      expect(typeof tracker.listIssues).toBe("function");
      expect(typeof tracker.updateIssue).toBe("function");
      expect(typeof tracker.createIssue).toBe("function");
    });
  });

  // ---- getIssue ----------------------------------------------------------

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockFetchOk(sampleStory);
      const issue = await tracker.getIssue("67890", project);
      expect(issue).toEqual({
        id: "67890",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://app.shortcut.com/acme/story/67890/fix-login-bug",
        state: "in_progress",
        labels: ["bug", "high-priority"],
        assignee: "alice",
      });
    });

    it("calls correct Shortcut API endpoint", async () => {
      mockFetchOk(sampleStory);
      await tracker.getIssue("67890", project);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.app.shortcut.com/api/v3/stories/67890",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("sends Shortcut-Token header", async () => {
      mockFetchOk(sampleStory);
      await tracker.getIssue("67890", project);
      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers["Shortcut-Token"]).toBe("sc-test-token");
    });

    it("maps completed story to closed", async () => {
      mockFetchOk({ ...sampleStory, completed: true, started: true });
      const issue = await tracker.getIssue("67890", project);
      expect(issue.state).toBe("closed");
    });

    it("maps archived story to closed", async () => {
      mockFetchOk({ ...sampleStory, archived: true });
      const issue = await tracker.getIssue("67890", project);
      expect(issue.state).toBe("closed");
    });

    it("maps started story to in_progress", async () => {
      mockFetchOk({ ...sampleStory, started: true, completed: false });
      const issue = await tracker.getIssue("67890", project);
      expect(issue.state).toBe("in_progress");
    });

    it("maps unstarted story to open", async () => {
      mockFetchOk({ ...sampleStory, started: false, completed: false });
      const issue = await tracker.getIssue("67890", project);
      expect(issue.state).toBe("open");
    });

    it("handles null description", async () => {
      mockFetchOk({ ...sampleStory, description: null });
      const issue = await tracker.getIssue("67890", project);
      expect(issue.description).toBe("");
    });

    it("handles empty owners", async () => {
      mockFetchOk({ ...sampleStory, owners: [] });
      const issue = await tracker.getIssue("67890", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("handles empty labels", async () => {
      mockFetchOk({ ...sampleStory, labels: [] });
      const issue = await tracker.getIssue("67890", project);
      expect(issue.labels).toEqual([]);
    });

    it("throws on API error", async () => {
      mockFetchError(404, "Story not found");
      await expect(tracker.getIssue("99999", project)).rejects.toThrow(
        "Shortcut API GET /stories/99999 returned 404",
      );
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true when story is completed", async () => {
      mockFetchOk({ ...sampleStory, completed: true });
      expect(await tracker.isCompleted("67890", project)).toBe(true);
    });

    it("returns true when story is archived", async () => {
      mockFetchOk({ ...sampleStory, archived: true, completed: false });
      expect(await tracker.isCompleted("67890", project)).toBe(true);
    });

    it("returns false when story is started but not completed", async () => {
      mockFetchOk({ ...sampleStory, completed: false, archived: false });
      expect(await tracker.isCompleted("67890", project)).toBe(false);
    });

    it("returns false when story is unstarted", async () => {
      mockFetchOk({ ...sampleStory, started: false, completed: false, archived: false });
      expect(await tracker.isCompleted("67890", project)).toBe(false);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("67890", project)).toBe(
        "https://app.shortcut.com/story/67890",
      );
    });
  });

  // ---- issueLabel --------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts story ID from Shortcut URL", () => {
      expect(
        tracker.issueLabel(
          "https://app.shortcut.com/acme/story/67890/fix-login-bug",
          project,
        ),
      ).toBe("sc-67890");
    });

    it("extracts story ID from simple URL", () => {
      expect(
        tracker.issueLabel("https://app.shortcut.com/story/12345", project),
      ).toBe("sc-12345");
    });

    it("falls back to last path segment for non-standard URLs", () => {
      expect(
        tracker.issueLabel("https://example.com/stories/99999", project),
      ).toBe("99999");
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("generates feat/sc-N format", () => {
      expect(tracker.branchName("67890", project)).toBe("feat/sc-67890");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title, URL, and description", async () => {
      mockFetchOk(sampleStory);
      const prompt = await tracker.generatePrompt("67890", project);
      expect(prompt).toContain("#67890");
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("https://app.shortcut.com/acme/story/67890/fix-login-bug");
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("includes labels when present", async () => {
      mockFetchOk(sampleStory);
      const prompt = await tracker.generatePrompt("67890", project);
      expect(prompt).toContain("bug, high-priority");
    });

    it("omits labels when empty", async () => {
      mockFetchOk({ ...sampleStory, labels: [] });
      const prompt = await tracker.generatePrompt("67890", project);
      expect(prompt).not.toContain("Labels:");
    });

    it("omits description when empty", async () => {
      mockFetchOk({ ...sampleStory, description: "" });
      const prompt = await tracker.generatePrompt("67890", project);
      expect(prompt).not.toContain("## Description");
    });

    it("includes implementation instruction", async () => {
      mockFetchOk(sampleStory);
      const prompt = await tracker.generatePrompt("67890", project);
      expect(prompt).toContain("Please implement the changes");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      mockFetchOk({
        data: [
          sampleStory,
          { ...sampleStory, id: 67891, name: "Another" },
        ],
      });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("67890");
      expect(issues[1].id).toBe("67891");
    });

    it("passes state filter for closed", async () => {
      mockFetchOk({ data: [] });
      await tracker.listIssues!({ state: "closed" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.query).toContain("is:done");
    });

    it("passes state filter for open", async () => {
      mockFetchOk({ data: [] });
      await tracker.listIssues!({ state: "open" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.query).toContain("!is:done");
      expect(body.query).toContain("!is:archived");
    });

    it("passes label filters", async () => {
      mockFetchOk({ data: [] });
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.query).toContain('label:"bug"');
      expect(body.query).toContain('label:"urgent"');
    });

    it("passes assignee/owner filter", async () => {
      mockFetchOk({ data: [] });
      await tracker.listIssues!({ assignee: "alice" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.query).toContain("owner:alice");
    });

    it("respects custom limit via page_size", async () => {
      mockFetchOk({ data: [] });
      await tracker.listIssues!({ limit: 5 }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.page_size).toBe(5);
    });

    it("defaults page_size to 30", async () => {
      mockFetchOk({ data: [] });
      await tracker.listIssues!({}, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.page_size).toBe(30);
    });

    it("uses POST method for search", async () => {
      mockFetchOk({ data: [] });
      await tracker.listIssues!({}, project);
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("handles null data in response", async () => {
      mockFetchOk({ data: null });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toEqual([]);
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    it("changes state to closed by finding workflow state", async () => {
      // 1: fetch workflows
      mockFetchOk([
        {
          states: [
            { id: 1, name: "Unstarted", type: "unstarted" },
            { id: 2, name: "Started", type: "started" },
            { id: 3, name: "Done", type: "done" },
          ],
        },
      ]);
      // 2: update story
      mockFetchOk({});

      await tracker.updateIssue!("67890", { state: "closed" }, project);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.workflow_state_id).toBe(3);
    });

    it("changes state to in_progress", async () => {
      mockFetchOk([
        {
          states: [
            { id: 1, name: "Unstarted", type: "unstarted" },
            { id: 2, name: "Started", type: "started" },
            { id: 3, name: "Done", type: "done" },
          ],
        },
      ]);
      mockFetchOk({});

      await tracker.updateIssue!("67890", { state: "in_progress" }, project);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.workflow_state_id).toBe(2);
    });

    it("changes state to open (unstarted)", async () => {
      mockFetchOk([
        {
          states: [
            { id: 1, name: "Unstarted", type: "unstarted" },
            { id: 2, name: "Started", type: "started" },
            { id: 3, name: "Done", type: "done" },
          ],
        },
      ]);
      mockFetchOk({});

      await tracker.updateIssue!("67890", { state: "open" }, project);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.workflow_state_id).toBe(1);
    });

    it("adds labels (deduplicates with existing)", async () => {
      // 1: fetch current story to get existing labels
      mockFetchOk({ ...sampleStory, labels: [{ name: "bug" }] });
      // 2: update story
      mockFetchOk({});

      await tracker.updateIssue!("67890", { labels: ["bug", "urgent"] }, project);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      const labelNames = body.labels.map((l: { name: string }) => l.name);
      expect(labelNames).toContain("bug");
      expect(labelNames).toContain("urgent");
      // "bug" should appear only once (deduplicated)
      expect(labelNames.filter((n: string) => n === "bug")).toHaveLength(1);
    });

    it("updates assignee by finding member", async () => {
      // 1: fetch members
      mockFetchOk([
        { id: "user-1", profile: { mention_name: "alice", name: "Alice Smith" } },
        { id: "user-2", profile: { mention_name: "bob", name: "Bob Jones" } },
      ]);
      // 2: update story
      mockFetchOk({});

      await tracker.updateIssue!("67890", { assignee: "bob" }, project);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.owner_ids).toEqual(["user-2"]);
    });

    it("adds a comment", async () => {
      mockFetchOk({});
      await tracker.updateIssue!("67890", { comment: "Working on this" }, project);

      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/stories/67890/comments");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toBe("Working on this");
    });

    it("skips PUT when no fields to update (comment only)", async () => {
      // Only comment, no state/labels/assignee
      mockFetchOk({});
      await tracker.updateIssue!("67890", { comment: "Just a note" }, project);

      // Should have one call for the comment only
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/comments");
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates a story and returns mapped issue", async () => {
      mockFetchOk(sampleStory);
      const issue = await tracker.createIssue!(
        { title: "Fix login bug", description: "Users can't log in" },
        project,
      );
      expect(issue).toMatchObject({
        id: "67890",
        title: "Fix login bug",
        state: "in_progress",
      });
    });

    it("sends correct fields in create request", async () => {
      mockFetchOk(sampleStory);
      await tracker.createIssue!(
        { title: "New story", description: "Description" },
        project,
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.name).toBe("New story");
      expect(body.description).toBe("Description");
      expect(body.story_type).toBe("feature");
    });

    it("passes projectId when configured", async () => {
      mockFetchOk(sampleStory);
      await tracker.createIssue!(
        { title: "New story", description: "" },
        project,
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.project_id).toBe(12345);
    });

    it("omits projectId when not configured", async () => {
      mockFetchOk(sampleStory);
      await tracker.createIssue!(
        { title: "New story", description: "" },
        projectNoId,
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.project_id).toBeUndefined();
    });

    it("passes labels to create request", async () => {
      mockFetchOk(sampleStory);
      await tracker.createIssue!(
        { title: "Bug", description: "", labels: ["bug", "urgent"] },
        project,
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.labels).toEqual([{ name: "bug" }, { name: "urgent" }]);
    });

    it("resolves assignee from members", async () => {
      // 1: fetch members
      mockFetchOk([
        { id: "user-1", profile: { mention_name: "alice", name: "Alice Smith" } },
      ]);
      // 2: create story
      mockFetchOk(sampleStory);

      await tracker.createIssue!(
        { title: "Bug", description: "", assignee: "alice" },
        project,
      );

      const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(createBody.owner_ids).toEqual(["user-1"]);
    });
  });

  // ---- Error handling ----------------------------------------------------

  describe("error handling", () => {
    it("throws when SHORTCUT_API_TOKEN is missing", async () => {
      delete process.env["SHORTCUT_API_TOKEN"];
      await expect(tracker.getIssue("67890", project)).rejects.toThrow(
        "SHORTCUT_API_TOKEN environment variable is required",
      );
    });

    it("throws on HTTP error status", async () => {
      mockFetchError(401, "Unauthorized");
      await expect(tracker.getIssue("67890", project)).rejects.toThrow(
        "returned 401",
      );
    });

    it("throws on invalid JSON response", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("not json{"),
      });
      await expect(tracker.getIssue("67890", project)).rejects.toThrow(
        "invalid JSON",
      );
    });
  });
});
