import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock node:https
// ---------------------------------------------------------------------------

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("node:https", () => ({
  request: requestMock,
}));

import { create, manifest } from "../src/index.js";
import type { ProjectConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectConfig = {
  name: "test",
  repo: "acme/my-app",
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
  custom_id: null as string | null,
  name: "Fix login bug",
  description: "<p>Users can't log in with SSO</p>",
  text_content: "Users can't log in with SSO",
  status: { status: "open", type: "open" },
  priority: { id: "2", priority: "high", orderindex: "2" },
  assignees: [{ id: 1001, username: "alice" }],
  tags: [{ name: "bug" }, { name: "priority-high" }],
  url: "https://app.clickup.com/t/abc123",
  list: { id: "list-123", name: "Sprint Backlog" },
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockClickUpAPI(responseData: unknown, statusCode = 200) {
  const body = JSON.stringify(responseData);

  requestMock.mockImplementationOnce(
    (
      _opts: Record<string, unknown>,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), { statusCode });
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        }),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    },
  );
}

function mockClickUpError(message: string) {
  const body = JSON.stringify({ err: message, ECODE: "ERROR" });

  requestMock.mockImplementationOnce(
    (
      _opts: Record<string, unknown>,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), { statusCode: 200 });
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        }),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    },
  );
}

