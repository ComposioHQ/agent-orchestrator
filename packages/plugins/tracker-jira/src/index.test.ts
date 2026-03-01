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
  repo: "acme/integrator",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: {
    plugin: "jira",
    projectKey: "INT",
  },
};

const projectNoKey: ProjectConfig = {
  ...project,
  tracker: { plugin: "jira" },
};

const sampleJiraIssue = {
  key: "INT-123",
  id: "10001",
  self: "https://mycompany.atlassian.net/rest/api/3/issue/10001",
  fields: {
    summary: "Fix login bug",
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Users can't log in with SSO" }],
        },
      ],
    },
    status: {
      name: "In Progress",
      statusCategory: { key: "indeterminate" },
    },
    labels: ["bug", "high-priority"],
    assignee: { displayName: "Alice Smith", accountId: "acc-123" },
    priority: { name: "High", id: "2" },
    issuetype: { name: "Task" },
    project: { key: "INT" },
  },
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

describe("tracker-jira plugin", () => {
  let tracker: ReturnType<typeof create>;
  let savedEmail: string | undefined;
  let savedToken: string | undefined;
  let savedHost: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);

    savedEmail = process.env["JIRA_EMAIL"];
    savedToken = process.env["JIRA_API_TOKEN"];
    savedHost = process.env["JIRA_HOST"];

    process.env["JIRA_EMAIL"] = "test@example.com";
    process.env["JIRA_API_TOKEN"] = "jira-test-token";
    process.env["JIRA_HOST"] = "https://mycompany.atlassian.net";

    tracker = create();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, val] of Object.entries({
      JIRA_EMAIL: savedEmail,
      JIRA_API_TOKEN: savedToken,
      JIRA_HOST: savedHost,
    })) {
      if (val === undefined) {
        process.env[key] = undefined;
      } else {
        process.env[key] = val;
      }
    }
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("jira");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
      expect(manifest.description).toBe("Tracker plugin: Jira");
    });
  });

  // ---- default export ----------------------------------------------------

  describe("default export", () => {
    it("is a valid PluginModule", () => {
      expect(pluginDefault).toHaveProperty("manifest");
      expect(pluginDefault).toHaveProperty("create");
      expect(pluginDefault.manifest.name).toBe("jira");
      expect(pluginDefault.manifest.slot).toBe("tracker");
      expect(typeof pluginDefault.create).toBe("function");
    });
  });

  // ---- create() ----------------------------------------------------------

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("jira");
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
      mockFetchOk(sampleJiraIssue);
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue).toEqual({
        id: "INT-123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://mycompany.atlassian.net/browse/INT-123",
        state: "in_progress",
        labels: ["bug", "high-priority"],
        assignee: "Alice Smith",
        priority: 2,
      });
    });

    it("calls correct Jira API endpoint", async () => {
      mockFetchOk(sampleJiraIssue);
      await tracker.getIssue("INT-123", project);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://mycompany.atlassian.net/rest/api/3/issue/INT-123",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("sends correct auth header", async () => {
      mockFetchOk(sampleJiraIssue);
      await tracker.getIssue("INT-123", project);
      const callArgs = fetchMock.mock.calls[0];
      const headers = callArgs[1].headers;
      const expectedAuth = `Basic ${Buffer.from("test@example.com:jira-test-token").toString("base64")}`;
      expect(headers["Authorization"]).toBe(expectedAuth);
    });

    it("maps 'done' status category to closed", async () => {
      mockFetchOk({
        ...sampleJiraIssue,
        fields: {
          ...sampleJiraIssue.fields,
          status: { name: "Done", statusCategory: { key: "done" } },
        },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps 'new' status category to open", async () => {
      mockFetchOk({
        ...sampleJiraIssue,
        fields: {
          ...sampleJiraIssue.fields,
          status: { name: "To Do", statusCategory: { key: "new" } },
        },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.state).toBe("open");
    });

    it("maps unknown status category to open", async () => {
      mockFetchOk({
        ...sampleJiraIssue,
        fields: {
          ...sampleJiraIssue.fields,
          status: { name: "Custom", statusCategory: { key: "unknown" } },
        },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.state).toBe("open");
    });

    it("handles null description", async () => {
      mockFetchOk({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, description: null },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.description).toBe("");
    });

    it("handles string description", async () => {
      mockFetchOk({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, description: "Plain text" },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.description).toBe("Plain text");
    });

    it("handles null assignee", async () => {
      mockFetchOk({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, assignee: null },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("handles null priority", async () => {
      mockFetchOk({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, priority: null },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.priority).toBeUndefined();
    });

    it("handles empty labels", async () => {
      mockFetchOk({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, labels: [] },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.labels).toEqual([]);
    });

    it("throws on API error", async () => {
      mockFetchError(404, "Issue not found");
      await expect(tracker.getIssue("INT-999", project)).rejects.toThrow(
        "Jira API GET /rest/api/3/issue/INT-999 returned 404",
      );
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true when status category is done", async () => {
      mockFetchOk({
        ...sampleJiraIssue,
        fields: {
          ...sampleJiraIssue.fields,
          status: { name: "Done", statusCategory: { key: "done" } },
        },
      });
      expect(await tracker.isCompleted("INT-123", project)).toBe(true);
    });

    it("returns false when status category is indeterminate", async () => {
      mockFetchOk(sampleJiraIssue);
      expect(await tracker.isCompleted("INT-123", project)).toBe(false);
    });

    it("returns false when status category is new", async () => {
      mockFetchOk({
        ...sampleJiraIssue,
        fields: {
          ...sampleJiraIssue.fields,
          status: { name: "To Do", statusCategory: { key: "new" } },
        },
      });
      expect(await tracker.isCompleted("INT-123", project)).toBe(false);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("INT-123", project)).toBe(
        "https://mycompany.atlassian.net/browse/INT-123",
      );
    });

    it("strips trailing slashes from host", () => {
      process.env["JIRA_HOST"] = "https://mycompany.atlassian.net///";
      expect(tracker.issueUrl("INT-123", project)).toBe(
        "https://mycompany.atlassian.net/browse/INT-123",
      );
    });
  });

  // ---- issueLabel --------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts key from Jira browse URL", () => {
      expect(
        tracker.issueLabel("https://mycompany.atlassian.net/browse/INT-123", project),
      ).toBe("INT-123");
    });

    it("extracts key from different project URL", () => {
      expect(
        tracker.issueLabel("https://other.atlassian.net/browse/PROJ-456", project),
      ).toBe("PROJ-456");
    });

    it("falls back to last path segment for non-standard URLs", () => {
      expect(
        tracker.issueLabel("https://jira.example.com/issues/INT-123", project),
      ).toBe("INT-123");
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("generates feat/ prefix with lowercase key", () => {
      expect(tracker.branchName("INT-123", project)).toBe("feat/int-123");
    });

    it("lowercases the identifier", () => {
      expect(tracker.branchName("PROJ-456", project)).toBe("feat/proj-456");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title, URL, and description", async () => {
      mockFetchOk(sampleJiraIssue);
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("INT-123");
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("https://mycompany.atlassian.net/browse/INT-123");
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("includes labels when present", async () => {
      mockFetchOk(sampleJiraIssue);
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("bug, high-priority");
    });

    it("omits labels when empty", async () => {
      mockFetchOk({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, labels: [] },
      });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).not.toContain("Labels:");
    });

    it("omits description when empty", async () => {
      mockFetchOk({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, description: null },
      });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).not.toContain("## Description");
    });

    it("includes implementation instruction", async () => {
      mockFetchOk(sampleJiraIssue);
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("Please implement the changes");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      mockFetchOk({
        issues: [
          sampleJiraIssue,
          { ...sampleJiraIssue, key: "INT-456", fields: { ...sampleJiraIssue.fields, summary: "Another" } },
        ],
      });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("INT-123");
      expect(issues[1].id).toBe("INT-456");
    });

    it("passes state filter for closed issues", async () => {
      mockFetchOk({ issues: [] });
      await tracker.listIssues!({ state: "closed" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.jql).toContain("statusCategory = Done");
    });

    it("passes state filter for open issues", async () => {
      mockFetchOk({ issues: [] });
      await tracker.listIssues!({ state: "open" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.jql).toContain("statusCategory != Done");
    });

    it("includes project key in JQL when configured", async () => {
      mockFetchOk({ issues: [] });
      await tracker.listIssues!({}, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.jql).toContain('project = "INT"');
    });

    it("passes label filter", async () => {
      mockFetchOk({ issues: [] });
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.jql).toContain('labels = "bug"');
      expect(body.jql).toContain('labels = "urgent"');
    });

    it("passes assignee filter", async () => {
      mockFetchOk({ issues: [] });
      await tracker.listIssues!({ assignee: "alice" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.jql).toContain('assignee = "alice"');
    });

    it("respects custom limit", async () => {
      mockFetchOk({ issues: [] });
      await tracker.listIssues!({ limit: 5 }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.maxResults).toBe(5);
    });

    it("defaults limit to 30", async () => {
      mockFetchOk({ issues: [] });
      await tracker.listIssues!({}, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.maxResults).toBe(30);
    });

    it("uses POST method for search", async () => {
      mockFetchOk({ issues: [] });
      await tracker.listIssues!({}, project);
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("escapes JQL special characters in filter values", async () => {
      mockFetchOk({ issues: [] });
      await tracker.listIssues!(
        {
          labels: ['bug" OR project = "SECRET'],
          assignee: 'alice" OR assignee = "bob',
        },
        project,
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.jql).toContain('labels = "bug\\" OR project = \\"SECRET"');
      expect(body.jql).toContain('assignee = "alice\\" OR assignee = \\"bob"');
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    it("transitions issue to closed", async () => {
      // 1: fetch transitions
      mockFetchOk({
        transitions: [
          { id: "31", name: "Done", to: { statusCategory: { key: "done" } } },
          { id: "21", name: "In Progress", to: { statusCategory: { key: "indeterminate" } } },
        ],
      });
      // 2: perform transition
      mockFetch204();

      await tracker.updateIssue!("INT-123", { state: "closed" }, project);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Verify the transition POST body
      const transitionBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(transitionBody.transition.id).toBe("31");
    });

    it("transitions issue to in_progress", async () => {
      mockFetchOk({
        transitions: [
          { id: "31", name: "Done", to: { statusCategory: { key: "done" } } },
          { id: "21", name: "In Progress", to: { statusCategory: { key: "indeterminate" } } },
        ],
      });
      mockFetch204();

      await tracker.updateIssue!("INT-123", { state: "in_progress" }, project);
      const transitionBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(transitionBody.transition.id).toBe("21");
    });

    it("skips transition when no matching target found", async () => {
      mockFetchOk({
        transitions: [
          { id: "21", name: "In Progress", to: { statusCategory: { key: "indeterminate" } } },
        ],
      });
      // No matching "done" transition, so should not attempt transition POST
      await tracker.updateIssue!("INT-123", { state: "closed" }, project);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("adds a comment", async () => {
      mockFetch204();
      await tracker.updateIssue!("INT-123", { comment: "Working on this" }, project);

      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/rest/api/3/issue/INT-123/comment");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.body.content[0].content[0].text).toBe("Working on this");
    });

    it("updates labels", async () => {
      mockFetch204();
      await tracker.updateIssue!("INT-123", { labels: ["bug", "urgent"] }, project);

      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/rest/api/3/issue/INT-123");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.update.labels).toEqual([{ add: "bug" }, { add: "urgent" }]);
    });

    it("updates assignee by searching for accountId", async () => {
      // 1: user search returns matching user
      mockFetchOk([{ accountId: "acc-bob", displayName: "bob" }]);
      // 2: issue update
      mockFetch204();

      await tracker.updateIssue!("INT-123", { assignee: "bob" }, project);

      // First call is user search
      const searchUrl = fetchMock.mock.calls[0][0] as string;
      expect(searchUrl).toContain("/rest/api/3/user/search?query=bob");

      // Second call is the issue update with accountId
      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.fields.assignee).toEqual({ accountId: "acc-bob" });
    });

    it("handles state change + comment together", async () => {
      // 1: fetch transitions
      mockFetchOk({
        transitions: [
          { id: "31", name: "Done", to: { statusCategory: { key: "done" } } },
        ],
      });
      // 2: perform transition
      mockFetch204();
      // 3: add comment
      mockFetch204();

      await tracker.updateIssue!(
        "INT-123",
        { state: "closed", comment: "Done!" },
        project,
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates an issue and fetches full details", async () => {
      // 1: create issue
      mockFetchOk({ key: "INT-999" });
      // 2: getIssue for the created issue
      mockFetchOk({
        ...sampleJiraIssue,
        key: "INT-999",
        fields: { ...sampleJiraIssue.fields, summary: "New issue" },
      });

      const issue = await tracker.createIssue!(
        { title: "New issue", description: "Description" },
        project,
      );
      expect(issue).toMatchObject({ id: "INT-999", title: "New issue" });
    });

    it("sends correct fields in create request", async () => {
      mockFetchOk({ key: "INT-999" });
      mockFetchOk(sampleJiraIssue);

      await tracker.createIssue!(
        { title: "New issue", description: "Description" },
        project,
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.fields.project.key).toBe("INT");
      expect(body.fields.summary).toBe("New issue");
      expect(body.fields.issuetype.name).toBe("Task");
    });

    it("passes labels to create request", async () => {
      mockFetchOk({ key: "INT-999" });
      mockFetchOk(sampleJiraIssue);

      await tracker.createIssue!(
        { title: "Bug", description: "", labels: ["bug", "urgent"] },
        project,
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.fields.labels).toEqual(["bug", "urgent"]);
    });

    it("throws when projectKey is missing from config", async () => {
      await expect(
        tracker.createIssue!({ title: "Bug", description: "" }, projectNoKey),
      ).rejects.toThrow("projectKey");
    });
  });

  // ---- Error handling ----------------------------------------------------

  describe("error handling", () => {
    it("throws when JIRA_EMAIL is missing", async () => {
      delete process.env["JIRA_EMAIL"];
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "JIRA_EMAIL environment variable is required",
      );
    });

    it("throws when JIRA_API_TOKEN is missing", async () => {
      delete process.env["JIRA_API_TOKEN"];
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "JIRA_API_TOKEN environment variable is required",
      );
    });

    it("throws when JIRA_HOST is missing", async () => {
      delete process.env["JIRA_HOST"];
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "JIRA_HOST environment variable is required",
      );
    });

    it("throws on HTTP error status", async () => {
      mockFetchError(401, "Unauthorized");
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "returned 401",
      );
    });

    it("throws on invalid JSON response", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("not json{"),
      });
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "invalid JSON",
      );
    });
  });
});
