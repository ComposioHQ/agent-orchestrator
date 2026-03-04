import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProjectConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------
const ENV_BACKUP: Record<string, string | undefined> = {};

function setJiraEnv(): void {
  process.env["JIRA_BASE_URL"] = "https://test.atlassian.net";
  process.env["JIRA_EMAIL"] = "user@test.com";
  process.env["JIRA_API_TOKEN"] = "test-token-123";
}

beforeEach(() => {
  vi.resetAllMocks();
  // Save env
  ENV_BACKUP["JIRA_BASE_URL"] = process.env["JIRA_BASE_URL"];
  ENV_BACKUP["JIRA_EMAIL"] = process.env["JIRA_EMAIL"];
  ENV_BACKUP["JIRA_API_TOKEN"] = process.env["JIRA_API_TOKEN"];
  setJiraEnv();

  // Mock global fetch
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  // Restore env
  for (const [key, val] of Object.entries(ENV_BACKUP)) {
    if (val === undefined) {
      process.env[key] = "";
    } else {
      process.env[key] = val;
    }
  }
  vi.unstubAllGlobals();
});

import { create, manifest, default as defaultExport } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "test-project",
    repo: "owner/repo",
    path: "/workspace/repo",
    defaultBranch: "main",
    sessionPrefix: "tp",
    tracker: { plugin: "jira", projectKey: "PROJ" },
    ...overrides,
  };
}

function mockResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response;
}

function makeJiraIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "PROJ-42",
    fields: {
      summary: "Fix the login bug",
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Users cannot log in with SSO." }],
          },
        ],
      },
      status: { name: "To Do", statusCategory: { key: "new" } },
      labels: ["bug", "auth"],
      assignee: { displayName: "Alice", emailAddress: "alice@test.com" },
      priority: { id: "2", name: "High" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("tracker-jira plugin", () => {
  // -------------------------------------------------------------------------
  // Manifest & exports
  // -------------------------------------------------------------------------
  describe("manifest", () => {
    it("has correct name and slot", () => {
      expect(manifest.name).toBe("jira");
      expect(manifest.slot).toBe("tracker");
    });

    it("default export satisfies PluginModule shape", () => {
      expect(defaultExport.manifest).toBe(manifest);
      expect(typeof defaultExport.create).toBe("function");
    });
  });

  describe("create()", () => {
    it("returns a tracker with correct name", () => {
      const tracker = create();
      expect(tracker.name).toBe("jira");
    });
  });

  // -------------------------------------------------------------------------
  // Environment validation
  // -------------------------------------------------------------------------
  describe("environment validation", () => {
    it("throws when JIRA_BASE_URL is missing", async () => {
      delete process.env["JIRA_BASE_URL"];
      const tracker = create();
      await expect(tracker.getIssue("PROJ-1", makeProject())).rejects.toThrow(
        "JIRA_BASE_URL",
      );
    });

    it("throws when JIRA_EMAIL is missing", async () => {
      delete process.env["JIRA_EMAIL"];
      const tracker = create();
      await expect(tracker.getIssue("PROJ-1", makeProject())).rejects.toThrow(
        "JIRA_EMAIL",
      );
    });

    it("throws when JIRA_API_TOKEN is missing", async () => {
      delete process.env["JIRA_API_TOKEN"];
      const tracker = create();
      await expect(tracker.getIssue("PROJ-1", makeProject())).rejects.toThrow(
        "JIRA_API_TOKEN",
      );
    });
  });

  // -------------------------------------------------------------------------
  // getIssue
  // -------------------------------------------------------------------------
  describe("getIssue", () => {
    it("fetches and maps a Jira issue", async () => {
      mockFetch.mockResolvedValue(mockResponse(makeJiraIssue()));
      const tracker = create();
      const issue = await tracker.getIssue("PROJ-42", makeProject());

      expect(issue.id).toBe("PROJ-42");
      expect(issue.title).toBe("Fix the login bug");
      expect(issue.description).toBe("Users cannot log in with SSO.");
      expect(issue.url).toBe("https://test.atlassian.net/browse/PROJ-42");
      expect(issue.state).toBe("open");
      expect(issue.labels).toEqual(["bug", "auth"]);
      expect(issue.assignee).toBe("Alice");
      expect(issue.priority).toBe(2);
    });

    it("maps done status category to closed", async () => {
      const jiraIssue = makeJiraIssue();
      (jiraIssue["fields"] as Record<string, unknown>)["status"] = {
        name: "Done",
        statusCategory: { key: "done" },
      };
      mockFetch.mockResolvedValue(mockResponse(jiraIssue));
      const tracker = create();
      const issue = await tracker.getIssue("PROJ-42", makeProject());
      expect(issue.state).toBe("closed");
    });

    it("maps indeterminate status category to in_progress", async () => {
      const jiraIssue = makeJiraIssue();
      (jiraIssue["fields"] as Record<string, unknown>)["status"] = {
        name: "In Progress",
        statusCategory: { key: "indeterminate" },
      };
      mockFetch.mockResolvedValue(mockResponse(jiraIssue));
      const tracker = create();
      const issue = await tracker.getIssue("PROJ-42", makeProject());
      expect(issue.state).toBe("in_progress");
    });

    it("handles null description", async () => {
      const jiraIssue = makeJiraIssue();
      (jiraIssue["fields"] as Record<string, unknown>)["description"] = null;
      mockFetch.mockResolvedValue(mockResponse(jiraIssue));
      const tracker = create();
      const issue = await tracker.getIssue("PROJ-42", makeProject());
      expect(issue.description).toBe("");
    });

    it("throws on API error", async () => {
      mockFetch.mockResolvedValue(mockResponse("Not found", 404));
      const tracker = create();
      await expect(tracker.getIssue("PROJ-999", makeProject())).rejects.toThrow("404");
    });

    it("sends correct authorization header", async () => {
      mockFetch.mockResolvedValue(mockResponse(makeJiraIssue()));
      const tracker = create();
      await tracker.getIssue("PROJ-42", makeProject());

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/rest/api/3/issue/PROJ-42");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toMatch(/^Basic /)
      expect(init.method).toBe("GET");
    });
  });

  // -------------------------------------------------------------------------
  // isCompleted
  // -------------------------------------------------------------------------
  describe("isCompleted", () => {
    it("returns true for done issues", async () => {
      const jiraIssue = makeJiraIssue();
      (jiraIssue["fields"] as Record<string, unknown>)["status"] = {
        name: "Done",
        statusCategory: { key: "done" },
      };
      mockFetch.mockResolvedValue(mockResponse(jiraIssue));
      const tracker = create();
      expect(await tracker.isCompleted("PROJ-42", makeProject())).toBe(true);
    });

    it("returns false for open issues", async () => {
      mockFetch.mockResolvedValue(mockResponse(makeJiraIssue()));
      const tracker = create();
      expect(await tracker.isCompleted("PROJ-42", makeProject())).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // issueUrl
  // -------------------------------------------------------------------------
  describe("issueUrl", () => {
    it("generates correct Jira URL", () => {
      const tracker = create();
      const url = tracker.issueUrl("PROJ-42", makeProject());
      expect(url).toBe("https://test.atlassian.net/browse/PROJ-42");
    });
  });

  // -------------------------------------------------------------------------
  // issueLabel
  // -------------------------------------------------------------------------
  describe("issueLabel", () => {
    it("extracts key from Jira URL", () => {
      const tracker = create();
      const label = tracker.issueLabel!(
        "https://test.atlassian.net/browse/PROJ-42",
        makeProject(),
      );
      expect(label).toBe("PROJ-42");
    });

    it("handles fallback for non-standard URLs", () => {
      const tracker = create();
      const label = tracker.issueLabel!(
        "https://test.atlassian.net/something/PROJ-42",
        makeProject(),
      );
      expect(label).toBe("PROJ-42");
    });
  });

  // -------------------------------------------------------------------------
  // branchName
  // -------------------------------------------------------------------------
  describe("branchName", () => {
    it("generates feat/ prefix branch name", () => {
      const tracker = create();
      expect(tracker.branchName("PROJ-42", makeProject())).toBe("feat/PROJ-42");
    });
  });

  // -------------------------------------------------------------------------
  // generatePrompt
  // -------------------------------------------------------------------------
  describe("generatePrompt", () => {
    it("generates a prompt with issue details", async () => {
      mockFetch.mockResolvedValue(mockResponse(makeJiraIssue()));
      const tracker = create();
      const prompt = await tracker.generatePrompt("PROJ-42", makeProject());

      expect(prompt).toContain("Jira issue PROJ-42");
      expect(prompt).toContain("Fix the login bug");
      expect(prompt).toContain("Users cannot log in with SSO.");
      expect(prompt).toContain("bug, auth");
    });
  });

  // -------------------------------------------------------------------------
  // listIssues
  // -------------------------------------------------------------------------
  describe("listIssues", () => {
    it("searches with JQL and returns mapped issues", async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ issues: [makeJiraIssue()] }),
      );
      const tracker = create();
      const issues = await tracker.listIssues!({ state: "open" }, makeProject());

      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("PROJ-42");

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("jql=");
      expect(url).toContain("statusCategory");
    });

    it("filters by closed state", async () => {
      mockFetch.mockResolvedValue(mockResponse({ issues: [] }));
      const tracker = create();
      await tracker.listIssues!({ state: "closed" }, makeProject());

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(decodeURIComponent(url)).toContain("statusCategory = Done");
    });

    it("filters by labels", async () => {
      mockFetch.mockResolvedValue(mockResponse({ issues: [] }));
      const tracker = create();
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, makeProject());

      const [url] = mockFetch.mock.calls[0] as [string];
      const decoded = decodeURIComponent(url);
      expect(decoded).toContain('labels = "bug"');
      expect(decoded).toContain('labels = "urgent"');
    });

    it("filters by assignee", async () => {
      mockFetch.mockResolvedValue(mockResponse({ issues: [] }));
      const tracker = create();
      await tracker.listIssues!({ assignee: "alice" }, makeProject());

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(decodeURIComponent(url)).toContain('assignee = "alice"');
    });

    it("respects limit", async () => {
      mockFetch.mockResolvedValue(mockResponse({ issues: [] }));
      const tracker = create();
      await tracker.listIssues!({ limit: 5 }, makeProject());

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("maxResults=5");
    });

    it("throws when projectKey is missing", async () => {
      const tracker = create();
      const project = makeProject({ tracker: { plugin: "jira" } });
      await expect(tracker.listIssues!({}, project)).rejects.toThrow("projectKey");
    });
  });

  // -------------------------------------------------------------------------
  // updateIssue
  // -------------------------------------------------------------------------
  describe("updateIssue", () => {
    it("transitions issue to closed state", async () => {
      // First call: get transitions
      mockFetch
        .mockResolvedValueOnce(
          mockResponse({
            transitions: [
              { id: "31", name: "Done", to: { statusCategory: { key: "done" } } },
              { id: "21", name: "In Progress", to: { statusCategory: { key: "indeterminate" } } },
            ],
          }),
        )
        // Second call: perform transition
        .mockResolvedValueOnce(mockResponse(null, 204));

      const tracker = create();
      await tracker.updateIssue!("PROJ-42", { state: "closed" }, makeProject());

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [, transitionInit] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(transitionInit.method).toBe("POST");
      expect(JSON.parse(transitionInit.body as string)).toEqual({
        transition: { id: "31" },
      });
    });

    it("throws when no matching transition is found", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          transitions: [
            { id: "21", name: "In Progress", to: { statusCategory: { key: "indeterminate" } } },
          ],
        }),
      );

      const tracker = create();
      await expect(
        tracker.updateIssue!("PROJ-42", { state: "closed" }, makeProject()),
      ).rejects.toThrow(/No Jira transition found/);
    });

    it("adds labels to issue", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null, 204));
      const tracker = create();
      await tracker.updateIssue!("PROJ-42", { labels: ["reviewed"] }, makeProject());

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body as string)).toEqual({
        update: { labels: [{ add: "reviewed" }] },
      });
    });

    it("adds a comment", async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ id: "10001" }));
      const tracker = create();
      await tracker.updateIssue!("PROJ-42", { comment: "Working on it" }, makeProject());

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/comment");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.body.content[0].content[0].text).toBe("Working on it");
    });
  });

  // -------------------------------------------------------------------------
  // createIssue
  // -------------------------------------------------------------------------
  describe("createIssue", () => {
    it("creates a new issue and fetches it back", async () => {
      // First call: create issue (returns key)
      mockFetch
        .mockResolvedValueOnce(mockResponse({ key: "PROJ-99" }))
        // Second call: get the created issue
        .mockResolvedValueOnce(
          mockResponse(
            makeJiraIssue({
              key: "PROJ-99",
              fields: {
                summary: "New feature",
                description: null,
                status: { name: "To Do", statusCategory: { key: "new" } },
                labels: [],
                assignee: null,
                priority: null,
              },
            }),
          ),
        );

      const tracker = create();
      const issue = await tracker.createIssue!(
        { title: "New feature", description: "Build it" },
        makeProject(),
      );

      expect(issue.id).toBe("PROJ-99");
      expect(issue.title).toBe("New feature");

      // Verify create call
      const [, createInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(createInit.method).toBe("POST");
      const body = JSON.parse(createInit.body as string);
      expect(body.fields.project.key).toBe("PROJ");
      expect(body.fields.summary).toBe("New feature");
    });

    it("includes labels and assignee in creation", async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ key: "PROJ-100" }))
        .mockResolvedValueOnce(mockResponse(makeJiraIssue({ key: "PROJ-100" })));

      const tracker = create();
      await tracker.createIssue!(
        { title: "Task", description: "Do it", labels: ["urgent"], assignee: "bob" },
        makeProject(),
      );

      const [, createInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(createInit.body as string);
      expect(body.fields.labels).toEqual(["urgent"]);
      expect(body.fields.assignee).toEqual({ accountId: "bob" });
    });
  });

  // -------------------------------------------------------------------------
  // ADF parsing
  // -------------------------------------------------------------------------
  describe("ADF to plain text", () => {
    it("handles nested list content", async () => {
      const jiraIssue = makeJiraIssue();
      (jiraIssue["fields"] as Record<string, unknown>)["description"] = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "First item" }],
                  },
                ],
              },
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Second item" }],
                  },
                ],
              },
            ],
          },
        ],
      };
      mockFetch.mockResolvedValue(mockResponse(jiraIssue));
      const tracker = create();
      const issue = await tracker.getIssue("PROJ-42", makeProject());
      expect(issue.description).toContain("First item");
      expect(issue.description).toContain("Second item");
    });

    it("handles code blocks", async () => {
      const jiraIssue = makeJiraIssue();
      (jiraIssue["fields"] as Record<string, unknown>)["description"] = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "codeBlock",
            content: [{ type: "text", text: "const x = 42;" }],
          },
        ],
      };
      mockFetch.mockResolvedValue(mockResponse(jiraIssue));
      const tracker = create();
      const issue = await tracker.getIssue("PROJ-42", makeProject());
      expect(issue.description).toContain("const x = 42;");
    });
  });
});
