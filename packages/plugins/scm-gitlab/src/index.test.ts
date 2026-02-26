import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import type { PRInfo, Session, ProjectConfig } from "@composio/ao-core";

// Mock node:child_process with custom promisify support
vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

// Get reference to the promisify-custom mock
const mockExecFileCustom = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

/** Queue a successful glab command with the given stdout. */
function mockGlabSuccess(stdout = "") {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

/** Queue a failed glab command. */
function mockGlabError(message: string) {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

/** Create a PRInfo for testing. */
function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://gitlab.com/acme/app/-/merge_requests/42",
    title: "Fix the thing",
    owner: "acme",
    repo: "app",
    branch: "fix-thing",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

/** Create a Session for testing. */
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session",
    projectId: "my-project",
    status: "running",
    branch: "fix-thing",
    createdAt: new Date(),
    ...overrides,
  } as Session;
}

/** Create a ProjectConfig for testing. */
function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "My Project",
    repo: "acme/app",
    ...overrides,
  } as ProjectConfig;
}

// Import after mocks are set up
import gitlabPlugin, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("manifest", () => {
  it("has name 'gitlab' and slot 'scm'", () => {
    expect(manifest.name).toBe("gitlab");
    expect(manifest.slot).toBe("scm");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("SCM plugin: GitLab Merge Requests, Pipelines, Reviews");
  });

  it("default export includes manifest and create", () => {
    expect(gitlabPlugin.manifest).toBe(manifest);
    expect(gitlabPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns an SCM with name 'gitlab'", () => {
    const scm = create();
    expect(scm.name).toBe("gitlab");
  });
});

describe("detectPR()", () => {
  it("returns PRInfo when MR exists for branch", async () => {
    const scm = create();
    const mrData = [
      {
        iid: 42,
        web_url: "https://gitlab.com/acme/app/-/merge_requests/42",
        title: "Fix the thing",
        source_branch: "fix-thing",
        target_branch: "main",
        draft: false,
      },
    ];
    mockGlabSuccess(JSON.stringify(mrData));

    const result = await scm.detectPR(makeSession(), makeProject());

    expect(result).not.toBeNull();
    expect(result!.number).toBe(42);
    expect(result!.url).toBe("https://gitlab.com/acme/app/-/merge_requests/42");
    expect(result!.title).toBe("Fix the thing");
    expect(result!.branch).toBe("fix-thing");
    expect(result!.baseBranch).toBe("main");
    expect(result!.isDraft).toBe(false);
    expect(result!.owner).toBe("acme");
    expect(result!.repo).toBe("app");
  });

  it("returns null when no MR found", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify([]));

    const result = await scm.detectPR(makeSession(), makeProject());
    expect(result).toBeNull();
  });

  it("returns null when session has no branch", async () => {
    const scm = create();
    const result = await scm.detectPR(
      makeSession({ branch: undefined }),
      makeProject(),
    );
    expect(result).toBeNull();
    expect(mockExecFileCustom).not.toHaveBeenCalled();
  });

  it("returns null when glab command fails", async () => {
    const scm = create();
    mockGlabError("glab mr list failed");

    const result = await scm.detectPR(makeSession(), makeProject());
    expect(result).toBeNull();
  });

  it("throws on invalid repo format", async () => {
    const scm = create();
    await expect(
      scm.detectPR(makeSession(), makeProject({ repo: "badformat" })),
    ).rejects.toThrow('Invalid repo format "badformat"');
  });

  it("handles multi-level group paths", async () => {
    const scm = create();
    const mrData = [
      {
        iid: 10,
        web_url: "https://gitlab.com/acme/sub/app/-/merge_requests/10",
        title: "Feature",
        source_branch: "fix-thing",
        target_branch: "main",
        draft: true,
      },
    ];
    mockGlabSuccess(JSON.stringify(mrData));

    const result = await scm.detectPR(
      makeSession(),
      makeProject({ repo: "acme/sub/app" }),
    );

    expect(result).not.toBeNull();
    expect(result!.owner).toBe("acme/sub");
    expect(result!.repo).toBe("app");
    expect(result!.isDraft).toBe(true);
  });
});

