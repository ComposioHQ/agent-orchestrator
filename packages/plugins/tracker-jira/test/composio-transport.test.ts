import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @composio/core
// ---------------------------------------------------------------------------

const { mockExecute, MockComposio } = vi.hoisted(() => {
  const mockExecute = vi.fn();
  const MockComposio = vi.fn().mockImplementation(() => ({
    tools: { execute: mockExecute },
  }));
  return { mockExecute, MockComposio };
});

vi.mock("@composio/core", () => ({
  Composio: MockComposio,
}));

import { create } from "../src/index.js";
import type { ProjectConfig } from "@composio/ao-core";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockComposioResponse(data: unknown) {
  mockExecute.mockResolvedValueOnce({
    data,
    successful: true,
  });
}

function mockComposioError(error: string) {
  mockExecute.mockResolvedValueOnce({
    error,
    successful: false,
  });
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

let savedComposioKey: string | undefined;
let savedEntityId: string | undefined;
let savedJiraEmail: string | undefined;
let savedJiraToken: string | undefined;

function saveEnv() {
  savedComposioKey = process.env["COMPOSIO_API_KEY"];
  savedEntityId = process.env["COMPOSIO_ENTITY_ID"];
  savedJiraEmail = process.env["JIRA_EMAIL"];
  savedJiraToken = process.env["JIRA_API_TOKEN"];
}

function restoreEnv() {
  if (savedComposioKey === undefined) {
    delete process.env["COMPOSIO_API_KEY"];
  } else {
    process.env["COMPOSIO_API_KEY"] = savedComposioKey;
  }
  if (savedEntityId === undefined) {
    delete process.env["COMPOSIO_ENTITY_ID"];
  } else {
    process.env["COMPOSIO_ENTITY_ID"] = savedEntityId;
  }
  if (savedJiraEmail === undefined) {
    delete process.env["JIRA_EMAIL"];
  } else {
    process.env["JIRA_EMAIL"] = savedJiraEmail;
  }
  if (savedJiraToken === undefined) {
    delete process.env["JIRA_API_TOKEN"];
  } else {
    process.env["JIRA_API_TOKEN"] = savedJiraToken;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-jira Composio transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveEnv();
    // Set Composio key so auto-detection picks Composio transport
    process.env["COMPOSIO_API_KEY"] = "composio_test_key";
    delete process.env["JIRA_EMAIL"];
    delete process.env["JIRA_API_TOKEN"];
    delete process.env["COMPOSIO_ENTITY_ID"];
  });

  afterEach(() => {
    restoreEnv();
  });

  // ---- Transport auto-detection -------------------------------------------

  describe("transport auto-detection", () => {
    it("uses Composio transport when COMPOSIO_API_KEY is set", async () => {
      mockComposioResponse(sampleJiraIssue);
      const tracker = create();
      const issue = await tracker.getIssue("PROJ-123", project);

      expect(issue.id).toBe("PROJ-123");
      expect(MockComposio).toHaveBeenCalledWith({ apiKey: "composio_test_key" });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });

  // ---- Entity ID --------------------------------------------------------

  describe("entity ID", () => {
    it("defaults entity ID to 'default'", async () => {
      mockComposioResponse(sampleJiraIssue);
      const tracker = create();
      await tracker.getIssue("PROJ-123", project);

      expect(mockExecute).toHaveBeenCalledWith(
        "JIRA_GET_ISSUE",
        expect.objectContaining({ entityId: "default" }),
      );
    });

    it("uses COMPOSIO_ENTITY_ID env var when set", async () => {
      process.env["COMPOSIO_ENTITY_ID"] = "my-entity";
      mockComposioResponse(sampleJiraIssue);

      const tracker = create();
      await tracker.getIssue("PROJ-123", project);

      expect(mockExecute).toHaveBeenCalledWith(
        "JIRA_GET_ISSUE",
        expect.objectContaining({ entityId: "my-entity" }),
      );
    });
  });

  // ---- Successful queries -----------------------------------------------

  describe("successful queries", () => {
    it("returns correct Issue from getIssue", async () => {
      mockComposioResponse(sampleJiraIssue);
      const tracker = create();
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

    it("passes correct action and arguments for getIssue", async () => {
      mockComposioResponse(sampleJiraIssue);
      const tracker = create();
      await tracker.getIssue("PROJ-123", project);

      expect(mockExecute).toHaveBeenCalledWith("JIRA_GET_ISSUE", {
        entityId: "default",
        arguments: { issue_id_or_key: "PROJ-123" },
      });
    });

    it("works with isCompleted", async () => {
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
      mockComposioResponse(doneIssue);
      const tracker = create();
      const result = await tracker.isCompleted("PROJ-123", project);
      expect(result).toBe(true);
    });

    it("passes fields parameter for isCompleted", async () => {
      mockComposioResponse(sampleJiraIssue);
      const tracker = create();
      await tracker.isCompleted("PROJ-123", project);

      expect(mockExecute).toHaveBeenCalledWith("JIRA_GET_ISSUE", {
        entityId: "default",
        arguments: { issue_id_or_key: "PROJ-123", fields: "status" },
      });
    });

    it("works with listIssues", async () => {
      mockComposioResponse({
        issues: [sampleJiraIssue],
        total: 1,
        maxResults: 30,
        startAt: 0,
      });
      const tracker = create();
      const issues = await tracker.listIssues!({}, project);

      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("PROJ-123");
    });

    it("passes correct action for searchIssues", async () => {
      mockComposioResponse({
        issues: [],
        total: 0,
        maxResults: 30,
        startAt: 0,
      });
      const tracker = create();
      await tracker.listIssues!({}, project);

      expect(mockExecute).toHaveBeenCalledWith("JIRA_SEARCH_ISSUES", {
        entityId: "default",
        arguments: expect.objectContaining({
          jql: expect.stringContaining('project = "PROJ"'),
          max_results: 30,
        }),
      });
    });

    it("creates an issue via JIRA_CREATE_ISSUE", async () => {
      // First: create returns partial
      mockComposioResponse({ id: "10002", key: "PROJ-456", self: "..." });
      // Second: getIssue for full details
      mockComposioResponse({
        ...sampleJiraIssue,
        id: "10002",
        key: "PROJ-456",
        fields: { ...sampleJiraIssue.fields, summary: "New issue" },
      });

      const tracker = create();
      const issue = await tracker.createIssue!(
        { title: "New issue", description: "Desc" },
        project,
      );

      expect(issue.id).toBe("PROJ-456");
      expect(mockExecute).toHaveBeenCalledWith(
        "JIRA_CREATE_ISSUE",
        expect.objectContaining({
          arguments: expect.objectContaining({
            fields: expect.stringContaining('"summary":"New issue"'),
          }),
        }),
      );
    });

    it("transitions an issue via JIRA_GET_TRANSITIONS and JIRA_TRANSITION_ISSUE", async () => {
      // First: get transitions
      mockComposioResponse({
        transitions: [{ id: "31", name: "Done", to: { statusCategory: { key: "done" } } }],
      });
      // Second: perform transition
      mockComposioResponse({});

      const tracker = create();
      await tracker.updateIssue!("PROJ-123", { state: "closed" }, project);

      expect(mockExecute).toHaveBeenCalledWith("JIRA_GET_TRANSITIONS", {
        entityId: "default",
        arguments: { issue_id_or_key: "PROJ-123" },
      });
      expect(mockExecute).toHaveBeenCalledWith("JIRA_TRANSITION_ISSUE", {
        entityId: "default",
        arguments: { issue_id_or_key: "PROJ-123", transition_id: "31" },
      });
    });

    it("adds a comment via JIRA_ADD_COMMENT", async () => {
      mockComposioResponse({});
      const tracker = create();
      await tracker.updateIssue!("PROJ-123", { comment: "Hello" }, project);

      expect(mockExecute).toHaveBeenCalledWith("JIRA_ADD_COMMENT", {
        entityId: "default",
        arguments: expect.objectContaining({
          issue_id_or_key: "PROJ-123",
          body: expect.stringContaining("Hello"),
        }),
      });
    });
  });

  // ---- Error handling ---------------------------------------------------

  describe("error handling", () => {
    it("throws on unsuccessful response", async () => {
      mockComposioError("Authentication failed");
      const tracker = create();

      await expect(tracker.getIssue("PROJ-123", project)).rejects.toThrow(
        "Composio Jira API error: Authentication failed",
      );
    });

    it("throws with 'unknown error' when error field is missing", async () => {
      mockExecute.mockResolvedValueOnce({
        successful: false,
      });
      const tracker = create();

      await expect(tracker.getIssue("PROJ-123", project)).rejects.toThrow(
        "Composio Jira API error: unknown error",
      );
    });

    it("throws when response has no data", async () => {
      mockExecute.mockResolvedValueOnce({
        successful: true,
        data: undefined,
      });
      const tracker = create();

      await expect(tracker.getIssue("PROJ-123", project)).rejects.toThrow(
        "Composio Jira API returned no data",
      );
    });

    it("propagates execute rejections", async () => {
      mockExecute.mockRejectedValueOnce(new Error("Network error"));
      const tracker = create();

      await expect(tracker.getIssue("PROJ-123", project)).rejects.toThrow("Network error");
    });
  });

  // ---- Client caching ---------------------------------------------------

  describe("client caching", () => {
    it("creates Composio client only once across multiple queries", async () => {
      mockComposioResponse(sampleJiraIssue);
      mockComposioResponse(sampleJiraIssue);

      const tracker = create();
      await tracker.getIssue("PROJ-123", project);
      await tracker.isCompleted("PROJ-123", project);

      // Composio constructor should be called exactly once
      expect(MockComposio).toHaveBeenCalledTimes(1);
      // But execute should be called twice
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });
  });

  // ---- Timeout ----------------------------------------------------------

  describe("timeout", () => {
    it("times out after 30s", async () => {
      // Pre-warm the client so import() resolves before we switch to fake timers.
      mockComposioResponse(sampleJiraIssue);
      const tracker = create();
      await tracker.getIssue("PROJ-123", project);

      // Now switch to fake timers
      vi.useFakeTimers();

      // Suppress transient unhandled rejection from Promise.race timeout
      const suppressed: unknown[] = [];
      const handler = (reason: unknown) => {
        suppressed.push(reason);
      };
      process.on("unhandledRejection", handler);

      try {
        // Make execute hang forever
        mockExecute.mockImplementationOnce(
          () => new Promise(() => {}), // never resolves
        );

        const promise = tracker.getIssue("PROJ-123", project);

        // Advance timers past the 30s timeout
        await vi.advanceTimersByTimeAsync(30_001);

        await expect(promise).rejects.toThrow("Composio Jira API request timed out after 30s");
      } finally {
        process.removeListener("unhandledRejection", handler);
        vi.useRealTimers();
      }
    });
  });
});
