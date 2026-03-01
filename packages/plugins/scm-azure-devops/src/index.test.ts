import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PRInfo, Session, ProjectConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42",
    title: "Add feature",
    owner: "MyProject",
    repo: "myrepo",
    branch: "feature-branch",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

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

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "My Project",
    repo: "MyProject/myrepo",
    ...overrides,
  } as ProjectConfig;
}

function mockFetchOk(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockFetchError(status: number, body = "error") {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
    text: () => Promise.resolve(body),
  });
}

import azureDevopsPlugin, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("AZURE_DEVOPS_ORG", "myorg");
  vi.stubEnv("AZURE_DEVOPS_PAT", "testpat");
});

describe("manifest", () => {
  it("has correct metadata", () => {
    expect(manifest.name).toBe("azure-devops");
    expect(manifest.slot).toBe("scm");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe(
      "SCM plugin: Azure DevOps Pull Requests, Build Pipelines, Reviews",
    );
  });

  it("default export includes manifest and create", () => {
    expect(azureDevopsPlugin.manifest).toBe(manifest);
    expect(azureDevopsPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns an SCM with name 'azure-devops'", () => {
    const scm = create();
    expect(scm.name).toBe("azure-devops");
  });
});

describe("detectPR()", () => {
  it("returns PRInfo when PR exists for branch", async () => {
    const fetchMock = mockFetchOk({
      value: [
        {
          pullRequestId: 42,
          title: "Add feature",
          status: "active",
          sourceRefName: "refs/heads/feature-branch",
          targetRefName: "refs/heads/main",
          isDraft: false,
          createdBy: { displayName: "Alice", uniqueName: "alice@example.com" },
          reviewers: [],
          mergeStatus: "succeeded",
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.detectPR(makeSession(), makeProject());

    expect(result).not.toBeNull();
    expect(result!.number).toBe(42);
    expect(result!.title).toBe("Add feature");
    expect(result!.branch).toBe("feature-branch");
    expect(result!.baseBranch).toBe("main");
    expect(result!.isDraft).toBe(false);
  });

  it("returns null when no PR found", async () => {
    const fetchMock = mockFetchOk({ value: [] });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.detectPR(makeSession(), makeProject());
    expect(result).toBeNull();
  });

  it("returns null when session has no branch", async () => {
    const fetchMock = mockFetchOk({ value: [] });
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
      scm.detectPR(makeSession(), makeProject({ repo: "noslash" })),
    ).rejects.toThrow('Invalid repo format "noslash"');
  });
});

describe("getPRState()", () => {
  it("returns 'open' for active PR", async () => {
    const fetchMock = mockFetchOk({
      pullRequestId: 42,
      status: "active",
      sourceRefName: "refs/heads/b",
      targetRefName: "refs/heads/main",
      reviewers: [],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("open");
  });

  it("returns 'merged' for completed PR", async () => {
    const fetchMock = mockFetchOk({
      pullRequestId: 42,
      status: "completed",
      sourceRefName: "refs/heads/b",
      targetRefName: "refs/heads/main",
      reviewers: [],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("merged");
  });

  it("returns 'closed' for abandoned PR", async () => {
    const fetchMock = mockFetchOk({
      pullRequestId: 42,
      status: "abandoned",
      sourceRefName: "refs/heads/b",
      targetRefName: "refs/heads/main",
      reviewers: [],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("closed");
  });
});

describe("mergePR()", () => {
  it("calls PATCH with squash strategy by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            lastMergeSourceCommit: { commitId: "abc123" },
          }),
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.mergePR(makePR());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, opts] = fetchMock.mock.calls[1];
    expect(opts.method).toBe("PATCH");
    const body = JSON.parse(opts.body);
    expect(body.completionOptions.mergeStrategy).toBe(3); // squash
    expect(body.completionOptions.deleteSourceBranch).toBe(true);
  });

  it("uses merge_commit strategy for merge method", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({ lastMergeSourceCommit: { commitId: "abc" } }),
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.mergePR(makePR(), "merge");

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.completionOptions.mergeStrategy).toBe(1);
  });

  it("uses rebase strategy for rebase method", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({ lastMergeSourceCommit: { commitId: "abc" } }),
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.mergePR(makePR(), "rebase");

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.completionOptions.mergeStrategy).toBe(2);
  });
});

describe("closePR()", () => {
  it("calls PATCH with abandoned status", async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.closePR(makePR());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe("PATCH");
    const body = JSON.parse(opts.body);
    expect(body.status).toBe("abandoned");
  });
});

describe("getCIChecks()", () => {
  it("returns mapped builds as CI checks", async () => {
    const fetchMock = mockFetchOk({
      value: [
        {
          id: 1,
          buildNumber: "20250101.1",
          status: "completed",
          result: "succeeded",
          definition: { name: "CI Pipeline" },
          startTime: "2025-01-01T10:00:00Z",
          finishTime: "2025-01-01T10:05:00Z",
          _links: { web: { href: "https://dev.azure.com/build/1" } },
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());

    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe("CI Pipeline");
    expect(checks[0].status).toBe("passed");
    expect(checks[0].url).toBe("https://dev.azure.com/build/1");
  });

  it("returns empty array when no builds", async () => {
    const fetchMock = mockFetchOk({ value: [] });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());
    expect(checks).toEqual([]);
  });

  it("maps failed build", async () => {
    const fetchMock = mockFetchOk({
      value: [
        {
          id: 1,
          buildNumber: "1",
          status: "completed",
          result: "failed",
          definition: { name: "CI" },
          startTime: "2025-01-01",
          finishTime: "2025-01-01",
          _links: { web: { href: "" } },
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());
    expect(checks[0].status).toBe("failed");
  });

  it("maps in-progress build", async () => {
    const fetchMock = mockFetchOk({
      value: [
        {
          id: 1,
          buildNumber: "1",
          status: "inProgress",
          result: null,
          definition: { name: "CI" },
          startTime: "2025-01-01",
          finishTime: null,
          _links: { web: { href: "" } },
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());
    expect(checks[0].status).toBe("running");
  });

  it("maps canceled build to skipped", async () => {
    const fetchMock = mockFetchOk({
      value: [
        {
          id: 1,
          buildNumber: "1",
          status: "completed",
          result: "canceled",
          definition: { name: "CI" },
          startTime: "2025-01-01",
          finishTime: "2025-01-01",
          _links: { web: { href: "" } },
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
    await expect(scm.getCIChecks(makePR())).rejects.toThrow(
      "Failed to fetch CI checks",
    );
  });
});

describe("getReviews()", () => {
  it("returns reviewers with their states", async () => {
    const fetchMock = mockFetchOk({
      pullRequestId: 42,
      status: "active",
      reviewers: [
        { displayName: "Alice", uniqueName: "alice@org", vote: 10, isRequired: true },
        { displayName: "Bob", uniqueName: "bob@org", vote: -10, isRequired: false },
        { displayName: "Charlie", uniqueName: "charlie@org", vote: 0, isRequired: false },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const reviews = await scm.getReviews(makePR());

    expect(reviews).toHaveLength(3);
    expect(reviews[0].author).toBe("alice@org");
    expect(reviews[0].state).toBe("approved");
    expect(reviews[1].state).toBe("changes_requested");
    expect(reviews[2].state).toBe("pending");
  });

  it("returns empty array on error", async () => {
    const fetchMock = mockFetchError(500);
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const reviews = await scm.getReviews(makePR());
    expect(reviews).toEqual([]);
  });
});

describe("getPendingComments()", () => {
  it("returns unresolved non-bot comments", async () => {
    const fetchMock = mockFetchOk({
      value: [
        {
          id: 1,
          status: "active",
          isDeleted: false,
          comments: [
            {
              id: 100,
              author: { displayName: "Alice", uniqueName: "alice@org" },
              content: "Fix this",
              commentType: "text",
              publishedDate: "2025-01-01T10:00:00Z",
            },
          ],
          threadContext: { filePath: "/src/main.ts", rightFileStart: { line: 42 } },
        },
        {
          id: 2,
          status: "closed",
          isDeleted: false,
          comments: [
            {
              id: 101,
              author: { displayName: "Bob", uniqueName: "bob@org" },
              content: "Resolved",
              commentType: "text",
              publishedDate: "2025-01-01T10:00:00Z",
            },
          ],
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const comments = await scm.getPendingComments(makePR());

    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe("1");
    expect(comments[0].author).toBe("Alice");
    expect(comments[0].body).toBe("Fix this");
    expect(comments[0].path).toBe("/src/main.ts");
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
  it("throws when AZURE_DEVOPS_ORG is not set", async () => {
    vi.stubEnv("AZURE_DEVOPS_ORG", "");
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await expect(scm.getPRState(makePR())).rejects.toThrow(
      "AZURE_DEVOPS_ORG environment variable is required",
    );
  });

  it("throws when AZURE_DEVOPS_PAT is not set", async () => {
    vi.stubEnv("AZURE_DEVOPS_PAT", "");
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await expect(scm.getPRState(makePR())).rejects.toThrow(
      "AZURE_DEVOPS_PAT environment variable is required",
    );
  });

  it("includes Basic auth header in requests", async () => {
    const fetchMock = mockFetchOk({
      pullRequestId: 42,
      status: "active",
      sourceRefName: "refs/heads/b",
      targetRefName: "refs/heads/main",
      reviewers: [],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.getPRState(makePR());

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toMatch(/^Basic /);
  });
});
