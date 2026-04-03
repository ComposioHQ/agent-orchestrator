import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { create, manifest, detect } from "../index.js";
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
};

const pluginConfig = {
  baseUrl: "https://acme.atlassian.net",
  email: "bot@acme.com",
  apiToken: "test-token",
  projectKey: "TT",
  statusMap: {
    in_progress: "In Progress",
    closed: "Done",
    open: "To Do",
  },
};

function mockFetchJson(data: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockFetchError(status: number, body = "") {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  });
}

function mockFetch204() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 204,
    json: () => Promise.reject(new Error("no body")),
    text: () => Promise.resolve(""),
  });
}

/** Mock the sprint resolution calls (findBoardId + getActiveSprint). */
function mockSprintResolution(sprintName: string | null = "Sprint 8") {
  // findBoardId
  mockFetchJson({ values: [{ id: 1 }] });
  // getActiveSprint
  if (sprintName) {
    mockFetchJson({ values: [{ name: sprintName }] });
  } else {
    mockFetchJson({ values: [] });
  }
}

const sampleJiraIssue = {
  key: "TT-142",
  fields: {
    summary: "Fix login SSO bug",
    description: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Users cannot log in with SSO" }],
        },
      ],
    },
    status: { name: "To Do" },
    priority: { name: "High" },
    labels: ["bug", "sso"],
    assignee: { displayName: "Alice", accountId: "abc123" },
    issuetype: { name: "Bug" },
  },
};

