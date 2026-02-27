import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectConfig } from "@composio/ao-core";

import { manifest, create } from "../src/index.js";

// Mock node:https request to capture calls
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("node:https", () => ({
  request: requestMock,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_HOST = "mycompany.atlassian.net";

const project: ProjectConfig = {
  name: "test",
  repo: "acme/repo",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: { plugin: "jira", projectKey: "PROJ", host: TEST_HOST },
};

/** Decode URL path, handling both %20 and + as spaces */
function decodePath(path: string): string {
  return decodeURIComponent(path.replaceAll("+", " "));
}

function mockJiraResponse(statusCode: number, body: unknown) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  requestMock.mockImplementationOnce((_opts: unknown, callback: (res: unknown) => void) => {
    const res = {
      statusCode,
      on: vi.fn((event: string, handler: (data?: unknown) => void) => {
        if (event === "data") {
          handler(Buffer.from(bodyStr));
        }
        if (event === "end") {
          handler();
        }
      }),
    };
    // Call callback synchronously for test simplicity
    callback(res);
    return {
      setTimeout: vi.fn(),
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
  });
}

const sampleJiraIssue = {
  id: "10001",
  key: "PROJ-123",
  self: `https://${TEST_HOST}/rest/api/3/issue/10001`,
  fields: {
    summary: "Fix login bug",
    description: "Users can't log in with SSO",
    status: {
      name: "To Do",
      statusCategory: { key: "new", name: "To Do" },
    },
    labels: ["bug", "priority-high"],
    assignee: { displayName: "Alice Smith", emailAddress: "alice@example.com" },
    priority: { name: "High", id: "2" },
    issuetype: { name: "Bug" },
    project: { key: "PROJ" },
  },
};

const inProgressIssue = {
  ...sampleJiraIssue,
  fields: {
    ...sampleJiraIssue.fields,
    status: {
      name: "In Progress",
      statusCategory: { key: "indeterminate", name: "In Progress" },
    },
  },
};

const doneIssue = {
  ...sampleJiraIssue,
  fields: {
    ...sampleJiraIssue.fields,
    status: {
      name: "Done",
      statusCategory: { key: "done", name: "Done" },
    },
  },
};

const cancelledIssue = {
  ...sampleJiraIssue,
  fields: {
    ...sampleJiraIssue.fields,
    status: {
      name: "Cancelled",
      statusCategory: { key: "done", name: "Done" },
    },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-jira plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set env vars for direct transport
    process.env["JIRA_EMAIL"] = "test@example.com";
    process.env["JIRA_API_TOKEN"] = "test-token";
    delete process.env["COMPOSIO_API_KEY"];

    tracker = create();
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("jira");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("jira");
    });
  });

  // ---- getIssue ----------------------------------------------------------

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockJiraResponse(200, sampleJiraIssue);
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue).toEqual({
        id: "PROJ-123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: `https://${TEST_HOST}/browse/PROJ-123`,
        state: "open",
        labels: ["bug", "priority-high"],
        assignee: "Alice Smith",
        priority: 2,
      });
    });

    it("maps in_progress state", async () => {
      mockJiraResponse(200, inProgressIssue);
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.state).toBe("in_progress");
    });

    it("maps done state to closed", async () => {
      mockJiraResponse(200, doneIssue);
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps cancelled status name to cancelled", async () => {
      mockJiraResponse(200, cancelledIssue);
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.state).toBe("cancelled");
    });

    it("handles missing description gracefully", async () => {
      mockJiraResponse(200, {
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, description: null },
      });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.description).toBe("");
    });

    it("handles missing assignee", async () => {
      mockJiraResponse(200, {
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, assignee: null },
      });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("handles missing priority", async () => {
      mockJiraResponse(200, {
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, priority: null },
      });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.priority).toBeUndefined();
    });

    it("propagates HTTP errors", async () => {
      mockJiraResponse(404, { errorMessages: ["Issue does not exist"] });
      await expect(tracker.getIssue("PROJ-999", project)).rejects.toThrow(
        "Jira API returned HTTP 404",
      );
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true for done issues", async () => {
      mockJiraResponse(200, doneIssue);
      expect(await tracker.isCompleted("PROJ-123", project)).toBe(true);
    });

    it("returns false for open issues", async () => {
      mockJiraResponse(200, sampleJiraIssue);
      expect(await tracker.isCompleted("PROJ-123", project)).toBe(false);
    });

    it("returns false for in-progress issues", async () => {
      mockJiraResponse(200, inProgressIssue);
      expect(await tracker.isCompleted("PROJ-123", project)).toBe(false);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("PROJ-42", project)).toBe(`https://${TEST_HOST}/browse/PROJ-42`);
    });
  });

  // ---- issueLabel --------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts key from Jira URL", () => {
      expect(tracker.issueLabel!(`https://${TEST_HOST}/browse/PROJ-123`, project)).toBe("PROJ-123");
    });

    it("handles URL with query params", () => {
      expect(
        tracker.issueLabel!(`https://${TEST_HOST}/browse/PROJ-123?focusedId=12345`, project),
      ).toBe("PROJ-123");
    });

    it("falls back to last path segment", () => {
      expect(tracker.issueLabel!(`https://${TEST_HOST}/something/else`, project)).toBe("else");
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("generates feat/KEY format", () => {
      expect(tracker.branchName("PROJ-123", project)).toBe("feat/PROJ-123");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title and URL", async () => {
      mockJiraResponse(200, sampleJiraIssue);
      const prompt = await tracker.generatePrompt("PROJ-123", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain(`https://${TEST_HOST}/browse/PROJ-123`);
      expect(prompt).toContain("Jira ticket PROJ-123");
    });

    it("includes labels when present", async () => {
      mockJiraResponse(200, sampleJiraIssue);
      const prompt = await tracker.generatePrompt("PROJ-123", project);
      expect(prompt).toContain("bug, priority-high");
    });

    it("includes priority", async () => {
      mockJiraResponse(200, sampleJiraIssue);
      const prompt = await tracker.generatePrompt("PROJ-123", project);
      expect(prompt).toContain("Priority: High");
    });

    it("includes description", async () => {
      mockJiraResponse(200, sampleJiraIssue);
      const prompt = await tracker.generatePrompt("PROJ-123", project);
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("omits labels section when no labels", async () => {
      mockJiraResponse(200, {
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, labels: [] },
      });
      const prompt = await tracker.generatePrompt("PROJ-123", project);
      expect(prompt).not.toContain("Labels:");
    });

    it("omits description section when body is empty", async () => {
      mockJiraResponse(200, {
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, description: null },
      });
      const prompt = await tracker.generatePrompt("PROJ-123", project);
      expect(prompt).not.toContain("## Description");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      const secondIssue = {
        ...sampleJiraIssue,
        key: "PROJ-456",
        fields: { ...sampleJiraIssue.fields, summary: "Another issue" },
      };
      mockJiraResponse(200, {
        issues: [sampleJiraIssue, secondIssue],
        total: 2,
        maxResults: 30,
        startAt: 0,
      });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("PROJ-123");
      expect(issues[1].id).toBe("PROJ-456");
    });

    it("passes project key in JQL", async () => {
      mockJiraResponse(200, { issues: [], total: 0, maxResults: 30, startAt: 0 });
      await tracker.listIssues!({}, project);
      const callArgs = requestMock.mock.calls[0][0] as { path: string };
      const decoded = decodePath(callArgs.path);
      expect(decoded).toContain('project = "PROJ"');
    });

    it("filters closed issues", async () => {
      mockJiraResponse(200, { issues: [], total: 0, maxResults: 30, startAt: 0 });
      await tracker.listIssues!({ state: "closed" }, project);
      const callArgs = requestMock.mock.calls[0][0] as { path: string };
      const decoded = decodePath(callArgs.path);
      expect(decoded).toContain('statusCategory = "Done"');
    });

    it("defaults to non-done state", async () => {
      mockJiraResponse(200, { issues: [], total: 0, maxResults: 30, startAt: 0 });
      await tracker.listIssues!({}, project);
      const callArgs = requestMock.mock.calls[0][0] as { path: string };
      const decoded = decodePath(callArgs.path);
      expect(decoded).toContain('statusCategory != "Done"');
    });

    it("passes assignee filter", async () => {
      mockJiraResponse(200, { issues: [], total: 0, maxResults: 30, startAt: 0 });
      await tracker.listIssues!({ assignee: "alice" }, project);
      const callArgs = requestMock.mock.calls[0][0] as { path: string };
      const decoded = decodePath(callArgs.path);
      expect(decoded).toContain('assignee = "alice"');
    });

    it("passes label filter", async () => {
      mockJiraResponse(200, { issues: [], total: 0, maxResults: 30, startAt: 0 });
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);
      const callArgs = requestMock.mock.calls[0][0] as { path: string };
      const decoded = decodePath(callArgs.path);
      expect(decoded).toContain('labels = "bug"');
      expect(decoded).toContain('labels = "urgent"');
    });

    it("respects custom limit", async () => {
      mockJiraResponse(200, { issues: [], total: 0, maxResults: 5, startAt: 0 });
      await tracker.listIssues!({ limit: 5 }, project);
      const callArgs = requestMock.mock.calls[0][0] as { path: string };
      expect(callArgs.path).toContain("maxResults=5");
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    it("transitions an issue to done", async () => {
      // First: GET transitions
      mockJiraResponse(200, {
        transitions: [
          { id: "31", name: "Done", to: { statusCategory: { key: "done" } } },
          { id: "21", name: "In Progress", to: { statusCategory: { key: "indeterminate" } } },
        ],
      });
      // Second: POST transition
      mockJiraResponse(204, "");

      await tracker.updateIssue!("PROJ-123", { state: "closed" }, project);
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it("throws when no matching transition found", async () => {
      mockJiraResponse(200, {
        transitions: [
          { id: "21", name: "In Progress", to: { statusCategory: { key: "indeterminate" } } },
        ],
      });

      await expect(tracker.updateIssue!("PROJ-123", { state: "closed" }, project)).rejects.toThrow(
        'No transition found to status category "done"',
      );
    });

    it("adds a comment", async () => {
      mockJiraResponse(201, { id: "10001" });
      await tracker.updateIssue!("PROJ-123", { comment: "Working on this" }, project);
      expect(requestMock).toHaveBeenCalledTimes(1);
      const callArgs = requestMock.mock.calls[0][0] as { path: string; method: string };
      expect(callArgs.method).toBe("POST");
      expect(callArgs.path).toContain("/comment");
    });

    it("updates labels (additive)", async () => {
      // First: GET existing labels
      mockJiraResponse(200, {
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, labels: ["existing"] },
      });
      // Second: PUT update
      mockJiraResponse(204, "");

      await tracker.updateIssue!("PROJ-123", { labels: ["new-label"] }, project);
      expect(requestMock).toHaveBeenCalledTimes(2);
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates an issue and fetches full details", async () => {
      // First: POST create returns partial
      mockJiraResponse(201, { id: "10002", key: "PROJ-456", self: "..." });
      // Second: GET full issue
      mockJiraResponse(200, {
        ...sampleJiraIssue,
        id: "10002",
        key: "PROJ-456",
        fields: { ...sampleJiraIssue.fields, summary: "New issue" },
      });

      const issue = await tracker.createIssue!(
        { title: "New issue", description: "Description" },
        project,
      );
      expect(issue).toMatchObject({
        id: "PROJ-456",
        title: "New issue",
        state: "open",
      });
    });

    it("throws when projectKey is missing", async () => {
      const projectWithoutKey: ProjectConfig = {
        ...project,
        tracker: { plugin: "jira", host: TEST_HOST },
      };
      await expect(
        tracker.createIssue!({ title: "Test", description: "" }, projectWithoutKey),
      ).rejects.toThrow("projectKey");
    });
  });

  // ---- state mapping edge cases -------------------------------------------

  describe("state mapping", () => {
    it("maps unknown status category to open", async () => {
      mockJiraResponse(200, {
        ...sampleJiraIssue,
        fields: {
          ...sampleJiraIssue.fields,
          status: {
            name: "Unknown",
            statusCategory: { key: "undefined", name: "Unknown" },
          },
        },
      });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.state).toBe("open");
    });

    it("detects cancelled by status name regardless of category", async () => {
      mockJiraResponse(200, {
        ...sampleJiraIssue,
        fields: {
          ...sampleJiraIssue.fields,
          status: {
            name: "Cancelled by Admin",
            statusCategory: { key: "done", name: "Done" },
          },
        },
      });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.state).toBe("cancelled");
    });
  });
});