describe("getPRState()", () => {
  it("returns 'open' for opened MR", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify({ state: "opened" }));

    const state = await scm.getPRState(makePR());
    expect(state).toBe("open");
  });

  it("returns 'merged' for merged MR", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify({ state: "merged" }));

    const state = await scm.getPRState(makePR());
    expect(state).toBe("merged");
  });

  it("returns 'closed' for closed MR", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify({ state: "closed" }));

    const state = await scm.getPRState(makePR());
    expect(state).toBe("closed");
  });

  it("defaults to 'open' for unknown state", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify({ state: "locked" }));

    const state = await scm.getPRState(makePR());
    expect(state).toBe("open");
  });
});

describe("mergePR()", () => {
  it("calls glab mr merge with squash flag by default", async () => {
    const scm = create();
    mockGlabSuccess();

    await scm.mergePR(makePR());

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "glab",
      expect.arrayContaining([
        "mr", "merge", "42", "--repo", "acme/app", "--yes", "--remove-source-branch", "--squash",
      ]),
      expect.any(Object),
    );
  });

  it("calls glab mr merge with rebase flag", async () => {
    const scm = create();
    mockGlabSuccess();

    await scm.mergePR(makePR(), "rebase");

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "glab",
      expect.arrayContaining(["--rebase"]),
      expect.any(Object),
    );
  });

  it("calls glab mr merge without squash/rebase for merge method", async () => {
    const scm = create();
    mockGlabSuccess();

    await scm.mergePR(makePR(), "merge");

    const args = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(args).not.toContain("--squash");
    expect(args).not.toContain("--rebase");
    expect(args).toContain("--yes");
    expect(args).toContain("--remove-source-branch");
  });
});

describe("closePR()", () => {
  it("calls glab mr close with correct args", async () => {
    const scm = create();
    mockGlabSuccess();

    await scm.closePR(makePR());

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "glab",
      ["mr", "close", "42", "--repo", "acme/app"],
      expect.any(Object),
    );
  });
});

describe("getCIChecks()", () => {
  it("returns mapped pipeline jobs", async () => {
    const scm = create();

    // First call: pipelines list
    const pipelines = [{ id: 100, status: "success", web_url: "https://gitlab.com/pipelines/100", created_at: "2025-01-01", updated_at: "2025-01-02" }];
    mockGlabSuccess(JSON.stringify(pipelines));

    // Second call: jobs for latest pipeline
    const jobs = [
      { name: "build", status: "success", web_url: "https://gitlab.com/jobs/1", started_at: "2025-01-01T10:00:00Z", finished_at: "2025-01-01T10:05:00Z" },
      { name: "test", status: "failed", web_url: "https://gitlab.com/jobs/2", started_at: "2025-01-01T10:00:00Z", finished_at: "2025-01-01T10:10:00Z" },
      { name: "lint", status: "running", web_url: "https://gitlab.com/jobs/3", started_at: "2025-01-01T10:00:00Z", finished_at: null },
      { name: "deploy", status: "pending", web_url: "", started_at: null, finished_at: null },
      { name: "manual-test", status: "manual", web_url: "", started_at: null, finished_at: null },
    ];
    mockGlabSuccess(JSON.stringify(jobs));

    const checks = await scm.getCIChecks(makePR());

    expect(checks).toHaveLength(5);
    expect(checks[0].name).toBe("build");
    expect(checks[0].status).toBe("passed");
    expect(checks[1].name).toBe("test");
    expect(checks[1].status).toBe("failed");
    expect(checks[2].name).toBe("lint");
    expect(checks[2].status).toBe("running");
    expect(checks[3].name).toBe("deploy");
    expect(checks[3].status).toBe("pending");
    expect(checks[4].name).toBe("manual-test");
    expect(checks[4].status).toBe("skipped");
  });

  it("returns empty array when no pipelines exist", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify([]));

    const checks = await scm.getCIChecks(makePR());
    expect(checks).toEqual([]);
  });

  it("throws on glab API failure", async () => {
    const scm = create();
    mockGlabError("network error");

    await expect(scm.getCIChecks(makePR())).rejects.toThrow("Failed to fetch CI checks");
  });

  it("maps skipped status for canceled jobs", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify([{ id: 1, status: "success" }]));
    mockGlabSuccess(JSON.stringify([
      { name: "canceled-job", status: "canceled", web_url: "", started_at: null, finished_at: null },
    ]));

    const checks = await scm.getCIChecks(makePR());
    expect(checks[0].status).toBe("skipped");
  });
});

