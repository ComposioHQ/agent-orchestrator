import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process — gh CLI calls go through execFileAsync = promisify(execFile)
// vi.hoisted ensures the mock fn is available when vi.mock factory runs (hoisted above imports)
// ---------------------------------------------------------------------------
const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }));

vi.mock("node:child_process", () => {
  // Attach the custom promisify symbol so `promisify(execFile)` returns ghMock
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: ghMock,
  });
  return { execFile };
});

import { create, manifest } from "../src/index.js";
import type { PRInfo, Session, ProjectConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pr: PRInfo = {
  number: 42,
  url: "https://github.com/acme/repo/pull/42",
  title: "feat: add feature",
  owner: "acme",
  repo: "repo",
  branch: "feat/my-feature",
  baseBranch: "main",
  isDraft: false,
};

const project: ProjectConfig = {
  name: "test",
  repo: "acme/repo",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test",
    status: "working",
    activity: "active",
    branch: "feat/my-feature",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/repo",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function mockGh(result: unknown) {
  ghMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

function mockGhError(msg = "Command failed") {
  ghMock.mockRejectedValueOnce(new Error(msg));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scm-github plugin", () => {
  let scm: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    scm = create();
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("github");
      expect(manifest.slot).toBe("scm");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  // ---- create() ----------------------------------------------------------

  describe("create()", () => {
    it("returns an SCM with correct name", () => {
      expect(scm.name).toBe("github");
    });
  });

  // ---- detectPR ----------------------------------------------------------

  describe("detectPR", () => {
    it("returns PRInfo when a PR exists", async () => {
      mockGh([
        {
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          title: "feat: add feature",
          headRefName: "feat/my-feature",
          baseRefName: "main",
          isDraft: false,
        },
      ]);

      const result = await scm.detectPR(makeSession(), project);
      expect(result).toEqual({
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        title: "feat: add feature",
        owner: "acme",
        repo: "repo",
        branch: "feat/my-feature",
        baseBranch: "main",
        isDraft: false,
      });
    });

    it("returns null when no PR found", async () => {
      mockGh([]);
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("returns null when session has no branch", async () => {
      const result = await scm.detectPR(makeSession({ branch: null }), project);
      expect(result).toBeNull();
      expect(ghMock).not.toHaveBeenCalled();
    });

    it("returns null on gh CLI error", async () => {
      mockGhError("gh: not found");
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("throws on invalid repo format", async () => {
      const badProject = { ...project, repo: "no-slash" };
      await expect(scm.detectPR(makeSession(), badProject)).rejects.toThrow("Invalid repo format");
    });

    it("detects draft PRs", async () => {
      mockGh([
        {
          number: 99,
          url: "https://github.com/acme/repo/pull/99",
          title: "WIP: draft feature",
          headRefName: "feat/my-feature",
          baseRefName: "main",
          isDraft: true,
        },
      ]);
      const result = await scm.detectPR(makeSession(), project);
      expect(result?.isDraft).toBe(true);
    });
  });

  // ---- getPRState --------------------------------------------------------

  describe("getPRState", () => {
    it('returns "open" for open PR', async () => {
      mockGh({ state: "OPEN" });
      expect(await scm.getPRState(pr)).toBe("open");
    });

    it('returns "merged" for merged PR', async () => {
      mockGh({ state: "MERGED" });
      expect(await scm.getPRState(pr)).toBe("merged");
    });

    it('returns "closed" for closed PR', async () => {
      mockGh({ state: "CLOSED" });
      expect(await scm.getPRState(pr)).toBe("closed");
    });

    it("handles lowercase state strings", async () => {
      mockGh({ state: "merged" });
      expect(await scm.getPRState(pr)).toBe("merged");
    });
  });

  // ---- mergePR -----------------------------------------------------------

  describe("mergePR", () => {
    it("uses --squash by default", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.mergePR(pr);
      expect(ghMock).toHaveBeenCalledWith(
        "gh",
        ["pr", "merge", "42", "--repo", "acme/repo", "--squash", "--delete-branch"],
        expect.any(Object),
      );
    });

    it("uses --merge when specified", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.mergePR(pr, "merge");
      expect(ghMock).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["--merge"]),
        expect.any(Object),
      );
    });

    it("uses --rebase when specified", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.mergePR(pr, "rebase");
      expect(ghMock).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["--rebase"]),
        expect.any(Object),
      );
    });
  });

  // ---- closePR -----------------------------------------------------------

  describe("closePR", () => {
    it("calls gh pr close", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.closePR(pr);
      expect(ghMock).toHaveBeenCalledWith(
        "gh",
        ["pr", "close", "42", "--repo", "acme/repo"],
        expect.any(Object),
      );
    });
  });

  // ---- getCIChecks -------------------------------------------------------

  describe("getCIChecks", () => {
    it("maps various check states correctly", async () => {
      mockGh([
        {
          name: "build",
          state: "SUCCESS",
          link: "https://ci/1",
          startedAt: "2025-01-01T00:00:00Z",
          completedAt: "2025-01-01T00:05:00Z",
        },
        { name: "lint", state: "FAILURE", link: "", startedAt: "", completedAt: "" },
        { name: "deploy", state: "PENDING", link: "", startedAt: "", completedAt: "" },
        { name: "e2e", state: "IN_PROGRESS", link: "", startedAt: "", completedAt: "" },
        { name: "optional", state: "SKIPPED", link: "", startedAt: "", completedAt: "" },
        { name: "neutral", state: "NEUTRAL", link: "", startedAt: "", completedAt: "" },
        { name: "timeout", state: "TIMED_OUT", link: "", startedAt: "", completedAt: "" },
        { name: "queued", state: "QUEUED", link: "", startedAt: "", completedAt: "" },
        { name: "cancelled", state: "CANCELLED", link: "", startedAt: "", completedAt: "" },
        { name: "action_req", state: "ACTION_REQUIRED", link: "", startedAt: "", completedAt: "" },
      ]);

      const checks = await scm.getCIChecks(pr);
      expect(checks).toHaveLength(10);
      expect(checks[0].status).toBe("passed");
      expect(checks[0].url).toBe("https://ci/1");
      expect(checks[1].status).toBe("failed");
      expect(checks[2].status).toBe("pending");
      expect(checks[3].status).toBe("running");
      expect(checks[4].status).toBe("skipped");
      expect(checks[5].status).toBe("skipped");
      expect(checks[6].status).toBe("failed");
      expect(checks[7].status).toBe("pending");
      expect(checks[8].status).toBe("failed"); // CANCELLED
      expect(checks[9].status).toBe("failed"); // ACTION_REQUIRED
    });

    it("throws on error (fail-closed)", async () => {
      mockGhError("no checks");
      await expect(scm.getCIChecks(pr)).rejects.toThrow("Failed to fetch CI checks");
    });

    it("returns empty array for PR with no checks", async () => {
      mockGh([]);
      expect(await scm.getCIChecks(pr)).toEqual([]);
    });

    it("handles missing optional fields gracefully", async () => {
      mockGh([{ name: "test", state: "SUCCESS" }]);
      const checks = await scm.getCIChecks(pr);
      expect(checks[0].url).toBeUndefined();
      expect(checks[0].startedAt).toBeUndefined();
      expect(checks[0].completedAt).toBeUndefined();
    });
  });

  // ---- getCISummary ------------------------------------------------------

  describe("getCISummary", () => {
    it('returns "failing" when any check failed', async () => {
      mockGh([
        { name: "a", state: "SUCCESS" },
        { name: "b", state: "FAILURE" },
      ]);
      expect(await scm.getCISummary(pr)).toBe("failing");
    });

    it('returns "pending" when checks are running', async () => {
      mockGh([
        { name: "a", state: "SUCCESS" },
        { name: "b", state: "IN_PROGRESS" },
      ]);
      expect(await scm.getCISummary(pr)).toBe("pending");
    });

    it('returns "passing" when all checks passed', async () => {
      mockGh([
        { name: "a", state: "SUCCESS" },
        { name: "b", state: "SUCCESS" },
      ]);
      expect(await scm.getCISummary(pr)).toBe("passing");
    });

    it('returns "none" when no checks', async () => {
      mockGh([]);
      expect(await scm.getCISummary(pr)).toBe("none");
    });

    it('returns "failing" on error (fail-closed)', async () => {
      mockGhError();
      expect(await scm.getCISummary(pr)).toBe("failing");
    });

    it('returns "none" when all checks are skipped', async () => {
      mockGh([
        { name: "a", state: "SKIPPED" },
        { name: "b", state: "NEUTRAL" },
      ]);
      expect(await scm.getCISummary(pr)).toBe("none");
    });
  });

  // ---- getReviews --------------------------------------------------------

  describe("getReviews", () => {
    it("maps review states correctly", async () => {
      mockGh({
        reviews: [
          {
            author: { login: "alice" },
            state: "APPROVED",
            body: "LGTM",
            submittedAt: "2025-01-01T00:00:00Z",
          },
          {
            author: { login: "bob" },
            state: "CHANGES_REQUESTED",
            body: "Fix this",
            submittedAt: "2025-01-02T00:00:00Z",
          },
          {
            author: { login: "charlie" },
            state: "COMMENTED",
            body: "",
            submittedAt: "2025-01-03T00:00:00Z",
          },
          {
            author: { login: "eve" },
            state: "DISMISSED",
            body: "",
            submittedAt: "2025-01-04T00:00:00Z",
          },
          { author: { login: "frank" }, state: "PENDING", body: "", submittedAt: null },
        ],
      });

      const reviews = await scm.getReviews(pr);
      expect(reviews).toHaveLength(5);
      expect(reviews[0]).toMatchObject({ author: "alice", state: "approved" });
      expect(reviews[1]).toMatchObject({ author: "bob", state: "changes_requested" });
      expect(reviews[2]).toMatchObject({ author: "charlie", state: "commented" });
      expect(reviews[3]).toMatchObject({ author: "eve", state: "dismissed" });
      expect(reviews[4]).toMatchObject({ author: "frank", state: "pending" });
    });

    it("handles empty reviews", async () => {
      mockGh({ reviews: [] });
      expect(await scm.getReviews(pr)).toEqual([]);
    });

    it('defaults to "unknown" author when missing', async () => {
      mockGh({
        reviews: [
          { author: null, state: "APPROVED", body: "", submittedAt: "2025-01-01T00:00:00Z" },
        ],
      });
      const reviews = await scm.getReviews(pr);
      expect(reviews[0].author).toBe("unknown");
    });
  });

  // ---- getReviewDecision -------------------------------------------------

  describe("getReviewDecision", () => {
    it.each([
      ["APPROVED", "approved"],
      ["CHANGES_REQUESTED", "changes_requested"],
      ["REVIEW_REQUIRED", "pending"],
    ] as const)('maps %s to "%s"', async (input, expected) => {
      mockGh({ reviewDecision: input });
      expect(await scm.getReviewDecision(pr)).toBe(expected);
    });

    it('returns "none" when reviewDecision is empty', async () => {
      mockGh({ reviewDecision: "" });
      expect(await scm.getReviewDecision(pr)).toBe("none");
    });

    it('returns "none" when reviewDecision is null', async () => {
      mockGh({ reviewDecision: null });
      expect(await scm.getReviewDecision(pr)).toBe("none");
    });
  });

  // ---- getPendingComments ------------------------------------------------

  describe("getPendingComments", () => {
    function makeGraphQLThreads(
      threads: Array<{
        isResolved: boolean;
        id: string;
        author: string | null;
        body: string;
        path: string | null;
        line: number | null;
        url: string;
        createdAt: string;
      }>,
    ) {
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: threads.map((t) => ({
                  isResolved: t.isResolved,
                  comments: {
                    nodes: [
                      {
                        id: t.id,
                        author: t.author ? { login: t.author } : null,
                        body: t.body,
                        path: t.path,
                        line: t.line,
                        url: t.url,
                        createdAt: t.createdAt,
                      },
                    ],
                  },
                })),
              },
            },
          },
        },
      };
    }

    it("returns only unresolved non-bot comments from GraphQL", async () => {
      mockGh(
        makeGraphQLThreads([
          {
            isResolved: false,
            id: "C1",
            author: "alice",
            body: "Fix line 10",
            path: "src/foo.ts",
            line: 10,
            url: "https://github.com/c/1",
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            isResolved: true,
            id: "C2",
            author: "bob",
            body: "Resolved one",
            path: "src/bar.ts",
            line: 20,
            url: "https://github.com/c/2",
            createdAt: "2025-01-02T00:00:00Z",
          },
        ]),
      );

      const comments = await scm.getPendingComments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ id: "C1", author: "alice", isResolved: false });
    });

    it("filters out bot comments", async () => {
      mockGh(
        makeGraphQLThreads([
          {
            isResolved: false,
            id: "C1",
            author: "alice",
            body: "Fix this",
            path: "a.ts",
            line: 1,
            url: "u",
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            isResolved: false,
            id: "C2",
            author: "cursor[bot]",
            body: "Bot says",
            path: "a.ts",
            line: 2,
            url: "u",
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            isResolved: false,
            id: "C3",
            author: "codecov[bot]",
            body: "Coverage",
            path: "a.ts",
            line: 3,
            url: "u",
            createdAt: "2025-01-01T00:00:00Z",
          },
        ]),
      );

      const comments = await scm.getPendingComments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0].author).toBe("alice");
    });

    it("returns empty on error", async () => {
      mockGhError("API rate limit");
      expect(await scm.getPendingComments(pr)).toEqual([]);
    });

    it("handles null path and line", async () => {
      mockGh(
        makeGraphQLThreads([
          {
            isResolved: false,
            id: "C1",
            author: "alice",
            body: "General comment",
            path: null,
            line: null,
            url: "u",
            createdAt: "2025-01-01T00:00:00Z",
          },
        ]),
      );
      const comments = await scm.getPendingComments(pr);
      expect(comments[0].path).toBeUndefined();
      expect(comments[0].line).toBeUndefined();
    });
  });

  // ---- getAutomatedComments ----------------------------------------------

  describe("getAutomatedComments", () => {
    it("returns bot comments filtered from all PR comments", async () => {
      mockGh([
        {
          id: 1,
          user: { login: "cursor[bot]" },
          body: "Found a potential issue",
          path: "a.ts",
          line: 5,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u1",
        },
        {
          id: 2,
          user: { login: "alice" },
          body: "Human comment",
          path: "a.ts",
          line: 1,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u2",
        },
      ]);

      const comments = await scm.getAutomatedComments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0].botName).toBe("cursor[bot]");
      expect(comments[0].severity).toBe("error"); // "potential issue" → error
    });

    it("classifies severity from body content", async () => {
      mockGh([
        {
          id: 1,
          user: { login: "github-actions[bot]" },
          body: "Error: build failed",
          path: "a.ts",
          line: 1,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
        {
          id: 2,
          user: { login: "github-actions[bot]" },
          body: "Warning: deprecated API",
          path: "a.ts",
          line: 2,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
        {
          id: 3,
          user: { login: "github-actions[bot]" },
          body: "Deployed to staging",
          path: "a.ts",
          line: 3,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
      ]);

      const comments = await scm.getAutomatedComments(pr);
      expect(comments).toHaveLength(3);
      expect(comments[0].severity).toBe("error");
      expect(comments[1].severity).toBe("warning");
      expect(comments[2].severity).toBe("info");
    });

    it("returns empty when no bot comments", async () => {
      mockGh([
        {
          id: 1,
          user: { login: "alice" },
          body: "Human comment",
          path: "a.ts",
          line: 1,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
      ]);

      const comments = await scm.getAutomatedComments(pr);
      expect(comments).toEqual([]);
    });

    it("returns empty on error", async () => {
      mockGhError("network failure");
      expect(await scm.getAutomatedComments(pr)).toEqual([]);
    });

    it("uses original_line as fallback", async () => {
      mockGh([
        {
          id: 1,
          user: { login: "dependabot[bot]" },
          body: "Suggest update",
          path: "a.ts",
          line: null,
          original_line: 15,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
      ]);

      const comments = await scm.getAutomatedComments(pr);
      expect(comments[0].line).toBe(15);
    });
  });

  // ---- getMergeability ---------------------------------------------------

  describe("getMergeability", () => {
    it("returns clean result for merged PRs without querying mergeable status", async () => {
      // getPRState call
      mockGh({ state: "MERGED" });

      const result = await scm.getMergeability(pr);
      expect(result).toEqual({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      });
      // Should only call gh once (for getPRState), not for mergeable/CI
      expect(ghMock).toHaveBeenCalledTimes(1);
    });

    it("still checks mergeability for closed PRs (not merged)", async () => {
      // getPRState call
      mockGh({ state: "CLOSED" });
      // PR view (closed PRs still get checked)
      mockGh({
        mergeable: "CONFLICTING",
        reviewDecision: "APPROVED",
        mergeStateStatus: "DIRTY",
        isDraft: false,
      });
      // CI checks
      mockGh([]);

      const result = await scm.getMergeability(pr);
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge conflicts");
      // Closed PRs go through normal checks, unlike merged PRs
    });

    it("returns mergeable when everything is clear", async () => {
      // getPRState call (for open PR)
      mockGh({ state: "OPEN" });
      // PR view
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        isDraft: false,
      });
      // CI checks (called by getCISummary)
      mockGh([{ name: "build", state: "SUCCESS" }]);

      const result = await scm.getMergeability(pr);
      expect(result).toEqual({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      });
    });

    it("reports CI failures as blockers", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "UNSTABLE",
        isDraft: false,
      });
      mockGh([{ name: "build", state: "FAILURE" }]);

      const result = await scm.getMergeability(pr);
      expect(result.ciPassing).toBe(false);
      expect(result.mergeable).toBe(false);
      // CI section already added "CI is failing" — no redundant UNSTABLE blocker
      expect(result.blockers).toEqual(["CI is failing"]);
    });

    it("falls back to CI failing when CI fetch fails with UNSTABLE merge state", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "UNSTABLE",
        isDraft: false,
      });
      mockGhError("rate limited");

      const result = await scm.getMergeability(pr);
      expect(result.ciPassing).toBe(false);
      expect(result.mergeable).toBe(false);
      // getCISummary fail-closes to "failing", which the CI section reports
      expect(result.blockers).toEqual(["CI is failing"]);
    });

    it("does not treat UNSTABLE as a blocker when CI is pending", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "UNSTABLE",
        isDraft: false,
      });
      mockGh([{ name: "build", state: "PENDING" }]);

      const result = await scm.getMergeability(pr);
      expect(result.ciPassing).toBe(false);
      expect(result.mergeable).toBe(false);
      // Only the CI section blocker — UNSTABLE doesn't add a second one
      expect(result.blockers).toEqual(["CI is pending"]);
    });

    it("reports UNSTABLE as blocker when CI status is none (fail closed)", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "UNSTABLE",
        isDraft: false,
      });
      // All checks skipped → ciStatus "none", but GitHub says UNSTABLE
      mockGh([{ name: "build", state: "SKIPPED" }]);

      const result = await scm.getMergeability(pr);
      // ciPassing is true (none = passing), so UNSTABLE is the only signal
      expect(result.ciPassing).toBe(true);
      expect(result.mergeable).toBe(false);
      expect(result.blockers).toEqual(["Required checks are failing"]);
    });

    it("reports changes requested as blockers", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "CHANGES_REQUESTED",
        mergeStateStatus: "CLEAN",
        isDraft: false,
      });
      mockGh([]); // no CI checks

      const result = await scm.getMergeability(pr);
      expect(result.approved).toBe(false);
      expect(result.blockers).toContain("Changes requested in review");
    });

    it("reports review required as blocker", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "REVIEW_REQUIRED",
        mergeStateStatus: "BLOCKED",
        isDraft: false,
      });
      mockGh([]);

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toContain("Review required");
    });

    it("reports merge conflicts as blockers", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "CONFLICTING",
        reviewDecision: "APPROVED",
        mergeStateStatus: "DIRTY",
        isDraft: false,
      });
      mockGh([]);

      const result = await scm.getMergeability(pr);
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge conflicts");
    });

    it("reports UNKNOWN mergeable as noConflicts false", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "UNKNOWN",
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        isDraft: false,
      });
      mockGh([{ name: "build", state: "SUCCESS" }]);

      const result = await scm.getMergeability(pr);
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge status unknown (GitHub is computing)");
      expect(result.mergeable).toBe(false);
    });

    it("reports draft status as blocker", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "DRAFT",
        isDraft: true,
      });
      mockGh([{ name: "build", state: "SUCCESS" }]);

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toContain("PR is still a draft");
      expect(result.mergeable).toBe(false);
    });

    it("reports multiple blockers simultaneously", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "CONFLICTING",
        reviewDecision: "CHANGES_REQUESTED",
        mergeStateStatus: "DIRTY",
        isDraft: true,
      });
      mockGh([{ name: "build", state: "FAILURE" }]);

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toHaveLength(4);
      expect(result.mergeable).toBe(false);
    });
  });
});
