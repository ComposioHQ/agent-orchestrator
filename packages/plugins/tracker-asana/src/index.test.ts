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
  tracker: {
    plugin: "asana",
    projectGid: "1234567890",
  },
};

const sampleTask = {
  gid: "111222333",
  name: "Fix login bug",
  notes: "Users cannot log in with SSO.",
  completed: false,
  assignee: { gid: "user1", name: "Alice Smith" },
  tags: [{ gid: "tag1", name: "bug" }, { gid: "tag2", name: "high-priority" }],
  memberships: [],
  permalink_url: "https://app.asana.com/0/0/111222333/f",
  custom_fields: [],
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

describe("tracker-asana plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ASANA_ACCESS_TOKEN", "test-token");
    vi.stubEnv("ASANA_WORKSPACE_GID", "workspace-gid");
    tracker = create();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("asana");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("default export", () => {
    it("is a valid PluginModule", () => {
      expect(pluginDefault.manifest.name).toBe("asana");
      expect(typeof pluginDefault.create).toBe("function");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("asana");
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

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockFetchOk({ data: sampleTask });
      const issue = await tracker.getIssue("111222333", project);
      expect(issue.id).toBe("111222333");
      expect(issue.title).toBe("Fix login bug");
      expect(issue.description).toBe("Users cannot log in with SSO.");
      expect(issue.state).toBe("open");
      expect(issue.labels).toEqual(["bug", "high-priority"]);
      expect(issue.assignee).toBe("Alice Smith");
    });

    it("maps completed task to closed state", async () => {
      mockFetchOk({ data: { ...sampleTask, completed: true } });
      const issue = await tracker.getIssue("111222333", project);
      expect(issue.state).toBe("closed");
    });

    it("throws on API error", async () => {
      mockFetchError(404, "Not found");
      await expect(tracker.getIssue("999", project)).rejects.toThrow("returned 404");
    });
  });

  describe("isCompleted", () => {
    it("returns true when task is completed", async () => {
      mockFetchOk({ data: { completed: true } });
      expect(await tracker.isCompleted("111222333", project)).toBe(true);
    });

    it("returns false when task is not completed", async () => {
      mockFetchOk({ data: { completed: false } });
      expect(await tracker.isCompleted("111222333", project)).toBe(false);
    });
  });

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("111222333", project)).toBe(
        "https://app.asana.com/0/0/111222333/f",
      );
    });
  });

  describe("issueLabel", () => {
    it("extracts task GID from standard URL", () => {
      expect(tracker.issueLabel("https://app.asana.com/0/0/111222333/f", project)).toBe("111222333");
    });
  });

  describe("branchName", () => {
    it("generates correct branch name", () => {
      expect(tracker.branchName("111222333", project)).toBe("feat/asana-111222333");
    });
  });

  describe("generatePrompt", () => {
    it("includes title and description", async () => {
      mockFetchOk({ data: sampleTask });
      const prompt = await tracker.generatePrompt("111222333", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("Users cannot log in with SSO.");
      expect(prompt).toContain("bug, high-priority");
    });
  });

  describe("listIssues", () => {
    it("returns mapped issues from project", async () => {
      mockFetchOk({ data: [sampleTask] });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("111222333");
    });
  });

  describe("updateIssue", () => {
    it("updates task state to closed", async () => {
      mockFetchOk({ data: {} });
      await tracker.updateIssue!("111222333", { state: "closed" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.data.completed).toBe(true);
    });

    it("adds a comment as a story", async () => {
      mockFetchOk({ data: {} });
      await tracker.updateIssue!("111222333", { comment: "Working on it" }, project);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/stories");
    });
  });

  describe("createIssue", () => {
    it("creates a task and returns issue", async () => {
      mockFetchOk({ data: sampleTask });
      const issue = await tracker.createIssue!(
        { title: "New bug", description: "Description" },
        project,
      );
      expect(issue.id).toBe("111222333");
    });
  });

  describe("error handling", () => {
    it("throws when ASANA_ACCESS_TOKEN is missing", async () => {
      vi.stubEnv("ASANA_ACCESS_TOKEN", "");
      await expect(tracker.getIssue("111222333", project)).rejects.toThrow(
        "ASANA_ACCESS_TOKEN",
      );
    });
  });
});
