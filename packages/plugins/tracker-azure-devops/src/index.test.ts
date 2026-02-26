import { describe, it, expect, beforeEach, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

import pluginDefault, { create, manifest } from "./index.js";
import type { ProjectConfig } from "@composio/ao-core";

const project: ProjectConfig = {
  name: "test",
  repo: "MyProject/myrepo",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: { plugin: "azure-devops" },
};

const sampleWorkItem = {
  id: 123,
  rev: 1,
  fields: {
    "System.Title": "Fix login bug",
    "System.Description": "Users cannot log in with SSO.",
    "System.State": "Active",
    "System.Tags": "bug; high-priority",
    "System.AssignedTo": { displayName: "Alice Smith", uniqueName: "alice@org" },
    "Microsoft.VSTS.Common.Priority": 2,
    "System.WorkItemType": "Task",
  },
  url: "https://dev.azure.com/myorg/MyProject/_apis/wit/workitems/123",
  _links: { html: { href: "https://dev.azure.com/myorg/MyProject/_workitems/edit/123" } },
};

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

describe("tracker-azure-devops plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("AZURE_DEVOPS_PAT", "test-pat");
    vi.stubEnv("AZURE_DEVOPS_ORG", "myorg");
    tracker = create();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("azure-devops");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("default export", () => {
    it("is a valid PluginModule", () => {
      expect(pluginDefault.manifest.name).toBe("azure-devops");
      expect(typeof pluginDefault.create).toBe("function");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("azure-devops");
    });
  });

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockFetchOk(sampleWorkItem);
      const issue = await tracker.getIssue("123", project);
      expect(issue.id).toBe("123");
      expect(issue.title).toBe("Fix login bug");
      expect(issue.state).toBe("in_progress");
      expect(issue.labels).toEqual(["bug", "high-priority"]);
      expect(issue.assignee).toBe("Alice Smith");
      expect(issue.priority).toBe(2);
    });

    it("maps Done state to closed", async () => {
      mockFetchOk({
        ...sampleWorkItem,
        fields: { ...sampleWorkItem.fields, "System.State": "Done" },
      });
      const issue = await tracker.getIssue("123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps New state to open", async () => {
      mockFetchOk({
        ...sampleWorkItem,
        fields: { ...sampleWorkItem.fields, "System.State": "New" },
      });
      const issue = await tracker.getIssue("123", project);
      expect(issue.state).toBe("open");
    });

    it("throws on API error", async () => {
      mockFetchError(404, "Not found");
      await expect(tracker.getIssue("999", project)).rejects.toThrow("returned 404");
    });
  });

  describe("isCompleted", () => {
    it("returns true when state is Done", async () => {
      mockFetchOk({
        ...sampleWorkItem,
        fields: { ...sampleWorkItem.fields, "System.State": "Done" },
      });
      expect(await tracker.isCompleted("123", project)).toBe(true);
    });

    it("returns false when state is Active", async () => {
      mockFetchOk(sampleWorkItem);
      expect(await tracker.isCompleted("123", project)).toBe(false);
    });
  });

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("123", project)).toContain("_workitems/edit/123");
    });
  });

  describe("issueLabel", () => {
    it("extracts work item ID from URL", () => {
      expect(
        tracker.issueLabel("https://dev.azure.com/org/proj/_workitems/edit/123", project),
      ).toBe("#123");
    });
  });

  describe("branchName", () => {
    it("generates correct branch name", () => {
      expect(tracker.branchName("123", project)).toBe("feat/wi-123");
    });
  });

  describe("generatePrompt", () => {
    it("includes title and description", async () => {
      mockFetchOk(sampleWorkItem);
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("Users cannot log in with SSO.");
    });
  });

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      mockFetchOk({ workItems: [{ id: 123, url: "" }] });
      mockFetchOk({ value: [sampleWorkItem] });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("123");
    });

    it("returns empty array when no results", async () => {
      mockFetchOk({ workItems: [] });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toEqual([]);
    });

    it("filters by open state", async () => {
      mockFetchOk({ workItems: [] });
      await tracker.listIssues!({ state: "open" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.query).toContain("NOT IN");
    });

    it("filters by closed state", async () => {
      mockFetchOk({ workItems: [] });
      await tracker.listIssues!({ state: "closed" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.query).toContain("IN ('Done'");
    });
  });

  describe("updateIssue", () => {
    it("updates state to Closed", async () => {
      mockFetchOk({});
      await tracker.updateIssue!("123", { state: "closed" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body[0].value).toBe("Closed");
    });

    it("adds a comment", async () => {
      mockFetchOk({});
      await tracker.updateIssue!("123", { comment: "Working on it" }, project);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/comments");
    });
  });

  describe("createIssue", () => {
    it("creates a work item", async () => {
      mockFetchOk(sampleWorkItem);
      const issue = await tracker.createIssue!(
        { title: "New bug", description: "Description" },
        project,
      );
      expect(issue.id).toBe("123");
    });
  });

  describe("error handling", () => {
    it("throws when AZURE_DEVOPS_PAT is missing", async () => {
      vi.stubEnv("AZURE_DEVOPS_PAT", "");
      await expect(tracker.getIssue("123", project)).rejects.toThrow("AZURE_DEVOPS_PAT");
    });

    it("throws when AZURE_DEVOPS_ORG is missing", async () => {
      vi.stubEnv("AZURE_DEVOPS_ORG", "");
      await expect(tracker.getIssue("123", project)).rejects.toThrow("AZURE_DEVOPS_ORG");
    });
  });
});