describe("getCISummary()", () => {
  it("returns 'passing' when all checks pass", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify([{ id: 1 }]));
    mockGlabSuccess(JSON.stringify([{ name: "build", status: "success", web_url: "", started_at: null, finished_at: null }]));

    const summary = await scm.getCISummary(makePR());
    expect(summary).toBe("passing");
  });

  it("returns 'failing' when any check fails", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify([{ id: 1 }]));
    mockGlabSuccess(JSON.stringify([
      { name: "build", status: "success", web_url: "", started_at: null, finished_at: null },
      { name: "test", status: "failed", web_url: "", started_at: null, finished_at: null },
    ]));

    const summary = await scm.getCISummary(makePR());
    expect(summary).toBe("failing");
  });

  it("returns 'pending' when checks are running", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify([{ id: 1 }]));
    mockGlabSuccess(JSON.stringify([
      { name: "build", status: "success", web_url: "", started_at: null, finished_at: null },
      { name: "deploy", status: "running", web_url: "", started_at: null, finished_at: null },
    ]));

    const summary = await scm.getCISummary(makePR());
    expect(summary).toBe("pending");
  });

  it("returns 'none' when no pipelines exist", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify([]));

    const summary = await scm.getCISummary(makePR());
    expect(summary).toBe("none");
  });

  it("returns 'failing' when getCIChecks throws and state is open", async () => {
    const scm = create();
    // getCIChecks fails
    mockGlabError("api error");
    // getPRState fallback: MR view
    mockGlabSuccess(JSON.stringify({ state: "opened" }));

    const summary = await scm.getCISummary(makePR());
    expect(summary).toBe("failing");
  });

  it("returns 'none' when getCIChecks throws and MR is merged", async () => {
    const scm = create();
    // getCIChecks fails
    mockGlabError("api error");
    // getPRState fallback: MR view
    mockGlabSuccess(JSON.stringify({ state: "merged" }));

    const summary = await scm.getCISummary(makePR());
    expect(summary).toBe("none");
  });
});

describe("getReviews()", () => {
  it("returns approvals as reviews", async () => {
    const scm = create();
    const approvalData = {
      approved_by: [
        { user: { username: "alice" } },
        { user: { username: "bob" } },
      ],
    };
    mockGlabSuccess(JSON.stringify(approvalData));

    const reviews = await scm.getReviews(makePR());

    expect(reviews).toHaveLength(2);
    expect(reviews[0].author).toBe("alice");
    expect(reviews[0].state).toBe("approved");
    expect(reviews[1].author).toBe("bob");
    expect(reviews[1].state).toBe("approved");
  });

  it("returns empty array when no approvals", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify({ approved_by: [] }));

    const reviews = await scm.getReviews(makePR());
    expect(reviews).toEqual([]);
  });

  it("returns empty array on error", async () => {
    const scm = create();
    mockGlabError("network error");

    const reviews = await scm.getReviews(makePR());
    expect(reviews).toEqual([]);
  });
});

