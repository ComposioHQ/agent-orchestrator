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
import type { ProjectConfig, PRInfo, Session } from "@composio/ao-core";

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

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 10,
    url: "https://gitlab.com/acme/repo/-/merge_requests/10",
    title: "Fix login",
    owner: "acme",
    repo: "repo",
    branch: "feat/fix-login",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/test",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function mockGlab(result: unknown) {
  glabMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
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

describe("scm-gitlab plugin", () => {
  let scm: ReturnType<typeof create>;

  beforeEach(() => {
    vi.resetAllMocks();
    scm = create();
  });

  // -------------------------------------------------------------------------
  // Manifest & exports
  // -------------------------------------------------------------------------
  describe("manifest", () => {
    it("has correct name and slot", () => {
      expect(manifest.name).toBe("gitlab");
      expect(manifest.slot).toBe("scm");
    });

    it("default export satisfies PluginModule shape", () => {
      expect(defaultExport.manifest).toBe(manifest);
      expect(typeof defaultExport.create).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // detectPR
  // -------------------------------------------------------------------------
  describe("detectPR", () => {
    it("returns null when session has no branch", async () => {
      const result = await scm.detectPR(makeSession({ branch: null }), project);
      expect(result).toBeNull();
    });

    it("detects an MR by source branch", async () => {
      mockGlab([
        {
          iid: 10,
          web_url: "https://gitlab.com/acme/repo/-/merge_requests/10",
          title: "Fix login",
          source_branch: "feat/test",
          target_branch: "main",
          draft: false,
        },
      ]);

      const result = await scm.detectPR(makeSession(), project);
      expect(result).not.toBeNull();
      expect(result!.number).toBe(10);
      expect(result!.branch).toBe("feat/test");
      expect(result!.owner).toBe("acme");
      expect(result!.repo).toBe("repo");
    });

    it("returns null when no MR found", async () => {
      mockGlab([]);
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("returns null on glab error", async () => {
      mockGlabError("not found");
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("handles nested group repos", async () => {
      const nestedProject = { ...project, repo: "group/subgroup/repo" };
      mockGlab([
        {
          iid: 5,
          web_url: "https://gitlab.com/group/subgroup/repo/-/merge_requests/5",
          title: "Test",
          source_branch: "feat/test",
          target_branch: "main",
          draft: false,
        },
      ]);

      const result = await scm.detectPR(makeSession(), nestedProject);
      expect(result).not.toBeNull();
      expect(result!.owner).toBe("group/subgroup");
      expect(result!.repo).toBe("repo");
    });
  });

  // -------------------------------------------------------------------------
  // getPRState
  // -------------------------------------------------------------------------
  describe("getPRState", () => {
    it("returns open for opened MR", async () => {
      mockGlab({ state: "opened" });
      expect(await scm.getPRState(makePR())).toBe("open");
    });

    it("returns merged for merged MR", async () => {
      mockGlab({ state: "merged" });
      expect(await scm.getPRState(makePR())).toBe("merged");
    });

    it("returns closed for closed MR", async () => {
      mockGlab({ state: "closed" });
      expect(await scm.getPRState(makePR())).toBe("closed");
    });
  });

  // -------------------------------------------------------------------------
  // getPRSummary
  // -------------------------------------------------------------------------
  describe("getPRSummary", () => {
    it("returns state, title, additions, and deletions", async () => {
      mockGlab({ state: "opened", title: "Fix login", changes_count: "5" });
      mockGlab({ additions: 42, deletions: 10 });

      const summary = await scm.getPRSummary!(makePR());
      expect(summary.state).toBe("open");
      expect(summary.title).toBe("Fix login");
      expect(summary.additions).toBe(42);
      expect(summary.deletions).toBe(10);
    });

    it("falls back to zero when API fails for diff stats", async () => {
      mockGlab({ state: "merged", title: "Done", changes_count: "3" });
      mockGlabError("api error");

      const summary = await scm.getPRSummary!(makePR());
      expect(summary.state).toBe("merged");
      expect(summary.additions).toBe(0);
      expect(summary.deletions).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // mergePR
  // -------------------------------------------------------------------------
  describe("mergePR", () => {
    it("merges with squash by default", async () => {
      mockGlabRaw("Merged");
      await scm.mergePR(makePR());

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("merge");
      expect(args).toContain("--squash-before-merge");
      expect(args).toContain("--remove-source-branch");
    });

    it("merges with rebase when specified", async () => {
      mockGlabRaw("Merged");
      await scm.mergePR(makePR(), "rebase");

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("--rebase");
    });

    it("merges with merge commit when merge specified", async () => {
      mockGlabRaw("Merged");
      await scm.mergePR(makePR(), "merge");

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).not.toContain("--squash-before-merge");
      expect(args).not.toContain("--rebase");
    });
  });

  // -------------------------------------------------------------------------
  // closePR
  // -------------------------------------------------------------------------
  describe("closePR", () => {
    it("closes the MR", async () => {
      mockGlabRaw("Closed");
      await scm.closePR(makePR());

      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).toContain("close");
    });
  });

  // -------------------------------------------------------------------------
  // getCIChecks
  // -------------------------------------------------------------------------
  describe("getCIChecks", () => {
    it("maps pipeline jobs to CICheck objects", async () => {
      mockGlab({ head_pipeline: { id: 100 } });
      mockGlab([
        { name: "build", status: "success", web_url: "https://...", started_at: null, finished_at: null },
        { name: "test", status: "failed", web_url: "https://...", started_at: null, finished_at: null },
        { name: "lint", status: "pending", web_url: "https://...", started_at: null, finished_at: null },
        { name: "deploy", status: "skipped", web_url: "https://...", started_at: null, finished_at: null },
      ]);

      const checks = await scm.getCIChecks(makePR());
      expect(checks).toHaveLength(4);
      expect(checks[0].status).toBe("passed");
      expect(checks[1].status).toBe("failed");
      expect(checks[2].status).toBe("pending");
      expect(checks[3].status).toBe("skipped");
    });

    it("returns empty when no head pipeline", async () => {
      mockGlab({});
      const checks = await scm.getCIChecks(makePR());
      expect(checks).toEqual([]);
    });

    it("throws on API error", async () => {
      mockGlabError("api error");
      await expect(scm.getCIChecks(makePR())).rejects.toThrow("Failed to fetch CI checks");
    });
  });

  // -------------------------------------------------------------------------
  // getCISummary
  // -------------------------------------------------------------------------
  describe("getCISummary", () => {
    it("returns passing when all checks pass", async () => {
      mockGlab({ head_pipeline: { id: 1 } });
      mockGlab([{ name: "build", status: "success", web_url: "", started_at: null, finished_at: null }]);
      expect(await scm.getCISummary(makePR())).toBe("passing");
    });

    it("returns failing when any check fails", async () => {
      mockGlab({ head_pipeline: { id: 1 } });
      mockGlab([
        { name: "build", status: "success", web_url: "", started_at: null, finished_at: null },
        { name: "test", status: "failed", web_url: "", started_at: null, finished_at: null },
      ]);
      expect(await scm.getCISummary(makePR())).toBe("failing");
    });

    it("returns pending when checks are running", async () => {
      mockGlab({ head_pipeline: { id: 1 } });
      mockGlab([
        { name: "build", status: "success", web_url: "", started_at: null, finished_at: null },
        { name: "test", status: "running", web_url: "", started_at: null, finished_at: null },
      ]);
      expect(await scm.getCISummary(makePR())).toBe("pending");
    });

    it("returns none when no checks exist", async () => {
      mockGlab({});
      expect(await scm.getCISummary(makePR())).toBe("none");
    });

    it("returns none for merged MR when CI fetch fails", async () => {
      mockGlabError("api error"); // getCIChecks fails
      mockGlab({ state: "merged" }); // getPRState
      expect(await scm.getCISummary(makePR())).toBe("none");
    });

    it("returns failing for open MR when CI fetch fails", async () => {
      mockGlabError("api error"); // getCIChecks fails
      mockGlab({ state: "opened" }); // getPRState
      expect(await scm.getCISummary(makePR())).toBe("failing");
    });
  });

  // -------------------------------------------------------------------------
  // getReviews
  // -------------------------------------------------------------------------
  describe("getReviews", () => {
    it("maps approved reviewers", async () => {
      mockGlab({
        rules: [
          { approved: true, approved_by: [{ username: "alice" }, { username: "bob" }] },
        ],
      });

      const reviews = await scm.getReviews(makePR());
      expect(reviews).toHaveLength(2);
      expect(reviews[0].author).toBe("alice");
      expect(reviews[0].state).toBe("approved");
    });

    it("returns empty on API error", async () => {
      mockGlabError("api error");
      expect(await scm.getReviews(makePR())).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getReviewDecision
  // -------------------------------------------------------------------------
  describe("getReviewDecision", () => {
    it("returns approved when approved", async () => {
      mockGlab({ approved: true, approvals_required: 1, approvals_left: 0 });
      expect(await scm.getReviewDecision(makePR())).toBe("approved");
    });

    it("returns pending when approvals needed", async () => {
      mockGlab({ approved: false, approvals_required: 2, approvals_left: 1 });
      expect(await scm.getReviewDecision(makePR())).toBe("pending");
    });

    it("returns none on API error", async () => {
      mockGlabError("api error");
      expect(await scm.getReviewDecision(makePR())).toBe("none");
    });
  });

  // -------------------------------------------------------------------------
  // getPendingComments
  // -------------------------------------------------------------------------
  describe("getPendingComments", () => {
    it("returns unresolved non-bot comments", async () => {
      mockGlab([
        {
          id: "d1",
          notes: [
            {
              id: 101,
              author: { username: "alice" },
              body: "Please fix this",
              resolvable: true,
              resolved: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
        {
          id: "d2",
          notes: [
            {
              id: 102,
              author: { username: "bob" },
              body: "Resolved",
              resolvable: true,
              resolved: true,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
      ]);

      const comments = await scm.getPendingComments(makePR());
      expect(comments).toHaveLength(1);
      expect(comments[0].author).toBe("alice");
      expect(comments[0].isResolved).toBe(false);
    });

    it("filters out bot comments", async () => {
      mockGlab([
        {
          id: "d1",
          notes: [
            {
              id: 103,
              author: { username: "gitlab-bot" },
              body: "Automated check",
              resolvable: true,
              resolved: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
      ]);

      const comments = await scm.getPendingComments(makePR());
      expect(comments).toHaveLength(0);
    });

    it("returns empty on API error", async () => {
      mockGlabError("api error");
      expect(await scm.getPendingComments(makePR())).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getAutomatedComments
  // -------------------------------------------------------------------------
  describe("getAutomatedComments", () => {
    it("returns only bot comments", async () => {
      mockGlab([
        { id: 201, author: { username: "gitlab-bot" }, body: "Error: lint failed", created_at: "2025-01-01T00:00:00Z" },
        { id: 202, author: { username: "alice" }, body: "LGTM", created_at: "2025-01-01T00:00:00Z" },
      ]);

      const comments = await scm.getAutomatedComments(makePR());
      expect(comments).toHaveLength(1);
      expect(comments[0].botName).toBe("gitlab-bot");
      expect(comments[0].severity).toBe("error");
    });

    it("returns empty on API error", async () => {
      mockGlabError("api error");
      expect(await scm.getAutomatedComments(makePR())).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getMergeability
  // -------------------------------------------------------------------------
  describe("getMergeability", () => {
    it("returns all-clear for merged MR", async () => {
      mockGlab({ state: "merged" }); // getPRState

      const result = await scm.getMergeability(makePR());
      expect(result.mergeable).toBe(true);
      expect(result.blockers).toEqual([]);
    });

    it("detects merge conflicts", async () => {
      mockGlab({ state: "opened" }); // getPRState
      mockGlab({
        merge_status: "can_be_merged",
        has_conflicts: true,
        work_in_progress: false,
        draft: false,
        blocking_discussions_resolved: true,
      }); // MR details
      // getCISummary chain
      mockGlab({}); // getCIChecks (no pipeline)
      // getReviewDecision
      mockGlab({ approved: true, approvals_required: 0, approvals_left: 0 });

      const result = await scm.getMergeability(makePR());
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge conflicts");
    });

    it("detects draft MR", async () => {
      mockGlab({ state: "opened" });
      mockGlab({
        merge_status: "can_be_merged",
        has_conflicts: false,
        work_in_progress: false,
        draft: true,
        blocking_discussions_resolved: true,
      });
      mockGlab({}); // getCIChecks (no pipeline)
      mockGlab({ approved: true, approvals_required: 0, approvals_left: 0 });

      const result = await scm.getMergeability(makePR());
      expect(result.blockers).toContain("MR is still a draft");
    });

    it("detects unresolved discussions", async () => {
      mockGlab({ state: "opened" });
      mockGlab({
        merge_status: "can_be_merged",
        has_conflicts: false,
        work_in_progress: false,
        draft: false,
        blocking_discussions_resolved: false,
      });
      mockGlab({}); // getCIChecks
      mockGlab({ approved: true, approvals_required: 0, approvals_left: 0 });

      const result = await scm.getMergeability(makePR());
      expect(result.blockers).toContain("Unresolved discussions");
    });
  });
});
