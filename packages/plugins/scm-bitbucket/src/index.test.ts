import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PRInfo, Session, ProjectConfig } from "@composio/ao-core";

/** Create a PRInfo for testing. */
function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 7,
    url: "https://bitbucket.org/acme/app/pull-requests/7",
    title: "Add feature",
    owner: "acme",
    repo: "app",
    branch: "feature-branch",
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
    branch: "feature-branch",
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

/** Create a mock fetch that returns ok JSON. */
function mockFetchOk(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

/** Create a mock fetch that returns an error. */
function mockFetchError(status: number, body = "error") {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
    text: () => Promise.resolve(body),
  });
}

import bitbucketPlugin, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Set required env vars for auth
  vi.stubEnv("BITBUCKET_USERNAME", "testuser");
  vi.stubEnv("BITBUCKET_APP_PASSWORD", "testpass");
});

describe("manifest", () => {
  it("has correct metadata", () => {
    expect(manifest.name).toBe("bitbucket");
    expect(manifest.slot).toBe("scm");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("SCM plugin: Bitbucket Pull Requests, Pipelines, Reviews");
  });

  it("default export includes manifest and create", () => {
    expect(bitbucketPlugin.manifest).toBe(manifest);
    expect(bitbucketPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns an SCM with name 'bitbucket'", () => {
    const scm = create();
    expect(scm.name).toBe("bitbucket");
  });
});

describe("detectPR()", () => {
  it("returns PRInfo when PR exists for branch", async () => {
    const fetchMock = mockFetchOk({
      values: [
        {
          id: 7,
          title: "Add feature",
          state: "OPEN",
          source: { branch: { name: "feature-branch" } },
          destination: { branch: { name: "main" } },
          links: { html: { href: "https://bitbucket.org/acme/app/pull-requests/7" } },
          author: { display_name: "Alice", nickname: "alice" },
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.detectPR(makeSession(), makeProject());

    expect(result).not.toBeNull();
    expect(result!.number).toBe(7);
    expect(result!.url).toBe("https://bitbucket.org/acme/app/pull-requests/7");
    expect(result!.title).toBe("Add feature");
    expect(result!.branch).toBe("feature-branch");
    expect(result!.baseBranch).toBe("main");
    expect(result!.isDraft).toBe(false);
  });

  it("returns null when no PR found", async () => {
    const fetchMock = mockFetchOk({ values: [] });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.detectPR(makeSession(), makeProject());
    expect(result).toBeNull();
  });

  it("returns null when session has no branch", async () => {
    const fetchMock = mockFetchOk({ values: [] });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.detectPR(
      makeSession({ branch: undefined }),
      makeProject(),
    );
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when API call fails", async () => {
    const fetchMock = mockFetchError(500);
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.detectPR(makeSession(), makeProject());
    expect(result).toBeNull();
  });

  it("throws on invalid repo format", async () => {
    const scm = create();
    await expect(
      scm.detectPR(makeSession(), makeProject({ repo: "noowner" })),
    ).rejects.toThrow('Invalid repo format "noowner"');
  });
});

describe("getPRState()", () => {
  it("returns 'open' for OPEN PR", async () => {
    const fetchMock = mockFetchOk({
      id: 7, state: "OPEN",
      source: { branch: { name: "b" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "" } },
      author: { display_name: "", nickname: "" },
      title: "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("open");
  });

  it("returns 'merged' for MERGED PR", async () => {
    const fetchMock = mockFetchOk({
      id: 7, state: "MERGED",
      source: { branch: { name: "b" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "" } },
      author: { display_name: "", nickname: "" },
      title: "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("merged");
  });

  it("returns 'closed' for DECLINED PR", async () => {
    const fetchMock = mockFetchOk({
      id: 7, state: "DECLINED",
      source: { branch: { name: "b" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "" } },
      author: { display_name: "", nickname: "" },
      title: "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("closed");
  });

  it("returns 'closed' for SUPERSEDED PR", async () => {
    const fetchMock = mockFetchOk({
      id: 7, state: "SUPERSEDED",
      source: { branch: { name: "b" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "" } },
      author: { display_name: "", nickname: "" },
      title: "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("closed");
  });
});

describe("mergePR()", () => {
  it("calls merge endpoint with squash strategy by default", async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.mergePR(makePR());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/pullrequests/7/merge");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.merge_strategy).toBe("squash");
    expect(body.close_source_branch).toBe(true);
  });

  it("uses merge_commit strategy for merge method", async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.mergePR(makePR(), "merge");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.merge_strategy).toBe("merge_commit");
  });

  it("uses fast_forward strategy for rebase method", async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.mergePR(makePR(), "rebase");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.merge_strategy).toBe("fast_forward");
  });
});

describe("closePR()", () => {
  it("calls decline endpoint", async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.closePR(makePR());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/pullrequests/7/decline");
    expect(opts.method).toBe("POST");
  });
});

describe("getCIChecks()", () => {
  it("returns mapped pipeline as CI check", async () => {
    const fetchMock = mockFetchOk({
      values: [
        {
          uuid: "{abc-123}",
          state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
          target: { ref_name: "feature-branch" },
          created_on: "2025-01-01T10:00:00Z",
          completed_on: "2025-01-01T10:05:00Z",
          build_number: 42,
        },
        {
          uuid: "{def-456}",
          state: { name: "COMPLETED", result: { name: "FAILED" } },
          target: { ref_name: "other-branch" },
          created_on: "2025-01-01T10:00:00Z",
          completed_on: null,
          build_number: 41,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());

    // Should only include pipeline for the PR branch
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe("Pipeline #42");
    expect(checks[0].status).toBe("passed");
    expect(checks[0].url).toContain("pipelines/results/42");
  });

  it("returns empty array when no pipelines for branch", async () => {
    const fetchMock = mockFetchOk({
      values: [
        {
          uuid: "{abc}",
          state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
          target: { ref_name: "other-branch" },
          created_on: "2025-01-01",
          completed_on: "2025-01-01",
          build_number: 1,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());
    expect(checks).toEqual([]);
  });

  it("maps running state", async () => {
    const fetchMock = mockFetchOk({
      values: [
        {
          uuid: "{abc}",
          state: { name: "IN_PROGRESS" },
          target: { ref_name: "feature-branch" },
          created_on: "2025-01-01",
          completed_on: null,
          build_number: 10,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());
    expect(checks[0].status).toBe("running");
  });

  it("maps pending state", async () => {
    const fetchMock = mockFetchOk({
      values: [
        {
          uuid: "{abc}",
          state: { name: "PENDING" },
          target: { ref_name: "feature-branch" },
          created_on: "2025-01-01",
          completed_on: null,
          build_number: 10,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());
    expect(checks[0].status).toBe("pending");
  });

  it("maps stopped pipeline to skipped", async () => {
    const fetchMock = mockFetchOk({
      values: [
        {
          uuid: "{abc}",
          state: { name: "COMPLETED", result: { name: "STOPPED" } },
          target: { ref_name: "feature-branch" },
          created_on: "2025-01-01",
          completed_on: "2025-01-01",
          build_number: 10,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());
    expect(checks[0].status).toBe("skipped");
  });

  it("throws on API failure", async () => {
    const fetchMock = mockFetchError(500, "server error");
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await expect(scm.getCIChecks(makePR())).rejects.toThrow("Failed to fetch CI checks");
  });
});

describe("getCISummary()", () => {
  it("returns 'passing' when pipeline is successful", async () => {
    const fetchMock = mockFetchOk({
      values: [
        {
          uuid: "{a}",
          state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
          target: { ref_name: "feature-branch" },
          created_on: "2025-01-01",
          completed_on: "2025-01-01",
          build_number: 1,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getCISummary(makePR())).toBe("passing");
  });

  it("returns 'none' when no pipelines for branch", async () => {
    const fetchMock = mockFetchOk({ values: [] });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getCISummary(makePR())).toBe("none");
  });
});

describe("getReviews()", () => {
  it("returns reviewers with their states", async () => {
    const fetchMock = mockFetchOk({
      id: 7,
      state: "OPEN",
      source: { branch: { name: "b" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "" } },
      author: { display_name: "", nickname: "" },
      title: "",
      participants: [
        { user: { display_name: "Alice", nickname: "alice" }, role: "REVIEWER", approved: true, state: null, participated_on: "2025-01-01T10:00:00Z" },
        { user: { display_name: "Bob", nickname: "bob" }, role: "REVIEWER", approved: false, state: "changes_requested", participated_on: "2025-01-01T11:00:00Z" },
        { user: { display_name: "Charlie", nickname: "charlie" }, role: "PARTICIPANT", approved: false, state: null, participated_on: "2025-01-01T12:00:00Z" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const reviews = await scm.getReviews(makePR());

    // Only REVIEWER role participants
    expect(reviews).toHaveLength(2);
    expect(reviews[0].author).toBe("alice");
    expect(reviews[0].state).toBe("approved");
    expect(reviews[1].author).toBe("bob");
    expect(reviews[1].state).toBe("changes_requested");
  });

  it("returns empty array on error", async () => {
    const fetchMock = mockFetchError(500);
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const reviews = await scm.getReviews(makePR());
    expect(reviews).toEqual([]);
  });
});

describe("getReviewDecision()", () => {
  it("returns 'approved' when a reviewer has approved", async () => {
    const fetchMock = mockFetchOk({
      id: 7, state: "OPEN",
      source: { branch: { name: "b" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "" } },
      author: { display_name: "", nickname: "" },
      title: "",
      participants: [
        { user: { display_name: "Alice", nickname: "alice" }, role: "REVIEWER", approved: true, state: null, participated_on: "2025-01-01" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getReviewDecision(makePR())).toBe("approved");
  });

  it("returns 'changes_requested' when reviewer requests changes", async () => {
    const fetchMock = mockFetchOk({
      id: 7, state: "OPEN",
      source: { branch: { name: "b" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "" } },
      author: { display_name: "", nickname: "" },
      title: "",
      participants: [
        { user: { display_name: "Alice", nickname: "alice" }, role: "REVIEWER", approved: false, state: "changes_requested", participated_on: "2025-01-01" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getReviewDecision(makePR())).toBe("changes_requested");
  });

  it("returns 'pending' when reviewer has not approved", async () => {
    const fetchMock = mockFetchOk({
      id: 7, state: "OPEN",
      source: { branch: { name: "b" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "" } },
      author: { display_name: "", nickname: "" },
      title: "",
      participants: [
        { user: { display_name: "Alice", nickname: "alice" }, role: "REVIEWER", approved: false, state: null, participated_on: "2025-01-01" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getReviewDecision(makePR())).toBe("pending");
  });

  it("returns 'none' when no reviewers", async () => {
    const fetchMock = mockFetchOk({
      id: 7, state: "OPEN",
      source: { branch: { name: "b" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "" } },
      author: { display_name: "", nickname: "" },
      title: "",
      participants: [],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getReviewDecision(makePR())).toBe("none");
  });
});

describe("getMergeability()", () => {
  it("returns fully mergeable when everything passes", async () => {
    // This calls multiple endpoints in sequence. We need a fetch that
    // returns different results for different URLs.
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/pullrequests/7/diffstat")) {
        return Promise.resolve({
          ok: true, status: 200, statusText: "OK",
          text: () => Promise.resolve(JSON.stringify({ values: [{ status: "modified" }] })),
        });
      }
      if (urlStr.includes("/pipelines/")) {
        return Promise.resolve({
          ok: true, status: 200, statusText: "OK",
          text: () => Promise.resolve(JSON.stringify({ values: [] })),
        });
      }
      // Default: PR data (used by getPRState, getReviews, and conflict check)
      return Promise.resolve({
        ok: true, status: 200, statusText: "OK",
        text: () => Promise.resolve(JSON.stringify({
          id: 7, state: "OPEN", title: "Add feature",
          source: { branch: { name: "feature-branch" } },
          destination: { branch: { name: "main" } },
          links: { html: { href: "" } },
          author: { display_name: "", nickname: "" },
          participants: [
            { user: { display_name: "Alice", nickname: "alice" }, role: "REVIEWER", approved: true, state: null, participated_on: "2025-01-01" },
          ],
          merge_commit: null,
        })),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.getMergeability(makePR());

    expect(result.mergeable).toBe(true);
    expect(result.ciPassing).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.noConflicts).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("returns already merged as fully mergeable", async () => {
    const fetchMock = mockFetchOk({
      id: 7, state: "MERGED",
      source: { branch: { name: "b" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "" } },
      author: { display_name: "", nickname: "" },
      title: "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.getMergeability(makePR());

    expect(result.mergeable).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("reports merge conflicts as blocker", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/diffstat")) {
        return Promise.resolve({
          ok: true, status: 200, statusText: "OK",
          text: () => Promise.resolve(JSON.stringify({
            values: [{ status: "merge conflict" }],
          })),
        });
      }
      if (urlStr.includes("/pipelines/")) {
        return Promise.resolve({
          ok: true, status: 200, statusText: "OK",
          text: () => Promise.resolve(JSON.stringify({ values: [] })),
        });
      }
      return Promise.resolve({
        ok: true, status: 200, statusText: "OK",
        text: () => Promise.resolve(JSON.stringify({
          id: 7, state: "OPEN", title: "",
          source: { branch: { name: "b" } },
          destination: { branch: { name: "main" } },
          links: { html: { href: "" } },
          author: { display_name: "", nickname: "" },
          participants: [
            { user: { display_name: "Alice", nickname: "alice" }, role: "REVIEWER", approved: true, state: null, participated_on: "2025-01-01" },
          ],
          merge_commit: null,
        })),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.getMergeability(makePR());

    expect(result.noConflicts).toBe(false);
    expect(result.blockers).toContain("Merge conflicts");
  });
});

describe("getPendingComments()", () => {
  it("returns inline comments from non-bot users", async () => {
    const fetchMock = mockFetchOk({
      values: [
        {
          id: 100,
          user: { display_name: "Alice", nickname: "alice" },
          content: { raw: "Fix this line" },
          inline: { path: "src/main.ts", to: 42 },
          created_on: "2025-01-01T10:00:00Z",
          links: { html: { href: "https://bitbucket.org/comment/100" } },
        },
        {
          id: 101,
          user: { display_name: "Codecov Bot", nickname: "codecov-bot" },
          content: { raw: "Coverage report" },
          inline: { path: "src/main.ts", to: 10 },
          created_on: "2025-01-01T10:00:00Z",
          links: { html: { href: "https://bitbucket.org/comment/101" } },
        },
        {
          id: 102,
          user: { display_name: "Bob", nickname: "bob" },
          content: { raw: "General comment" },
          created_on: "2025-01-01T10:00:00Z",
          links: { html: { href: "https://bitbucket.org/comment/102" } },
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const comments = await scm.getPendingComments(makePR());

    // Only inline comments from non-bot users
    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe("100");
    expect(comments[0].author).toBe("alice");
    expect(comments[0].body).toBe("Fix this line");
    expect(comments[0].path).toBe("src/main.ts");
    expect(comments[0].line).toBe(42);
  });

  it("returns empty array on error", async () => {
    const fetchMock = mockFetchError(500);
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const comments = await scm.getPendingComments(makePR());
    expect(comments).toEqual([]);
  });
});

describe("auth handling", () => {
  it("throws when BITBUCKET_USERNAME is not set", async () => {
    vi.stubEnv("BITBUCKET_USERNAME", "");
    vi.stubEnv("BITBUCKET_APP_PASSWORD", "testpass");
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await expect(scm.getPRState(makePR())).rejects.toThrow(
      "BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD environment variables are required",
    );
  });

  it("throws when BITBUCKET_APP_PASSWORD is not set", async () => {
    vi.stubEnv("BITBUCKET_USERNAME", "testuser");
    vi.stubEnv("BITBUCKET_APP_PASSWORD", "");
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await expect(scm.getPRState(makePR())).rejects.toThrow(
      "BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD environment variables are required",
    );
  });

  it("includes Basic auth header in requests", async () => {
    const fetchMock = mockFetchOk({
      id: 7, state: "OPEN",
      source: { branch: { name: "b" } },
      destination: { branch: { name: "main" } },
      links: { html: { href: "" } },
      author: { display_name: "", nickname: "" },
      title: "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.getPRState(makePR());

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toMatch(/^Basic /);
  });
});
