import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PRInfo, Session, ProjectConfig } from "@composio/ao-core";

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 7,
    url: "https://gitea.example.com/acme/app/pulls/7",
    title: "Add feature",
    owner: "acme",
    repo: "app",
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
    repo: "acme/app",
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

import giteaPlugin, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("GITEA_HOST", "https://gitea.example.com");
  vi.stubEnv("GITEA_TOKEN", "test-token");
});

describe("manifest", () => {
  it("has correct metadata", () => {
    expect(manifest.name).toBe("gitea");
    expect(manifest.slot).toBe("scm");
    expect(manifest.version).toBe("0.1.0");
  });

  it("default export includes manifest and create", () => {
    expect(giteaPlugin.manifest).toBe(manifest);
    expect(giteaPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns an SCM with name 'gitea'", () => {
    const scm = create();
    expect(scm.name).toBe("gitea");
  });
});

describe("detectPR()", () => {
  it("returns PRInfo when PR exists for branch", async () => {
    const fetchMock = mockFetchOk([
      {
        number: 7,
        title: "Add feature",
        state: "open",
        merged: false,
        head: { ref: "feature-branch", sha: "abc123" },
        base: { ref: "main" },
        html_url: "https://gitea.example.com/acme/app/pulls/7",
        user: { login: "alice" },
        additions: 10,
        deletions: 2,
        mergeable: true,
        draft: false,
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.detectPR(makeSession(), makeProject());

    expect(result).not.toBeNull();
    expect(result!.number).toBe(7);
    expect(result!.branch).toBe("feature-branch");
    expect(result!.baseBranch).toBe("main");
  });

  it("returns null when no PR found for branch", async () => {
    const fetchMock = mockFetchOk([
      {
        number: 8,
        title: "Other",
        state: "open",
        merged: false,
        head: { ref: "other-branch", sha: "def" },
        base: { ref: "main" },
        html_url: "",
        user: { login: "bob" },
        additions: 0,
        deletions: 0,
        mergeable: true,
        draft: false,
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.detectPR(makeSession(), makeProject());
    expect(result).toBeNull();
  });

  it("returns null when session has no branch", async () => {
    const fetchMock = mockFetchOk([]);
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.detectPR(
      makeSession({ branch: undefined }),
      makeProject(),
    );
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on invalid repo format", async () => {
    const scm = create();
    await expect(
      scm.detectPR(makeSession(), makeProject({ repo: "noowner" })),
    ).rejects.toThrow('Invalid repo format "noowner"');
  });
});

describe("getPRState()", () => {
  it("returns 'open' for open PR", async () => {
    const fetchMock = mockFetchOk({ state: "open", merged: false });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("open");
  });

  it("returns 'merged' for merged PR", async () => {
    const fetchMock = mockFetchOk({ state: "closed", merged: true });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("merged");
  });

  it("returns 'closed' for closed unmerged PR", async () => {
    const fetchMock = mockFetchOk({ state: "closed", merged: false });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("closed");
  });
});

describe("mergePR()", () => {
  it("calls merge endpoint with squash by default", async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.mergePR(makePR());

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/pulls/7/merge");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.Do).toBe("squash");
    expect(body.delete_branch_after_merge).toBe(true);
  });

  it("uses merge strategy for merge method", async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.mergePR(makePR(), "merge");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.Do).toBe("merge");
  });

  it("uses rebase strategy for rebase method", async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.mergePR(makePR(), "rebase");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.Do).toBe("rebase");
  });
});

describe("closePR()", () => {
  it("calls PATCH with closed state", async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.closePR(makePR());

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe("PATCH");
    const body = JSON.parse(opts.body);
    expect(body.state).toBe("closed");
  });
});

describe("getCIChecks()", () => {
  it("returns mapped commit statuses", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/pulls/7")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({ head: { sha: "abc123" }, state: "open", merged: false }),
            ),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify([
              {
                id: 1,
                context: "CI/build",
                status: "success",
                target_url: "https://ci.example.com/1",
                description: "Build passed",
                created_at: "2025-01-01T10:00:00Z",
                updated_at: "2025-01-01T10:05:00Z",
              },
            ]),
          ),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());

    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe("CI/build");
    expect(checks[0].status).toBe("passed");
  });

  it("maps failure status", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/pulls/")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(JSON.stringify({ head: { sha: "abc" } })),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify([
              { id: 1, context: "CI", status: "failure", target_url: "", description: "", created_at: "", updated_at: "" },
            ]),
          ),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());
    expect(checks[0].status).toBe("failed");
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
  it("returns mapped reviews", async () => {
    const fetchMock = mockFetchOk([
      { id: 1, user: { login: "alice" }, state: "APPROVED", body: "", submitted_at: "2025-01-01T10:00:00Z" },
      { id: 2, user: { login: "bob" }, state: "REQUEST_CHANGES", body: "", submitted_at: "2025-01-01T11:00:00Z" },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const reviews = await scm.getReviews(makePR());

    expect(reviews).toHaveLength(2);
    expect(reviews[0].author).toBe("alice");
    expect(reviews[0].state).toBe("approved");
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

describe("getPendingComments()", () => {
  it("returns unresolved non-bot inline comments", async () => {
    const fetchMock = mockFetchOk([
      {
        id: 100,
        user: { login: "alice" },
        body: "Fix this line",
        path: "src/main.ts",
        line: 42,
        created_at: "2025-01-01T10:00:00Z",
        html_url: "https://gitea.example.com/comment/100",
        resolver: null,
      },
      {
        id: 101,
        user: { login: "codecov-bot" },
        body: "Coverage report",
        path: "src/main.ts",
        line: 10,
        created_at: "2025-01-01T10:00:00Z",
        html_url: "",
        resolver: null,
      },
      {
        id: 102,
        user: { login: "bob" },
        body: "General comment",
        path: "",
        line: null,
        created_at: "2025-01-01T10:00:00Z",
        html_url: "",
        resolver: null,
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const comments = await scm.getPendingComments(makePR());

    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe("100");
    expect(comments[0].author).toBe("alice");
    expect(comments[0].body).toBe("Fix this line");
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
  it("throws when GITEA_HOST is not set", async () => {
    vi.stubEnv("GITEA_HOST", "");
    const scm = create();
    await expect(scm.getPRState(makePR())).rejects.toThrow(
      "GITEA_HOST environment variable is required",
    );
  });

  it("throws when GITEA_TOKEN is not set", async () => {
    vi.stubEnv("GITEA_TOKEN", "");
    const scm = create();
    await expect(scm.getPRState(makePR())).rejects.toThrow(
      "GITEA_TOKEN environment variable is required",
    );
  });

  it("includes token auth header in requests", async () => {
    const fetchMock = mockFetchOk({ state: "open", merged: false });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.getPRState(makePR());

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("token test-token");
  });
});
