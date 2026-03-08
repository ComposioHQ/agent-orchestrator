import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------
const { glabMock } = vi.hoisted(() => ({ glabMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: glabMock,
  });
  return { execFile };
});

import { create, manifest, default as defaultExport } from "./index.js";
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

function mockGlab(result: unknown) {
  glabMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

function mockGlabRaw(stdout: string) {
  glabMock.mockResolvedValueOnce({ stdout });
}

function mockGlabError(msg = "Command failed") {
  glabMock.mockRejectedValueOnce(new Error(msg));
}

const sampleIssue = {
  iid: 42,
  title: "Fix login bug",
  description: "Users can't log in with SSO",
  state: "opened",
  labels: ["bug", "priority-high"],
  assignees: [{ username: "alice" }],
  web_url: "https://gitlab.com/acme/repo/-/issues/42",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-gitlab plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.resetAllMocks();
    tracker = create();
  });

  // -------------------------------------------------------------------------
  // Manifest & exports
  // -------------------------------------------------------------------------
  describe("manifest", () => {
    it("has correct name and slot", () => {
      expect(manifest.name).toBe("gitlab");
      expect(manifest.slot).toBe("tracker");
    });

    it("default export satisfies PluginModule shape", () => {
      expect(defaultExport.manifest).toBe(manifest);
      expect(typeof defaultExport.create).toBe("function");
    });
  });

  describe("create()", () => {
    it("returns a tracker with correct name", () => {
      expect(tracker.name).toBe("gitlab");
    });
  });

  // -------------------------------------------------------------------------
  // getIssue
  // -------------------------------------------------------------------------
  describe("getIssue", () => {
    it("fetches and maps a GitLab issue", async () => {
      mockGlab(sampleIssue);
      const issue = await tracker.getIssue("42", project);

      expect(issue.id).toBe("42");
      expect(issue.title).toBe("Fix login bug");
      expect(issue.description).toBe("Users can't log in with SSO");
      expect(issue.url).toBe("https://gitlab.com/acme/repo/-/issues/42");
      expect(issue.state).toBe("open");
      expect(issue.labels).toEqual(["bug", "priority-high"]);
      expect(issue.assignee).toBe("alice");
    });

    it("strips # prefix from identifier", async () => {
      mockGlab(sampleIssue);
      await tracker.getIssue("#42", project);

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("42");
    });

    it("maps closed state", async () => {
      mockGlab({ ...sampleIssue, state: "closed" });
      const issue = await tracker.getIssue("42", project);
      expect(issue.state).toBe("closed");
    });

    it("handles null description", async () => {
      mockGlab({ ...sampleIssue, description: null });
      const issue = await tracker.getIssue("42", project);
      expect(issue.description).toBe("");
    });

    it("throws on glab error", async () => {
      mockGlabError("not found");
      await expect(tracker.getIssue("999", project)).rejects.toThrow("glab");
    });
  });

  // -------------------------------------------------------------------------
  // isCompleted
  // -------------------------------------------------------------------------
  describe("isCompleted", () => {
    it("returns true for closed issues", async () => {
      mockGlab({ ...sampleIssue, state: "closed" });
      expect(await tracker.isCompleted("42", project)).toBe(true);
    });

    it("returns false for open issues", async () => {
      mockGlab(sampleIssue);
      expect(await tracker.isCompleted("42", project)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // issueUrl
  // -------------------------------------------------------------------------
  describe("issueUrl", () => {
    it("generates correct GitLab URL", () => {
      expect(tracker.issueUrl("42", project)).toBe(
        "https://gitlab.com/acme/repo/-/issues/42",
      );
    });

    it("strips # prefix", () => {
      expect(tracker.issueUrl("#42", project)).toBe(
        "https://gitlab.com/acme/repo/-/issues/42",
      );
    });
  });

  // -------------------------------------------------------------------------
  // issueLabel
  // -------------------------------------------------------------------------
  describe("issueLabel", () => {
    it("extracts number from GitLab URL", () => {
      expect(
        tracker.issueLabel!("https://gitlab.com/acme/repo/-/issues/42", project),
      ).toBe("#42");
    });

    it("handles fallback for non-standard URLs", () => {
      expect(
        tracker.issueLabel!("https://gitlab.com/acme/repo/42", project),
      ).toBe("#42");
    });
  });

  // -------------------------------------------------------------------------
  // branchName
  // -------------------------------------------------------------------------
  describe("branchName", () => {
    it("generates feat/issue-N branch name", () => {
      expect(tracker.branchName("42", project)).toBe("feat/issue-42");
    });

    it("strips # prefix", () => {
      expect(tracker.branchName("#42", project)).toBe("feat/issue-42");
    });
  });

  // -------------------------------------------------------------------------
  // generatePrompt
  // -------------------------------------------------------------------------
  describe("generatePrompt", () => {
    it("generates a prompt with issue details", async () => {
      mockGlab(sampleIssue);
      const prompt = await tracker.generatePrompt("42", project);

      expect(prompt).toContain("GitLab issue #42");
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("Users can't log in with SSO");
      expect(prompt).toContain("bug, priority-high");
    });
  });

  // -------------------------------------------------------------------------
  // listIssues
  // -------------------------------------------------------------------------
  describe("listIssues", () => {
    it("lists issues and maps them", async () => {
      mockGlab([sampleIssue]);
      const issues = await tracker.listIssues!({ state: "open" }, project);

      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("42");
    });

    it("passes --closed flag for closed state", async () => {
      mockGlab([]);
      await tracker.listIssues!({ state: "closed" }, project);

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("--closed");
    });

    it("passes --all flag for all state", async () => {
      mockGlab([]);
      await tracker.listIssues!({ state: "all" }, project);

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("--all");
    });

    it("passes --label flag for labels", async () => {
      mockGlab([]);
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("--label");
      expect(args).toContain("bug,urgent");
    });

    it("passes --assignee flag", async () => {
      mockGlab([]);
      await tracker.listIssues!({ assignee: "alice" }, project);

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("--assignee");
      expect(args).toContain("alice");
    });

    it("respects limit via --per-page", async () => {
      mockGlab([]);
      await tracker.listIssues!({ limit: 5 }, project);

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("--per-page");
      expect(args).toContain("5");
    });
  });

  // -------------------------------------------------------------------------
  // updateIssue
  // -------------------------------------------------------------------------
  describe("updateIssue", () => {
    it("closes an issue", async () => {
      mockGlabRaw("Closing issue #42...");
      await tracker.updateIssue!("42", { state: "closed" }, project);

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("close");
    });

    it("reopens an issue", async () => {
      mockGlabRaw("Reopening issue #42...");
      await tracker.updateIssue!("42", { state: "open" }, project);

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("reopen");
    });

    it("adds labels via update", async () => {
      mockGlabRaw("Updated issue #42");
      await tracker.updateIssue!("42", { labels: ["reviewed"] }, project);

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("update");
      expect(args).toContain("--label");
      expect(args).toContain("reviewed");
    });

    it("adds a comment via note", async () => {
      mockGlabRaw("Note added");
      await tracker.updateIssue!("42", { comment: "Working on it" }, project);

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("note");
      expect(args).toContain("--message");
      expect(args).toContain("Working on it");
    });
  });

  // -------------------------------------------------------------------------
  // createIssue
  // -------------------------------------------------------------------------
  describe("createIssue", () => {
    it("creates a new issue and fetches it back", async () => {
      // First call: create (returns JSON with iid)
      mockGlab({ iid: 99 });
      // Second call: getIssue
      mockGlab({
        ...sampleIssue,
        iid: 99,
        title: "New feature",
        description: "",
      });

      const issue = await tracker.createIssue!(
        { title: "New feature", description: "Build it" },
        project,
      );

      expect(issue.id).toBe("99");
      expect(issue.title).toBe("New feature");

      // Verify create call args
      const createArgs = glabMock.mock.calls[0][1] as string[];
      expect(createArgs).toContain("create");
      expect(createArgs).toContain("--title");
      expect(createArgs).toContain("New feature");
    });

    it("includes labels and assignee in creation", async () => {
      mockGlab({ iid: 100 });
      mockGlab({ ...sampleIssue, iid: 100 });

      await tracker.createIssue!(
        { title: "Task", description: "Do it", labels: ["urgent"], assignee: "bob" },
        project,
      );

      const createArgs = glabMock.mock.calls[0][1] as string[];
      expect(createArgs).toContain("--label");
      expect(createArgs).toContain("urgent");
      expect(createArgs).toContain("--assignee");
      expect(createArgs).toContain("bob");
    });
  });
});