describe("getReviewDecision()", () => {
  it("returns 'approved' when MR is approved", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify({
      approved: true,
      approvals_required: 1,
      approvals_left: 0,
    }));

    const decision = await scm.getReviewDecision(makePR());
    expect(decision).toBe("approved");
  });

  it("returns 'pending' when approvals are required and left > 0", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify({
      approved: false,
      approvals_required: 2,
      approvals_left: 1,
    }));

    const decision = await scm.getReviewDecision(makePR());
    expect(decision).toBe("pending");
  });

  it("returns 'none' when no approvals required", async () => {
    const scm = create();
    mockGlabSuccess(JSON.stringify({
      approved: false,
      approvals_required: 0,
      approvals_left: 0,
    }));

    const decision = await scm.getReviewDecision(makePR());
    expect(decision).toBe("none");
  });

  it("returns 'none' on error", async () => {
    const scm = create();
    mockGlabError("network error");

    const decision = await scm.getReviewDecision(makePR());
    expect(decision).toBe("none");
  });
});

describe("getPendingComments()", () => {
  it("returns unresolved non-bot comments", async () => {
    const scm = create();
    const discussions = [
      {
        id: "disc-1",
        notes: [
          {
            id: 100,
            author: { username: "reviewer" },
            body: "Please fix this",
            position: { new_path: "src/main.ts", new_line: 42 },
            resolvable: true,
            resolved: false,
            created_at: "2025-01-01T10:00:00Z",
          },
        ],
      },
      {
        id: "disc-2",
        notes: [
          {
            id: 101,
            author: { username: "reviewer" },
            body: "Already fixed",
            position: { new_path: "src/main.ts", new_line: 50 },
            resolvable: true,
            resolved: true,
            created_at: "2025-01-01T10:00:00Z",
          },
        ],
      },
      {
        id: "disc-3",
        notes: [
          {
            id: 102,
            author: { username: "gitlab-bot" },
            body: "Bot comment",
            resolvable: true,
            resolved: false,
            created_at: "2025-01-01T10:00:00Z",
          },
        ],
      },
      {
        id: "disc-4",
        notes: [
          {
            id: 103,
            author: { username: "dev" },
            body: "Non-resolvable note",
            resolvable: false,
            resolved: false,
            created_at: "2025-01-01T10:00:00Z",
          },
        ],
      },
    ];
    mockGlabSuccess(JSON.stringify(discussions));

    const comments = await scm.getPendingComments(makePR());

    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe("100");
    expect(comments[0].author).toBe("reviewer");
    expect(comments[0].body).toBe("Please fix this");
    expect(comments[0].path).toBe("src/main.ts");
    expect(comments[0].line).toBe(42);
    expect(comments[0].isResolved).toBe(false);
  });

  it("returns empty array on error", async () => {
    const scm = create();
    mockGlabError("network error");

    const comments = await scm.getPendingComments(makePR());
    expect(comments).toEqual([]);
  });
});