function mockHTTPError(statusCode: number, body: string) {
  requestMock.mockImplementationOnce(
    (
      _opts: Record<string, unknown>,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), { statusCode });
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        }),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-clickup plugin", () => {
  let tracker: ReturnType<typeof create>;
  let savedApiToken: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedApiToken = process.env["CLICKUP_API_TOKEN"];
    process.env["CLICKUP_API_TOKEN"] = "pk_test_token_123";
    tracker = create();
  });

  afterEach(() => {
    if (savedApiToken === undefined) {
      delete process.env["CLICKUP_API_TOKEN"];
    } else {
      process.env["CLICKUP_API_TOKEN"] = savedApiToken;
    }
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("clickup");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("clickup");
    });
  });

  // ---- getIssue ----------------------------------------------------------

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockClickUpAPI(sampleTask);
      const issue = await tracker.getIssue("abc123", project);
      expect(issue).toEqual({
        id: "abc123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://app.clickup.com/t/abc123",
        state: "open",
        labels: ["bug", "priority-high"],
        assignee: "alice",
        priority: 2,
      });
    });

    it("always uses native task ID, not custom_id", async () => {
      mockClickUpAPI({ ...sampleTask, custom_id: "PROJ-42" });
      const issue = await tracker.getIssue("abc123", project);
      // Must use native task.id for round-trip API compatibility —
      // custom IDs require custom_task_ids=true&team_id=... query params
      expect(issue.id).toBe("abc123");
    });

    it("maps closed status type to closed", async () => {
      mockClickUpAPI({
        ...sampleTask,
        status: { status: "done", type: "closed" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps done status type to closed", async () => {
      mockClickUpAPI({
        ...sampleTask,
        status: { status: "complete", type: "done" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps custom 'in progress' status to in_progress", async () => {
      mockClickUpAPI({
        ...sampleTask,
        status: { status: "in progress", type: "custom" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("in_progress");
    });

    it("maps custom 'in review' status to in_progress", async () => {
      mockClickUpAPI({
        ...sampleTask,
        status: { status: "in review", type: "custom" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("in_progress");
    });

    it("maps unknown custom status to open", async () => {
      mockClickUpAPI({
        ...sampleTask,
        status: { status: "backlog", type: "custom" },
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.state).toBe("open");
    });

    it("handles null description and text_content", async () => {
      mockClickUpAPI({
        ...sampleTask,
        description: null,
        text_content: null,
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.description).toBe("");
    });

    it("prefers text_content over HTML description", async () => {
      mockClickUpAPI({
        ...sampleTask,
        description: "<p>HTML description</p>",
        text_content: "Plain text description",
      });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.description).toBe("Plain text description");
    });

    it("handles empty assignees", async () => {
      mockClickUpAPI({ ...sampleTask, assignees: [] });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("handles null priority", async () => {
      mockClickUpAPI({ ...sampleTask, priority: null });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.priority).toBeUndefined();
    });

    it("handles empty tags", async () => {
      mockClickUpAPI({ ...sampleTask, tags: [] });
      const issue = await tracker.getIssue("abc123", project);
      expect(issue.labels).toEqual([]);
    });

    it("strips # prefix from identifier", async () => {
      mockClickUpAPI(sampleTask);
      await tracker.getIssue("#abc123", project);
      const callOpts = requestMock.mock.calls[0][0];
      expect(callOpts.path).toContain("/task/abc123");
    });

    it("propagates API errors", async () => {
      mockClickUpError("Task not found");
      await expect(tracker.getIssue("invalid", project)).rejects.toThrow(
        "ClickUp API error: Task not found",
      );
    });

    it("throws when CLICKUP_API_TOKEN is missing", async () => {
      delete process.env["CLICKUP_API_TOKEN"];
      await expect(tracker.getIssue("abc123", project)).rejects.toThrow(
        "CLICKUP_API_TOKEN environment variable is required",
      );
    });

    it("throws on HTTP errors", async () => {
      mockHTTPError(500, "Internal Server Error");
      await expect(tracker.getIssue("abc123", project)).rejects.toThrow(
        "ClickUp API returned HTTP 500",
      );
    });

    it("throws on HTTP 401 unauthorized", async () => {
      mockHTTPError(401, "Unauthorized");
      await expect(tracker.getIssue("abc123", project)).rejects.toThrow(
        "ClickUp API returned HTTP 401",
      );
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true for closed status type", async () => {
      mockClickUpAPI({
        ...sampleTask,
        status: { status: "done", type: "closed" },
      });
      expect(await tracker.isCompleted("abc123", project)).toBe(true);
    });

    it("returns true for done status type", async () => {
      mockClickUpAPI({
        ...sampleTask,
        status: { status: "complete", type: "done" },
      });
      expect(await tracker.isCompleted("abc123", project)).toBe(true);
    });

    it("returns true for custom closed-like status", async () => {
      mockClickUpAPI({
        ...sampleTask,
        status: { status: "closed", type: "custom" },
      });
      expect(await tracker.isCompleted("abc123", project)).toBe(true);
    });

    it("returns false for open status", async () => {
      mockClickUpAPI(sampleTask);
      expect(await tracker.isCompleted("abc123", project)).toBe(false);
    });

    it("returns false for in_progress status", async () => {
      mockClickUpAPI({
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

    it("strips # prefix from identifier", () => {
      expect(tracker.issueUrl("#abc123", project)).toBe(
        "https://app.clickup.com/t/abc123",
      );
    });
  });

  // ---- issueLabel --------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts task ID from short URL", () => {
      expect(tracker.issueLabel!("https://app.clickup.com/t/86abc123", project)).toBe(
        "86abc123",
      );
    });

    it("extracts alphanumeric task ID", () => {
      expect(tracker.issueLabel!("https://app.clickup.com/t/PROJ-123", project)).toBe(
        "PROJ-123",
      );
    });

    it("falls back to last segment for unexpected URL format", () => {
      expect(tracker.issueLabel!("https://app.clickup.com/12345/v/li/67890", project)).toBe(
        "67890",
      );
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("generates feat/cu-<id> format", () => {
      expect(tracker.branchName("abc123", project)).toBe("feat/cu-abc123");
    });

    it("strips # prefix", () => {
      expect(tracker.branchName("#abc123", project)).toBe("feat/cu-abc123");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title and URL", async () => {
      mockClickUpAPI(sampleTask);
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("https://app.clickup.com/t/abc123");
      expect(prompt).toContain("ClickUp task");
    });

    it("includes tags when present", async () => {
      mockClickUpAPI(sampleTask);
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).toContain("bug, priority-high");
    });

    it("includes priority", async () => {
      mockClickUpAPI(sampleTask);
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).toContain("High");
    });

    it("maps priority numbers to names", async () => {
      const priorities: Record<string, string> = {
        "1": "Urgent",
        "2": "High",
        "3": "Normal",
        "4": "Low",
      };
      for (const [id, name] of Object.entries(priorities)) {
        mockClickUpAPI({
          ...sampleTask,
          priority: { id, priority: name.toLowerCase(), orderindex: id },
        });
        const prompt = await tracker.generatePrompt("abc123", project);
        expect(prompt).toContain(name);
      }
    });

    it("includes description", async () => {
      mockClickUpAPI(sampleTask);
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("omits tags section when no tags", async () => {
      mockClickUpAPI({ ...sampleTask, tags: [] });
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).not.toContain("Tags:");
    });

    it("omits description section when empty", async () => {
      mockClickUpAPI({
        ...sampleTask,
        description: null,
        text_content: null,
      });
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).not.toContain("## Description");
    });

    it("omits priority when null", async () => {
      mockClickUpAPI({ ...sampleTask, priority: null });
      const prompt = await tracker.generatePrompt("abc123", project);
      expect(prompt).not.toContain("Priority:");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      mockClickUpAPI({
        tasks: [sampleTask, { ...sampleTask, id: "def456", name: "Another" }],
      });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("abc123");
      expect(issues[1].id).toBe("def456");
    });

    it("throws when listId is missing", async () => {
      await expect(tracker.listIssues!({}, projectNoList)).rejects.toThrow(
        "listId",
      );
    });

    it("includes closed tasks when state is 'all'", async () => {
      mockClickUpAPI({ tasks: [] });
      await tracker.listIssues!({ state: "all" }, project);

      const callOpts = requestMock.mock.calls[0][0];
      expect(callOpts.path).toContain("include_closed=true");
    });

    it("requests only closed tasks when state is 'closed'", async () => {
      mockClickUpAPI({ tasks: [] });
      await tracker.listIssues!({ state: "closed" }, project);

      const callOpts = requestMock.mock.calls[0][0];
      expect(callOpts.path).toContain("include_closed=true");
      // Must not filter by literal status name — ClickUp spaces use
      // custom names like "Done", "Complete" for closed-type statuses
      expect(callOpts.path).not.toContain("statuses");
    });

    it("filters closed tasks client-side including custom status names", async () => {
      mockClickUpAPI({
        tasks: [
          { ...sampleTask, id: "t1", status: { status: "open", type: "open" } },
          { ...sampleTask, id: "t2", status: { status: "done", type: "closed" } },
          { ...sampleTask, id: "t3", status: { status: "Complete", type: "done" } },
          { ...sampleTask, id: "t4", status: { status: "in progress", type: "custom" } },
          { ...sampleTask, id: "t5", status: { status: "resolved", type: "custom" } },
        ],
      });
      const issues = await tracker.listIssues!({ state: "closed" }, project);
      const ids = issues.map((i: { id: string }) => i.id);
      // "done/closed" type and custom "resolved" are closed; "open" and "in progress" are not
      expect(ids).toEqual(["t2", "t3", "t5"]);
    });

    it("excludes closed tasks by default", async () => {
      mockClickUpAPI({ tasks: [] });
      await tracker.listIssues!({}, project);

      const callOpts = requestMock.mock.calls[0][0];
      expect(callOpts.path).toContain("include_closed=false");
    });

    it("passes tag filters", async () => {
      mockClickUpAPI({ tasks: [] });
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);

      const callOpts = requestMock.mock.calls[0][0];
      expect(callOpts.path).toContain("tags%5B%5D=bug");
      expect(callOpts.path).toContain("tags%5B%5D=urgent");
    });

    it("respects custom limit", async () => {
      const tasks = Array.from({ length: 10 }, (_, i) => ({
        ...sampleTask,
        id: `task-${i}`,
      }));
      mockClickUpAPI({ tasks });
      const issues = await tracker.listIssues!({ limit: 3 }, project);
      expect(issues).toHaveLength(3);
    });

    it("defaults limit to 30", async () => {
      const tasks = Array.from({ length: 35 }, (_, i) => ({
        ...sampleTask,
        id: `task-${i}`,
      }));
      mockClickUpAPI({ tasks });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(30);
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    it("closes a task", async () => {
      mockClickUpAPI({});
      await tracker.updateIssue!("abc123", { state: "closed" }, project);

      const callOpts = requestMock.mock.calls[0][0];
      expect(callOpts.method).toBe("PUT");
      expect(callOpts.path).toContain("/task/abc123");

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.status).toBe("closed");
    });

    it("sets task to in_progress", async () => {
      mockClickUpAPI({});
      await tracker.updateIssue!("abc123", { state: "in_progress" }, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.status).toBe("in progress");
    });

    it("reopens a task", async () => {
      mockClickUpAPI({});
      await tracker.updateIssue!("abc123", { state: "open" }, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.status).toBe("open");
    });

    it("adds a comment", async () => {
      mockClickUpAPI({});
      await tracker.updateIssue!("abc123", { comment: "Working on this" }, project);

      const callOpts = requestMock.mock.calls[0][0];
      expect(callOpts.method).toBe("POST");
      expect(callOpts.path).toContain("/task/abc123/comment");

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.comment_text).toBe("Working on this");
    });

    it("adds tags (labels)", async () => {
      mockClickUpAPI({});
      mockClickUpAPI({});
      await tracker.updateIssue!("abc123", { labels: ["bug", "urgent"] }, project);
      expect(requestMock).toHaveBeenCalledTimes(2);

      const call1Opts = requestMock.mock.calls[0][0];
      expect(call1Opts.path).toContain("/task/abc123/tag/bug");
      const call2Opts = requestMock.mock.calls[1][0];
      expect(call2Opts.path).toContain("/task/abc123/tag/urgent");
    });

    it("removes tags (removeLabels) via DELETE", async () => {
      mockClickUpAPI({});
      mockClickUpAPI({});
      await tracker.updateIssue!("abc123", { removeLabels: ["old-tag", "stale"] }, project);
      expect(requestMock).toHaveBeenCalledTimes(2);

      const call1Opts = requestMock.mock.calls[0][0];
      expect(call1Opts.method).toBe("DELETE");
      expect(call1Opts.path).toContain("/task/abc123/tag/old-tag");
      const call2Opts = requestMock.mock.calls[1][0];
      expect(call2Opts.method).toBe("DELETE");
      expect(call2Opts.path).toContain("/task/abc123/tag/stale");
    });

    it("handles state change + comment together", async () => {
      mockClickUpAPI({}); // state change
      mockClickUpAPI({}); // comment
      await tracker.updateIssue!(
        "abc123",
        { state: "closed", comment: "Done!" },
        project,
      );
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it("strips # prefix from identifier", async () => {
      mockClickUpAPI({});
      await tracker.updateIssue!("#abc123", { state: "closed" }, project);

      const callOpts = requestMock.mock.calls[0][0];
      expect(callOpts.path).toContain("/task/abc123");
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates a basic task", async () => {
      mockClickUpAPI(sampleTask);

      const issue = await tracker.createIssue!(
        { title: "Fix login bug", description: "Users can't log in with SSO" },
        project,
      );
      expect(issue).toMatchObject({
        id: "abc123",
        title: "Fix login bug",
        state: "open",
      });
    });

    it("passes priority to API", async () => {
      mockClickUpAPI(sampleTask);

      await tracker.createIssue!(
        { title: "Bug", description: "", priority: 1 },
        project,
      );

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.priority).toBe(1);
    });

    it("passes tags and assignee", async () => {
      mockClickUpAPI(sampleTask);

      await tracker.createIssue!(
        {
          title: "Bug",
          description: "",
          labels: ["bug", "urgent"],
          assignee: "alice",
        },
        project,
      );

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.tags).toEqual(["bug", "urgent"]);
      expect(body.assignees).toEqual(["alice"]);
    });

    it("throws when listId is missing", async () => {
      await expect(
        tracker.createIssue!({ title: "Bug", description: "" }, projectNoList),
      ).rejects.toThrow("listId");
    });

    it("creates task in the correct list", async () => {
      mockClickUpAPI(sampleTask);

      await tracker.createIssue!(
        { title: "Test", description: "" },
        project,
      );

      const callOpts = requestMock.mock.calls[0][0];
      expect(callOpts.path).toContain("/list/list-123/task");
      expect(callOpts.method).toBe("POST");
    });
  });

  // ---- error handling ----------------------------------------------------

  describe("error handling", () => {
    it("throws on missing CLICKUP_API_TOKEN", async () => {
      delete process.env["CLICKUP_API_TOKEN"];
      await expect(tracker.getIssue("abc123", project)).rejects.toThrow(
        "CLICKUP_API_TOKEN",
      );
    });

    it("throws on ClickUp API error response", async () => {
      mockClickUpError("Team not authorized");
      await expect(tracker.getIssue("abc123", project)).rejects.toThrow(
        "ClickUp API error: Team not authorized",
      );
    });

    it("throws on HTTP error status", async () => {
      mockHTTPError(429, "Rate limit exceeded");
      await expect(tracker.getIssue("abc123", project)).rejects.toThrow(
        "ClickUp API returned HTTP 429",
      );
    });
  });
});
