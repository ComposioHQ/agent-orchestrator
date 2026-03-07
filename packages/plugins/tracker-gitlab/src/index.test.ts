import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process (promisify symbol pattern)
// ---------------------------------------------------------------------------

const { glabMock } = vi.hoisted(() => ({ glabMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: glabMock,
  });
  return { execFile };
});

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
};

const sampleGitLabIssue = {
  iid: 42,
  title: "Fix login bug",
  description: "Users can't log in with SSO",
  web_url: "https://gitlab.com/acme/repo/-/issues/42",
  state: "opened",
  labels: ["bug", "high-priority"],
  assignees: [{ username: "alice" }],
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockGlab(data: unknown) {
  glabMock.mockResolvedValueOnce({ stdout: JSON.stringify(data) });
}

function mockGlabRaw(stdout: string) {
  glabMock.mockResolvedValueOnce({ stdout });
}

function mockGlabError(msg = "Command failed") {
  glabMock.mockRejectedValueOnce(new Error(msg));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-gitlab plugin", () => {
  let tracker: ReturnType<typeof create>;
  let savedHost: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedHost = process.env["GITLAB_HOST"];
    delete process.env["GITLAB_HOST"];
    tracker = create();
  });

  afterEach(() => {
    if (savedHost === undefined) {
      delete process.env["GITLAB_HOST"];
    } else {
      process.env["GITLAB_HOST"] = savedHost;
    }
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("gitlab");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
      expect(manifest.description).toBe("Tracker plugin: GitLab Issues");
    });
  });

  // ---- default export ----------------------------------------------------

  describe("default export", () => {
    it("is a valid PluginModule", () => {
      expect(pluginDefault).toHaveProperty("manifest");
      expect(pluginDefault).toHaveProperty("create");
      expect(pluginDefault.manifest.name).toBe("gitlab");
      expect(pluginDefault.manifest.slot).toBe("tracker");
      expect(typeof pluginDefault.create).toBe("function");
    });
  });

  // ---- create() ----------------------------------------------------------

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("gitlab");
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
      mockGlab(sampleGitLabIssue);
      const issue = await tracker.getIssue("42", project);
      expect(issue).toEqual({
        id: "42",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://gitlab.com/acme/repo/-/issues/42",
        state: "open",
        labels: ["bug", "high-priority"],
        assignee: "alice",
      });
    });

    it("calls glab with correct arguments", async () => {
      mockGlab(sampleGitLabIssue);
      await tracker.getIssue("42", project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        ["issue", "view", "42", "--repo", "acme/repo", "--output", "json"],
        expect.any(Object),
      );
    });

    it("maps 'closed' state to closed", async () => {
      mockGlab({ ...sampleGitLabIssue, state: "closed" });
      const issue = await tracker.getIssue("42", project);
      expect(issue.state).toBe("closed");
    });

    it("maps 'opened' state to open", async () => {
      mockGlab({ ...sampleGitLabIssue, state: "opened" });
      const issue = await tracker.getIssue("42", project);
      expect(issue.state).toBe("open");
    });

    it("handles null description", async () => {
      mockGlab({ ...sampleGitLabIssue, description: null });
      const issue = await tracker.getIssue("42", project);
      expect(issue.description).toBe("");
    });

    it("handles empty assignees", async () => {
      mockGlab({ ...sampleGitLabIssue, assignees: [] });
      const issue = await tracker.getIssue("42", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("handles null assignees", async () => {
      mockGlab({ ...sampleGitLabIssue, assignees: null });
      const issue = await tracker.getIssue("42", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("handles empty labels", async () => {
      mockGlab({ ...sampleGitLabIssue, labels: [] });
      const issue = await tracker.getIssue("42", project);
      expect(issue.labels).toEqual([]);
    });

    it("propagates glab CLI errors", async () => {
      mockGlabError("issue not found");
      await expect(tracker.getIssue("999", project)).rejects.toThrow(
        "glab issue view 999 failed",
      );
    });

    it("throws on malformed JSON response", async () => {
      mockGlabRaw("not json{");
      await expect(tracker.getIssue("42", project)).rejects.toThrow(
        "Failed to parse glab output",
      );
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true for closed state", async () => {
      mockGlab({ state: "closed" });
      expect(await tracker.isCompleted("42", project)).toBe(true);
    });

    it("returns false for opened state", async () => {
      mockGlab({ state: "opened" });
      expect(await tracker.isCompleted("42", project)).toBe(false);
    });

    it("handles case-insensitive state", async () => {
      mockGlab({ state: "CLOSED" });
      expect(await tracker.isCompleted("42", project)).toBe(true);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates correct URL with default gitlab.com host", () => {
      expect(tracker.issueUrl("42", project)).toBe(
        "https://gitlab.com/acme/repo/-/issues/42",
      );
    });

    it("uses custom GITLAB_HOST env var", () => {
      process.env["GITLAB_HOST"] = "https://gitlab.example.com";
      expect(tracker.issueUrl("42", project)).toBe(
        "https://gitlab.example.com/acme/repo/-/issues/42",
      );
    });

    it("strips trailing slashes from host", () => {
      process.env["GITLAB_HOST"] = "https://gitlab.example.com///";
      expect(tracker.issueUrl("42", project)).toBe(
        "https://gitlab.example.com/acme/repo/-/issues/42",
      );
    });
  });

  // ---- issueLabel --------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts issue IID from GitLab URL", () => {
      expect(
        tracker.issueLabel("https://gitlab.com/acme/repo/-/issues/42", project),
      ).toBe("#42");
    });

    it("falls back to last path segment with # prefix", () => {
      expect(
        tracker.issueLabel("https://gitlab.example.com/some/path/99", project),
      ).toBe("#99");
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("generates feat/issue-N format", () => {
      expect(tracker.branchName("42", project)).toBe("feat/issue-42");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title, URL, and description", async () => {
      mockGlab(sampleGitLabIssue);
      const prompt = await tracker.generatePrompt("42", project);
      expect(prompt).toContain("#42");
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("https://gitlab.com/acme/repo/-/issues/42");
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("includes labels when present", async () => {
      mockGlab(sampleGitLabIssue);
      const prompt = await tracker.generatePrompt("42", project);
      expect(prompt).toContain("bug, high-priority");
    });

    it("omits labels when empty", async () => {
      mockGlab({ ...sampleGitLabIssue, labels: [] });
      const prompt = await tracker.generatePrompt("42", project);
      expect(prompt).not.toContain("Labels:");
    });

    it("omits description when empty", async () => {
      mockGlab({ ...sampleGitLabIssue, description: "" });
      const prompt = await tracker.generatePrompt("42", project);
      expect(prompt).not.toContain("## Description");
    });

    it("includes implementation instruction", async () => {
      mockGlab(sampleGitLabIssue);
      const prompt = await tracker.generatePrompt("42", project);
      expect(prompt).toContain("Please implement the changes");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      mockGlab([
        sampleGitLabIssue,
        { ...sampleGitLabIssue, iid: 43, title: "Another" },
      ]);
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("42");
      expect(issues[1].id).toBe("43");
    });

    it("passes --closed flag for closed state", async () => {
      mockGlab([]);
      await tracker.listIssues!({ state: "closed" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["--closed"]),
        expect.any(Object),
      );
    });

    it("passes --all flag for all state", async () => {
      mockGlab([]);
      await tracker.listIssues!({ state: "all" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["--all"]),
        expect.any(Object),
      );
    });

    it("defaults to open state (no extra flag)", async () => {
      mockGlab([]);
      await tracker.listIssues!({}, project);
      const args = glabMock.mock.calls[0][1];
      expect(args).not.toContain("--closed");
      expect(args).not.toContain("--all");
    });

    it("passes label filter", async () => {
      mockGlab([]);
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["--label", "bug,urgent"]),
        expect.any(Object),
      );
    });

    it("passes assignee filter", async () => {
      mockGlab([]);
      await tracker.listIssues!({ assignee: "alice" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["--assignee", "alice"]),
        expect.any(Object),
      );
    });

    it("respects custom limit", async () => {
      mockGlab([]);
      await tracker.listIssues!({ limit: 5 }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["--per-page", "5"]),
        expect.any(Object),
      );
    });

    it("defaults limit to 30", async () => {
      mockGlab([]);
      await tracker.listIssues!({}, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["--per-page", "30"]),
        expect.any(Object),
      );
    });

    it("throws on malformed JSON from glab", async () => {
      mockGlabRaw("not valid json");
      await expect(tracker.listIssues!({}, project)).rejects.toThrow(
        "Failed to parse glab issue list output",
      );
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    it("closes an issue", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("42", { state: "closed" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        ["issue", "close", "42", "--repo", "acme/repo"],
        expect.any(Object),
      );
    });

    it("reopens an issue", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("42", { state: "open" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        ["issue", "reopen", "42", "--repo", "acme/repo"],
        expect.any(Object),
      );
    });

    it("updates labels", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("42", { labels: ["bug", "urgent"] }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        ["issue", "update", "42", "--repo", "acme/repo", "--label", "bug,urgent"],
        expect.any(Object),
      );
    });

    it("updates assignee", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("42", { assignee: "bob" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        ["issue", "update", "42", "--repo", "acme/repo", "--assignee", "bob"],
        expect.any(Object),
      );
    });

    it("adds a comment", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("42", { comment: "Working on this" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        ["issue", "note", "42", "--repo", "acme/repo", "--message", "Working on this"],
        expect.any(Object),
      );
    });

    it("handles multiple updates in one call", async () => {
      glabMock.mockResolvedValue({ stdout: "" });
      await tracker.updateIssue!(
        "42",
        { state: "closed", labels: ["done"], comment: "Done!" },
        project,
      );
      // Should have called glab 3 times: close + update labels + note
      expect(glabMock).toHaveBeenCalledTimes(3);
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates an issue and fetches full details", async () => {
      // 1: glab issue create outputs URL with IID
      mockGlabRaw("https://gitlab.com/acme/repo/-/issues/99\n");
      // 2: getIssue fetches the created issue
      mockGlab({
        ...sampleGitLabIssue,
        iid: 99,
        title: "New issue",
        web_url: "https://gitlab.com/acme/repo/-/issues/99",
      });

      const issue = await tracker.createIssue!(
        { title: "New issue", description: "Description" },
        project,
      );
      expect(issue).toMatchObject({ id: "99", title: "New issue" });
    });

    it("passes labels and assignee to glab issue create", async () => {
      mockGlabRaw("https://gitlab.com/acme/repo/-/issues/100\n");
      mockGlab({ ...sampleGitLabIssue, iid: 100 });

      await tracker.createIssue!(
        { title: "Bug", description: "Crash", labels: ["bug"], assignee: "alice" },
        project,
      );
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining([
          "issue",
          "create",
          "--label",
          "bug",
          "--assignee",
          "alice",
        ]),
        expect.any(Object),
      );
    });

    it("throws when URL cannot be parsed from glab output", async () => {
      mockGlabRaw("unexpected output");
      await expect(
        tracker.createIssue!({ title: "Test", description: "" }, project),
      ).rejects.toThrow("Failed to parse issue IID");
    });

    it("creates issue without labels/assignee when not provided", async () => {
      mockGlabRaw("https://gitlab.com/acme/repo/-/issues/101\n");
      mockGlab({ ...sampleGitLabIssue, iid: 101 });

      await tracker.createIssue!(
        { title: "Simple issue", description: "Desc" },
        project,
      );
      const args = glabMock.mock.calls[0][1];
      expect(args).not.toContain("--label");
      expect(args).not.toContain("--assignee");
    });
  });

  // ---- glab error handling -----------------------------------------------

  describe("glab error handling", () => {
    it("wraps glab CLI errors with context", async () => {
      mockGlabError("exit code 1");
      await expect(tracker.getIssue("42", project)).rejects.toThrow(
        "glab issue view 42 failed",
      );
    });
  });
});