const sampleJiraIssueDone = {
  ...sampleJiraIssue,
  fields: { ...sampleJiraIssue.fields, status: { name: "Done" } },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-jira plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    fetchMock.mockReset();
    tracker = create(pluginConfig);
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

    it("throws when baseUrl is missing", () => {
      const env = process.env;
      delete process.env.JIRA_BASE_URL;
      expect(() => create({})).toThrow("baseUrl is required");
      process.env = env;
    });

    it("throws when email is missing", () => {
      expect(() => create({ baseUrl: "https://x.atlassian.net" })).toThrow(
        "email is required",
      );
    });

    it("throws when apiToken is missing", () => {
      expect(() =>
        create({ baseUrl: "https://x.atlassian.net", email: "a@b.com" }),
      ).toThrow("apiToken is required");
    });
  });

  // ---- detect ------------------------------------------------------------

  describe("detect()", () => {
    it("returns true when all env vars are set", () => {
      const orig = { ...process.env };
      process.env.JIRA_BASE_URL = "https://x.atlassian.net";
      process.env.JIRA_EMAIL = "a@b.com";
      process.env.JIRA_API_TOKEN = "tok";
      expect(detect()).toBe(true);
      process.env = orig;
    });

    it("returns false when env vars are missing", () => {
      const orig = { ...process.env };
      delete process.env.JIRA_BASE_URL;
      delete process.env.JIRA_EMAIL;
      delete process.env.JIRA_API_TOKEN;
      expect(detect()).toBe(false);
      process.env = orig;
    });
  });

  // ---- getIssue ----------------------------------------------------------

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockSprintResolution();
      mockFetchJson(sampleJiraIssue);
      const issue = await tracker.getIssue("TT-142", project);
      expect(issue).toEqual({
        id: "TT-142",
        title: "Fix login SSO bug",
        description: "Users cannot log in with SSO",
        url: "https://acme.atlassian.net/browse/TT-142",
        state: "open",
        labels: ["bug", "sso"],
        assignee: "Alice",
        priority: 2,
      });
    });

    it("maps Done status to closed", async () => {
      mockSprintResolution();
      mockFetchJson(sampleJiraIssueDone);
      const issue = await tracker.getIssue("TT-142", project);
      expect(issue.state).toBe("closed");
    });

    it("maps In Progress status to in_progress", async () => {
      mockSprintResolution();
      mockFetchJson({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, status: { name: "In Progress" } },
      });
      const issue = await tracker.getIssue("TT-142", project);
      expect(issue.state).toBe("in_progress");
    });

    it("handles null description", async () => {
      mockSprintResolution();
      mockFetchJson({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, description: null },
      });
      const issue = await tracker.getIssue("TT-142", project);
      expect(issue.description).toBe("");
    });

    it("handles null assignee", async () => {
      mockSprintResolution();
      mockFetchJson({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, assignee: null },
      });
      const issue = await tracker.getIssue("TT-142", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("handles null priority", async () => {
      mockSprintResolution();
      mockFetchJson({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, priority: null },
      });
      const issue = await tracker.getIssue("TT-142", project);
      expect(issue.priority).toBeUndefined();
    });

    it("throws on 401", async () => {
      mockSprintResolution();
      mockFetchError(401);
      await expect(tracker.getIssue("TT-142", project)).rejects.toThrow(
        "authentication failed",
      );
    });

    it("throws on 404", async () => {
      mockSprintResolution();
      mockFetchError(404);
      await expect(tracker.getIssue("TT-999", project)).rejects.toThrow(
        "not found",
      );
    });

    it("throws on 429", async () => {
      mockSprintResolution();
      mockFetchError(429);
      await expect(tracker.getIssue("TT-142", project)).rejects.toThrow(
        "rate limit",
      );
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true for Done issues", async () => {
      mockFetchJson(sampleJiraIssueDone);
      expect(await tracker.isCompleted("TT-142", project)).toBe(true);
    });

    it("returns false for open issues", async () => {
      mockFetchJson(sampleJiraIssue);
      expect(await tracker.isCompleted("TT-142", project)).toBe(false);
    });

    it("returns true for Cancelled issues", async () => {
      mockFetchJson({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, status: { name: "Cancelled" } },
      });
      const result = await tracker.isCompleted("TT-142", project);
      expect(result).toBe(true);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("TT-42", project)).toBe(
        "https://acme.atlassian.net/browse/TT-42",
      );
    });
  });

  // ---- issueLabel --------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts issue key from URL", () => {
      expect(
        tracker.issueLabel!("https://acme.atlassian.net/browse/TT-42", project),
      ).toBe("TT-42");
    });

    it("returns URL when key cannot be extracted", () => {
      const url = "https://example.com/unknown";
      expect(tracker.issueLabel!(url, project)).toBe(url);
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("uses prefix without sprint when sprint not resolved", () => {
      expect(tracker.branchName("TT-42", project)).toBe("feat/TT-42");
    });

    it("includes sprint number after sprint is resolved", async () => {
      mockSprintResolution("Sprint 8");
      mockFetchJson(sampleJiraIssue);
      await tracker.getIssue("TT-42", project); // triggers sprint resolution
      expect(tracker.branchName("TT-42", project)).toBe("feat/Sprint8/TT-42");
    });

    it("uses custom branchPrefix", async () => {
      const customTracker = create({ ...pluginConfig, branchPrefix: "Agent" });
      mockSprintResolution("Sprint 12");
      mockFetchJson(sampleJiraIssue);
      await customTracker.getIssue("TT-42", project);
      expect(customTracker.branchName("TT-42", project)).toBe("Agent/Sprint12/TT-42");
    });

    it("falls back to prefix-only when no active sprint", async () => {
      mockSprintResolution(null);
      mockFetchJson(sampleJiraIssue);
      await tracker.getIssue("TT-42", project);
      expect(tracker.branchName("TT-42", project)).toBe("feat/TT-42");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title, URL, labels, and description", async () => {
      mockSprintResolution();
      mockFetchJson(sampleJiraIssue);
      const prompt = await tracker.generatePrompt("TT-142", project);
      expect(prompt).toContain("Fix login SSO bug");
      expect(prompt).toContain("https://acme.atlassian.net/browse/TT-142");
      expect(prompt).toContain("bug, sso");
      expect(prompt).toContain("Users cannot log in with SSO");
      expect(prompt).toContain("Jira issue TT-142");
    });

    it("omits labels when none", async () => {
      mockSprintResolution();
      mockFetchJson({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, labels: [] },
      });
      const prompt = await tracker.generatePrompt("TT-142", project);
      expect(prompt).not.toContain("Labels:");
    });

    it("omits description when null", async () => {
      mockSprintResolution();
      mockFetchJson({
        ...sampleJiraIssue,
        fields: { ...sampleJiraIssue.fields, description: null },
      });
      const prompt = await tracker.generatePrompt("TT-142", project);
      expect(prompt).not.toContain("## Description");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues from search", async () => {
      mockFetchJson({
        startAt: 0,
        maxResults: 50,
        total: 2,
        issues: [
          sampleJiraIssue,
          { ...sampleJiraIssue, key: "TT-143", fields: { ...sampleJiraIssue.fields, summary: "Another" } },
        ],
      });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("TT-142");
      expect(issues[1].id).toBe("TT-143");
    });

    it("uses custom JQL from config when provided", async () => {
      const customTracker = create({
        ...pluginConfig,
        jql: "project = TT AND status = 'To Do'",
      });
      mockFetchJson({ startAt: 0, maxResults: 50, total: 0, issues: [] });
      await customTracker.listIssues!({}, project);
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain("search/jql");
      expect(url).toContain("project");
      expect(url).toContain("TT");
      expect(url).toContain("To+Do");
    });

    it("builds JQL from filters when no custom JQL", async () => {
      mockFetchJson({ startAt: 0, maxResults: 50, total: 0, issues: [] });
      await tracker.listIssues!({ state: "open", labels: ["bug"] }, project);
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain("search/jql");
      expect(url).toContain("project");
      expect(url).toContain("%22TT%22");
      expect(url).toContain("%22bug%22");
    });

    it("respects limit", async () => {
      mockFetchJson({ startAt: 0, maxResults: 5, total: 0, issues: [] });
      await tracker.listIssues!({ limit: 5 }, project);
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain("maxResults=5");
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    it("transitions issue when state matches statusMap", async () => {
      mockFetchJson({
        transitions: [
          { id: "21", name: "In Progress" },
          { id: "31", name: "Done" },
        ],
      });
      mockFetch204();
      await tracker.updateIssue!("TT-142", { state: "in_progress" }, project);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(body.transition.id).toBe("21");
    });

    it("adds a comment", async () => {
      mockFetch204();
      await tracker.updateIssue!("TT-142", { comment: "Working on it" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.body.content[0].content[0].text).toBe("Working on it");
    });

    it("adds labels by merging with existing", async () => {
      mockFetchJson(sampleJiraIssue);
      mockFetch204();
      await tracker.updateIssue!("TT-142", { labels: ["new-label"] }, project);
      const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(body.fields.labels).toContain("bug");
      expect(body.fields.labels).toContain("sso");
      expect(body.fields.labels).toContain("new-label");
    });

    it("removes labels", async () => {
      mockFetchJson(sampleJiraIssue);
      mockFetch204();
      await tracker.updateIssue!("TT-142", { removeLabels: ["bug"] }, project);
      const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(body.fields.labels).toEqual(["sso"]);
    });

    it("throws when transition not found", async () => {
      mockFetchJson({ transitions: [{ id: "21", name: "In Progress" }] });
      await expect(
        tracker.updateIssue!("TT-142", { state: "closed" }, project),
      ).rejects.toThrow('Transition "Done" not found');
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates an issue and returns full details", async () => {
      mockFetchJson({ id: "10001", key: "TT-200" });
      // getIssue triggers sprint resolution
      mockSprintResolution();
      mockFetchJson({
        ...sampleJiraIssue,
        key: "TT-200",
        fields: { ...sampleJiraIssue.fields, summary: "New issue" },
      });

      const issue = await tracker.createIssue!(
        { title: "New issue", description: "desc" },
        project,
      );
      expect(issue.id).toBe("TT-200");
      expect(issue.title).toBe("New issue");
    });

    it("sends project key in fields", async () => {
      mockFetchJson({ id: "10001", key: "TT-201" });
      mockSprintResolution();
      mockFetchJson({ ...sampleJiraIssue, key: "TT-201" });

      await tracker.createIssue!(
        { title: "Test", description: "d" },
        project,
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.fields.project.key).toBe("TT");
    });

    it("includes labels when provided", async () => {
      mockFetchJson({ id: "10001", key: "TT-202" });
      mockSprintResolution();
      mockFetchJson({ ...sampleJiraIssue, key: "TT-202" });

      await tracker.createIssue!(
        { title: "Test", description: "d", labels: ["ai-agent"] },
        project,
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.fields.labels).toEqual(["ai-agent"]);
    });
  });
});
