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
    plugin: "clickup",
    listId: "list-123",
  },
};

const projectNoList: ProjectConfig = {
  ...project,
  tracker: { plugin: "clickup" },
};

const sampleTask = {
  id: "abc123",
  custom_id: null as string | null | undefined,
  name: "Fix login bug",
  description: "Full description here",
  text_content: "Users can't log in with SSO",
  status: {
    status: "in progress",
    type: "custom",
  },
  tags: [{ name: "bug" }, { name: "high-priority" }],
  assignees: [{ username: "alice", profilePicture: null }],
  priority: { id: "2", priority: "high" },
  url: "https://app.clickup.com/t/abc123",
  list: { id: "list-123" },
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

function mockFetch204() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 204,
    text: () => Promise.resolve(""),
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

describe("tracker-clickup plugin", () => {
  let tracker: ReturnType<typeof create>;
  let savedToken: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);

    savedToken = process.env["CLICKUP_API_TOKEN"];
    process.env["CLICKUP_API_TOKEN"] = "cu-test-token";

    tracker = create();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedToken === undefined) {
      delete process.env["CLICKUP_API_TOKEN"];
    } else {
      process.env["CLICKUP_API_TOKEN"] = savedToken;
    }
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("clickup");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
      expect(manifest.description).toBe("Tracker plugin: ClickUp");
    });
  });

  // ---- default export ----------------------------------------------------

  describe("default export", () => {
    it("is a valid PluginModule", () => {
      expect(pluginDefault).toHaveProperty("manifest");
      expect(pluginDefault).toHaveProperty("create");
      expect(pluginDefault.manifest.name).toBe("clickup");
      expect(pluginDefault.manifest.slot).toBe("tracker");
      expect(typeof pluginDefault.create).toBe("function");
    });
  });

  // ---- create() ----------------------------------------------------------

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("clickup");
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
      mockFetchOk(sampleTask);
      const issue = await tracker.getIssue("abc123", project);
      expect(issue).toEqual({
        id: "abc123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://app.clickup.com/t/abc123",
        state: "in_progress",
        labels: ["bug", "high-priority"],
        assignee: "alice",
        priority: 2,
      });
    });

    it("calls correct ClickUp API endpoint", async () => {
      mockFetchOk(sampleTask);
      await tracker.getIssue("abc123", project);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.clickup.com/api/v2/task/abc123",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("sends Authorization header with token", async () => {
      mockFetchOk(sampleTask);
      await tracker.getIssue("abc123", project);
      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers["Authorization"]).toBe("cu-test-token");
    });

    it("uses custom_id when present", async () => {
      mockFetchOk({ ...sampleTask, custom_id: "CUSTOM-1" });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.id).toBe("CUSTOM-1");
    });

    it("falls back to id when custom_id is null", async () => {
      mockFetchOk({ ...sampleTask, custom_id: null });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.id).toBe("abc123");
    });

    it("maps 'closed' status type to closed", async () => {
      mockFetchOk({
        ...sampleTask,
        status: { status: "closed", type: "closed" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps 'done' status type to closed", async () => {
      mockFetchOk({
        ...sampleTask,
        status: { status: "done", type: "done" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps 'open' status type to open", async () => {
      mockFetchOk({
        ...sampleTask,
        status: { status: "to do", type: "open" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("open");
    });

    it("maps custom status with 'progress' in name to in_progress", async () => {
      mockFetchOk({
        ...sampleTask,
        status: { status: "in progress", type: "custom" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("in_progress");
    });

    it("maps custom status with 'review' in name to in_progress", async () => {
      mockFetchOk({
        ...sampleTask,
        status: { status: "in review", type: "custom" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("in_progress");
    });

    it("maps custom status with 'done' in name to closed", async () => {
      mockFetchOk({
        ...sampleTask,
        status: { status: "done - verified", type: "custom" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps custom status with 'complete' in name to closed", async () => {
      mockFetchOk({
        ...sampleTask,
        status: { status: "complete", type: "custom" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps unknown custom status to open", async () => {
      mockFetchOk({
        ...sampleTask,
        status: { status: "backlog", type: "custom" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("open");
    });

    it("uses text_content for description, falling back to description", async () => {
      mockFetchOk({ ...sampleTask, text_content: null, description: "Fallback desc" });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.description).toBe("Fallback desc");
    });

    it("handles empty description and text_content", async () => {
      mockFetchOk({ ...sampleTask, text_content: undefined, description: undefined });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.description).toBe("");
    });

    it("handles null assignees", async () => {
      mockFetchOk({ ...sampleTask, assignees: [] });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("handles null priority", async () => {
      mockFetchOk({ ...sampleTask, priority: null });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.priority).toBeUndefined();
    });

    it("handles empty tags", async () => {
      mockFetchOk({ ...sampleTask, tags: [] });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.labels).toEqual([]);
    });

    it("throws on API error", async () => {
      mockFetchError(404, "Task not found");
      await expect(tracker.getIssue("xyz", project)).rejects.toThrow(
        "ClickUp API GET /task/xyz returned 404",
      );
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true when status type is closed", async () => {
      mockFetchOk({
        ...sampleTask,
        status: { status: "closed", type: "closed" },
      });
      expect(await tracker.isCompleted("abc123", project)).toBe(true);
    });

    it("returns true when status type is done", async () => {
      mockFetchOk({
        ...sampleTask,
        status: { status: "done", type: "done" },
      });
      expect(await tracker.isCompleted("abc123", project)).toBe(true);
    });

    it("returns false when status type is open", async () => {
      mockFetchOk({
        ...sampleTask,
        status: { status: "to do", type: "open" },
      });
      expect(await tracker.isCompleted("abc123", project)).toBe(false);
    });

    it("returns false when status type is custom", async () => {
      mockFetchOk({
        ...sampleTask,
        status: { status: "in progress", type: "custom" },
      });
      expect(await tracker.isCompleted("abc123", project)).toBe(false);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("abc123", project)).toBe(
        "https://app.clickup.com/t/abc123",
      );
    });
  });

  // ---- issueLabel --------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts task ID from ClickUp URL", () => {
      expect(
        tracker.issueLabel("https://app.clickup.com/t/86abcdef", project),
      ).toBe("CU-86abcdef");
    });

    it("falls back to last path segment for non-standard URLs", () => {
      expect(
        tracker.issueLabel("https://example.com/tasks/abc123", project),
      ).toBe("abc123");
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("generates feat/cu-N format", () => {
      expect(tracker.branchName("abc123", project)).toBe("feat/cu-abc123");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title, URL, and description", async () => {
      mockFetchOk(sampleTask);
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).toContain("abc123");
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("https://app.clickup.com/t/abc123");
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("includes tags when present", async () => {
      mockFetchOk(sampleTask);
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).toContain("bug, high-priority");
    });

    it("includes priority name", async () => {
      mockFetchOk(sampleTask);
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).toContain("High");
    });

    it("maps priority 1 to Urgent", async () => {
      mockFetchOk({ ...sampleTask, priority: { id: "1", priority: "urgent" } });
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).toContain("Urgent");
    });

    it("omits tags when empty", async () => {
      mockFetchOk({ ...sampleTask, tags: [] });
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).not.toContain("Tags:");
    });

    it("omits description when empty", async () => {
      mockFetchOk({ ...sampleTask, text_content: "", description: "" });
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).not.toContain("## Description");
    });

    it("omits priority when not set", async () => {
      mockFetchOk({ ...sampleTask, priority: null });
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).not.toContain("Priority:");
    });

    it("includes implementation instruction", async () => {
      mockFetchOk(sampleTask);
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).toContain("Please implement the changes");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped tasks", async () => {
      mockFetchOk({
        tasks: [
          sampleTask,
          { ...sampleTask, id: "def456", name: "Another" },
        ],
      });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("abc123");
      expect(issues[1].id).toBe("def456");
    });

    it("uses correct list endpoint", async () => {
      mockFetchOk({ tasks: [] });
      await tracker.listIssues!({}, project);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/list/list-123/task");
    });

    it("passes include_closed for closed state", async () => {
      mockFetchOk({ tasks: [] });
      await tracker.listIssues!({ state: "closed" }, project);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("include_closed=true");
    });

    it("passes include_closed for all state", async () => {
      mockFetchOk({ tasks: [] });
      await tracker.listIssues!({ state: "all" }, project);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("include_closed=true");
    });

    it("passes assignee filter", async () => {
      mockFetchOk({ tasks: [] });
      await tracker.listIssues!({ assignee: "alice" }, project);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("assignees%5B%5D=alice");
    });

    it("passes tag filters", async () => {
      mockFetchOk({ tasks: [] });
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("tags%5B%5D=bug");
      expect(url).toContain("tags%5B%5D=urgent");
    });

    it("respects custom limit (slices results)", async () => {
      // Return more tasks than the limit
      const tasks = Array.from({ length: 10 }, (_, i) => ({
        ...sampleTask,
        id: `task-${i}`,
      }));
      mockFetchOk({ tasks });
      const issues = await tracker.listIssues!({ limit: 3 }, project);
      expect(issues).toHaveLength(3);
    });

    it("handles null tasks in response", async () => {
      mockFetchOk({ tasks: null });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toEqual([]);
    });

    it("throws when listId is missing from config", async () => {
      await expect(
        tracker.listIssues!({}, projectNoList),
      ).rejects.toThrow("listId");
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    it("changes state to closed by finding list status", async () => {
      // 1: fetch list statuses
      mockFetchOk({
        statuses: [
          { status: "to do", type: "open", orderindex: 0 },
          { status: "in progress", type: "custom", orderindex: 1 },
          { status: "closed", type: "closed", orderindex: 2 },
        ],
      });
      // 2: update task
      mockFetchOk({});

      await tracker.updateIssue!("abc123", { state: "closed" }, project);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.status).toBe("closed");
    });

    it("changes state to in_progress", async () => {
      mockFetchOk({
        statuses: [
          { status: "to do", type: "open", orderindex: 0 },
          { status: "in progress", type: "custom", orderindex: 1 },
          { status: "closed", type: "closed", orderindex: 2 },
        ],
      });
      mockFetchOk({});

      await tracker.updateIssue!("abc123", { state: "in_progress" }, project);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.status).toBe("in progress");
    });

    it("changes state to open", async () => {
      mockFetchOk({
        statuses: [
          { status: "to do", type: "open", orderindex: 0 },
          { status: "in progress", type: "custom", orderindex: 1 },
          { status: "closed", type: "closed", orderindex: 2 },
        ],
      });
      mockFetchOk({});

      await tracker.updateIssue!("abc123", { state: "open" }, project);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.status).toBe("to do");
    });

    it("updates assignee", async () => {
      mockFetchOk({});
      await tracker.updateIssue!("abc123", { assignee: "user-42" }, project);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.assignees).toEqual({ add: ["user-42"] });
    });

    it("adds tags via separate POST calls", async () => {
      mockFetch204();
      mockFetch204();
      await tracker.updateIssue!("abc123", { labels: ["bug", "urgent"] }, project);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain("/task/abc123/tag/bug");
      expect(fetchMock.mock.calls[1][0]).toContain("/task/abc123/tag/urgent");
    });

    it("adds a comment", async () => {
      mockFetchOk({});
      await tracker.updateIssue!("abc123", { comment: "Working on this" }, project);

      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/task/abc123/comment");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.comment_text).toBe("Working on this");
    });

    it("handles state change + labels + comment together", async () => {
      // 1: fetch list statuses
      mockFetchOk({
        statuses: [
          { status: "closed", type: "closed", orderindex: 0 },
        ],
      });
      // 2: add tag "done"
      mockFetch204();
      // 3: update task (state + PUT)
      mockFetchOk({});
      // 4: add comment
      mockFetchOk({});

      await tracker.updateIssue!(
        "abc123",
        { state: "closed", labels: ["done"], comment: "Done!" },
        project,
      );
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("throws when listId is missing (for state change)", async () => {
      await expect(
        tracker.updateIssue!("abc123", { state: "closed" }, projectNoList),
      ).rejects.toThrow("listId");
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates a task and returns mapped issue", async () => {
      mockFetchOk(sampleTask);
      const issue = await tracker.createIssue!(
        { title: "Fix login bug", description: "Description" },
        project,
      );
      expect(issue).toMatchObject({
        id: "abc123",
        title: "Fix login bug",
        state: "in_progress",
      });
    });

    it("sends correct fields in create request", async () => {
      mockFetchOk(sampleTask);
      await tracker.createIssue!(
        { title: "New task", description: "Description" },
        project,
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.name).toBe("New task");
      expect(body.description).toBe("Description");
    });

    it("uses correct list endpoint", async () => {
      mockFetchOk(sampleTask);
      await tracker.createIssue!(
        { title: "New task", description: "" },
        project,
      );
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/list/list-123/task");
    });

    it("passes assignee to create request", async () => {
      mockFetchOk(sampleTask);
      await tracker.createIssue!(
        { title: "Bug", description: "", assignee: "user-42" },
        project,
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.assignees).toEqual(["user-42"]);
    });

    it("passes priority to create request", async () => {
      mockFetchOk(sampleTask);
      await tracker.createIssue!(
        { title: "Bug", description: "", priority: 1 },
        project,
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.priority).toBe(1);
    });

    it("passes tags to create request", async () => {
      mockFetchOk(sampleTask);
      await tracker.createIssue!(
        { title: "Bug", description: "", labels: ["bug", "urgent"] },
        project,
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tags).toEqual(["bug", "urgent"]);
    });

    it("throws when listId is missing from config", async () => {
      await expect(
        tracker.createIssue!({ title: "Bug", description: "" }, projectNoList),
      ).rejects.toThrow("listId");
    });
  });

  // ---- Error handling ----------------------------------------------------

  describe("error handling", () => {
    it("throws when CLICKUP_API_TOKEN is missing", async () => {
      delete process.env["CLICKUP_API_TOKEN"];
      await expect(tracker.getIssue("abc123", project)).rejects.toThrow(
        "CLICKUP_API_TOKEN environment variable is required",
      );
    });

    it("throws on HTTP error status", async () => {
      mockFetchError(403, "Forbidden");
      await expect(tracker.getIssue("abc123", project)).rejects.toThrow(
        "returned 403",
      );
    });

    it("throws on invalid JSON response", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("not json{"),
      });
      await expect(tracker.getIssue("abc123", project)).rejects.toThrow(
        "invalid JSON",
      );
    });
  });
});