describe("getMergeability()", () => {
  it("returns fully mergeable when everything passes", async () => {
    const scm = create();

    // getPRState (mr view)
    mockGlabSuccess(JSON.stringify({ state: "opened" }));
    // mr view for details (second call)
    mockGlabSuccess(JSON.stringify({
      has_conflicts: false,
      merge_status: "can_be_merged",
      draft: false,
      blocking_discussions_resolved: true,
    }));
    // getCISummary -> getCIChecks -> pipelines
    mockGlabSuccess(JSON.stringify([{ id: 1 }]));
    // getCIChecks -> jobs
    mockGlabSuccess(JSON.stringify([{ name: "build", status: "success", web_url: "", started_at: null, finished_at: null }]));
    // getReviewDecision -> approvals
    mockGlabSuccess(JSON.stringify({ approved: true, approvals_required: 1, approvals_left: 0 }));

    const result = await scm.getMergeability(makePR());

    expect(result.mergeable).toBe(true);
    expect(result.ciPassing).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.noConflicts).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("returns already merged as fully mergeable", async () => {
    const scm = create();
    // getPRState
    mockGlabSuccess(JSON.stringify({ state: "merged" }));

    const result = await scm.getMergeability(makePR());

    expect(result.mergeable).toBe(true);
    expect(result.ciPassing).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.noConflicts).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("reports merge conflicts as blocker", async () => {
    const scm = create();

    // getPRState
    mockGlabSuccess(JSON.stringify({ state: "opened" }));
    // mr view for details
    mockGlabSuccess(JSON.stringify({
      has_conflicts: true,
      merge_status: "cannot_be_merged",
      draft: false,
      blocking_discussions_resolved: true,
    }));
    // getCISummary -> getCIChecks -> pipelines (empty)
    mockGlabSuccess(JSON.stringify([]));
    // getReviewDecision
    mockGlabSuccess(JSON.stringify({ approved: true, approvals_required: 1, approvals_left: 0 }));

    const result = await scm.getMergeability(makePR());

    expect(result.noConflicts).toBe(false);
    expect(result.blockers).toContain("Merge conflicts");
  });

  it("reports draft status as blocker", async () => {
    const scm = create();

    // getPRState
    mockGlabSuccess(JSON.stringify({ state: "opened" }));
    // mr view details
    mockGlabSuccess(JSON.stringify({
      has_conflicts: false,
      merge_status: "can_be_merged",
      draft: true,
      blocking_discussions_resolved: true,
    }));
    // getCISummary -> pipelines (empty -> none)
    mockGlabSuccess(JSON.stringify([]));
    // getReviewDecision
    mockGlabSuccess(JSON.stringify({ approved: true, approvals_required: 1, approvals_left: 0 }));

    const result = await scm.getMergeability(makePR());

    expect(result.blockers).toContain("MR is still a draft");
  });

  it("reports unresolved blocking discussions", async () => {
    const scm = create();

    // getPRState
    mockGlabSuccess(JSON.stringify({ state: "opened" }));
    // mr view details
    mockGlabSuccess(JSON.stringify({
      has_conflicts: false,
      merge_status: "can_be_merged",
      draft: false,
      blocking_discussions_resolved: false,
    }));
    // getCISummary -> pipelines (empty)
    mockGlabSuccess(JSON.stringify([]));
    // getReviewDecision
    mockGlabSuccess(JSON.stringify({ approved: true, approvals_required: 1, approvals_left: 0 }));

    const result = await scm.getMergeability(makePR());

    expect(result.blockers).toContain("Unresolved blocking discussions");
  });

  it("reports approval required as blocker", async () => {
    const scm = create();

    // getPRState
    mockGlabSuccess(JSON.stringify({ state: "opened" }));
    // mr view details
    mockGlabSuccess(JSON.stringify({
      has_conflicts: false,
      merge_status: "can_be_merged",
      draft: false,
      blocking_discussions_resolved: true,
    }));
    // getCISummary -> pipelines (empty)
    mockGlabSuccess(JSON.stringify([]));
    // getReviewDecision
    mockGlabSuccess(JSON.stringify({ approved: false, approvals_required: 2, approvals_left: 1 }));

    const result = await scm.getMergeability(makePR());

    expect(result.approved).toBe(false);
    expect(result.blockers).toContain("Approval required");
  });

  it("reports CI failing as blocker", async () => {
    const scm = create();

    // getPRState
    mockGlabSuccess(JSON.stringify({ state: "opened" }));
    // mr view details
    mockGlabSuccess(JSON.stringify({
      has_conflicts: false,
      merge_status: "can_be_merged",
      draft: false,
      blocking_discussions_resolved: true,
    }));
    // getCISummary -> getCIChecks -> pipelines
    mockGlabSuccess(JSON.stringify([{ id: 1 }]));
    // getCIChecks -> jobs
    mockGlabSuccess(JSON.stringify([{ name: "test", status: "failed", web_url: "", started_at: null, finished_at: null }]));
    // getReviewDecision
    mockGlabSuccess(JSON.stringify({ approved: true, approvals_required: 1, approvals_left: 0 }));

    const result = await scm.getMergeability(makePR());

    expect(result.ciPassing).toBe(false);
    expect(result.blockers).toContain("CI is failing");
  });
});
