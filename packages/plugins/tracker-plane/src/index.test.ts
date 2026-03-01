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
  tracker: { plugin: "plane", workspaceSlug: "acme", projectId: "proj-uuid" },
};

const sampleIssue = {
  id: "issue-uuid",
  sequence_id: 42,
  name: "Fix login bug",
  description_stripped: "Users cannot log in with SSO.",
  state: "state-uuid",
  state_detail: { id: "state-uuid", name: "In Progress", group: "started" },
  labels: [],
  label_detail: [{ id: "lbl-1", name: "bug" }],
  assignees: ["user-1"],
  assignee_detail: [{ id: "user-1", display_name: "Alice" }],
  priority: "high",
  project: "proj-uuid",
  workspace: "ws-uuid",
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

describe("tracker-plane plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("PLANE_HOST", "https://app.plane.so");
    vi.stubEnv("PLANE_API_TOKEN", "test-token");
    tracker = create();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("plane");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("default export", () => {
    it("is a valid PluginModule", () => {
      expect(pluginDefault.manifest.name).toBe("plane");
      expect(typeof pluginDefault.create).toBe("function");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("plane");
    });
  });

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockFetchOk(sampleIssue);
      const issue = await tracker.getIssue("issue-uuid", project);
      expect(issue.id).toBe("42");
      expect(issue.title).toBe("Fix login bug");
      expect(issue.state).toBe("in_progress");
      expect(issue.labels).toEqual(["bug"]);
      expect(issue.assignee).toBe("Alice");
      expect(issue.priority).toBe(2); // high
    });

    it("maps completed state to closed", async () => {
      mockFetchOk({
        ...sampleIssue,
        state_detail: { id: "s", name: "Done", group: "completed" },
      });
      const issue = await tracker.getIssue("issue-uuid", project);
      expect(issue.state).toBe("closed");
    });

    it("maps backlog state to open", async () => {
      mockFetchOk({
        ...sampleIssue,
        state_detail: { id: "s", name: "Backlog", group: "backlog" },
      });
      const issue = await tracker.getIssue("issue-uuid", project);
      expect(issue.state).toBe("open");
    });

    it("throws on API error", async () => {
      mockFetchError(404, "Not found");
      await expect(tracker.getIssue("uuid", project)).rejects.toThrow("returned 404");
    });
  });

  describe("isCompleted", () => {
    it("returns true when state is completed", async () => {
      mockFetchOk({
        ...sampleIssue,
        state_detail: { id: "s", name: "Done", group: "completed" },
      });
      expect(await tracker.isCompleted("issue-uuid", project)).toBe(true);
    });

    it("returns false when state is started", async () => {
      mockFetchOk(sampleIssue);
      expect(await tracker.isCompleted("issue-uuid", project)).toBe(false);
    });
  });

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("issue-uuid", project)).toBe(
        "https://app.plane.so/acme/projects/proj-uuid/issues/issue-uuid",
      );
    });
  });

  describe("issueLabel", () => {
    it("extracts short UUID from issue URL", () => {
      expect(
        tracker.issueLabel("https://app.plane.so/acme/projects/proj/issues/abcdef12-3456-7890-abcd-ef1234567890", project),
      ).toBe("abcdef12");
    });
  });

  describe("branchName", () => {
    it("generates correct branch name", () => {
      expect(tracker.branchName("42", project)).toBe("feat/plane-42");
    });
  });

  describe("generatePrompt", () => {
    it("includes title and description", async () => {
      mockFetchOk(sampleIssue);
      const prompt = await tracker.generatePrompt("issue-uuid", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("Users cannot log in with SSO.");
      expect(prompt).toContain("bug");
    });
  });

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      // First call: fetch states
      mockFetchOk([
        { id: "s1", name: "Open", group: "unstarted" },
        { id: "s2", name: "Done", group: "completed" },
      ]);
      // Second call: fetch issues
      mockFetchOk({ results: [sampleIssue] });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(1);
    });
  });

  describe("updateIssue", () => {
    it("updates state by finding matching state", async () => {
      mockFetchOk([
        { id: "s1", name: "Open", group: "unstarted" },
        { id: "s2", name: "Done", group: "completed" },
      ]);
      mockFetchOk({});
      await tracker.updateIssue!("issue-uuid", { state: "closed" }, project);
      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.state).toBe("s2");
    });

    it("adds a comment", async () => {
      mockFetchOk({});
      await tracker.updateIssue!("issue-uuid", { comment: "Working" }, project);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/comments/");
    });
  });

  describe("createIssue", () => {
    it("creates an issue", async () => {
      mockFetchOk(sampleIssue);
      const issue = await tracker.createIssue!(
        { title: "New bug", description: "Desc" },
        project,
      );
      expect(issue.id).toBe("42");
    });
  });

  describe("error handling", () => {
    it("throws when PLANE_HOST is missing", async () => {
      vi.stubEnv("PLANE_HOST", "");
      await expect(tracker.getIssue("uuid", project)).rejects.toThrow("PLANE_HOST");
    });

    it("throws when PLANE_API_TOKEN is missing", async () => {
      vi.stubEnv("PLANE_API_TOKEN", "");
      await expect(tracker.getIssue("uuid", project)).rejects.toThrow("PLANE_API_TOKEN");
    });

    it("throws when workspaceSlug is missing", async () => {
      const badProject = { ...project, tracker: { plugin: "plane" } } as ProjectConfig;
      await expect(tracker.getIssue("uuid", badProject)).rejects.toThrow("workspaceSlug");
    });
  });
});
