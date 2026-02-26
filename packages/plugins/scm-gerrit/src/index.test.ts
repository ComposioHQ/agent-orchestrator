import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PRInfo, Session, ProjectConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 12345,
    url: "https://gerrit.example.com/c/12345",
    title: "Refactor auth module",
    owner: "alice",
    repo: "my-project",
    branch: "topic/auth-refactor",
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
    branch: "topic/auth-refactor",
    createdAt: new Date(),
    ...overrides,
  } as Session;
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "My Project",
    repo: "my-project",
    defaultBranch: "main",
    ...overrides,
  } as ProjectConfig;
}

/** Gerrit responses are prefixed with )]}' */
function gerritJson(data: unknown): string {
  return `)]}'\n${JSON.stringify(data)}`;
}

function mockFetchOk(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(gerritJson(data)),
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

import gerritPlugin, { manifest, create } from "./index.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("GERRIT_HOST", "https://gerrit.example.com");
  vi.stubEnv("GERRIT_TOKEN", "test-token");
});

describe("manifest", () => {
  it("has correct metadata", () => {
    expect(manifest.name).toBe("gerrit");
    expect(manifest.slot).toBe("scm");
    expect(manifest.version).toBe("0.1.0");
  });

  it("default export includes manifest and create", () => {
    expect(gerritPlugin.manifest).toBe(manifest);
    expect(gerritPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns an SCM with name 'gerrit'", () => {
    const scm = create();
    expect(scm.name).toBe("gerrit");
  });
});

describe("detectPR()", () => {
  it("returns PRInfo when change exists", async () => {
    const fetchMock = mockFetchOk([
      {
        _number: 12345,
        subject: "Refactor auth module",
        status: "NEW",
        branch: "main",
        project: "my-project",
        owner: { _account_id: 1, username: "alice", name: "Alice" },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.detectPR(makeSession(), makeProject());

    expect(result).not.toBeNull();
    expect(result!.number).toBe(12345);
    expect(result!.title).toBe("Refactor auth module");
    expect(result!.owner).toBe("alice");
  });

  it("returns null when no changes found", async () => {
    const fetchMock = mockFetchOk([]);
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

  it("returns null when API call fails", async () => {
    const fetchMock = mockFetchError(500);
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const result = await scm.detectPR(makeSession(), makeProject());
    expect(result).toBeNull();
  });
});

describe("getPRState()", () => {
  it("returns 'open' for NEW change", async () => {
    const fetchMock = mockFetchOk({ _number: 12345, status: "NEW" });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("open");
  });

  it("returns 'merged' for MERGED change", async () => {
    const fetchMock = mockFetchOk({ _number: 12345, status: "MERGED" });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("merged");
  });

  it("returns 'closed' for ABANDONED change", async () => {
    const fetchMock = mockFetchOk({ _number: 12345, status: "ABANDONED" });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getPRState(makePR())).toBe("closed");
  });
});

describe("mergePR()", () => {
  it("calls submit endpoint", async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.mergePR(makePR());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/a/changes/12345/submit");
    expect(opts.method).toBe("POST");
  });
});

describe("closePR()", () => {
  it("calls abandon endpoint", async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.closePR(makePR());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/a/changes/12345/abandon");
    expect(opts.method).toBe("POST");
  });
});

describe("getCIChecks()", () => {
  it("returns verified label votes as CI checks", async () => {
    const fetchMock = mockFetchOk({
      _number: 12345,
      labels: {
        Verified: {
          all: [
            {
              value: 1,
              date: "2025-01-15 10:30:00.000000000",
              _account_id: 100,
              name: "CI Bot",
              username: "ci-bot",
            },
          ],
        },
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());

    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe("CI Bot");
    expect(checks[0].status).toBe("passed");
    expect(checks[0].conclusion).toBe("Verified +1");
  });

  it("maps negative vote to failed", async () => {
    const fetchMock = mockFetchOk({
      _number: 12345,
      labels: {
        Verified: {
          all: [
            { value: -1, date: "2025-01-15 10:30:00.000000000", _account_id: 100, name: "CI" },
          ],
        },
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());
    expect(checks[0].status).toBe("failed");
  });

  it("maps zero vote to pending", async () => {
    const fetchMock = mockFetchOk({
      _number: 12345,
      labels: {
        Verified: {
          all: [
            { value: 0, date: "2025-01-15 10:30:00.000000000", _account_id: 100, username: "ci" },
          ],
        },
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());
    expect(checks[0].status).toBe("pending");
  });

  it("returns empty when no Verified label", async () => {
    const fetchMock = mockFetchOk({ _number: 12345, labels: {} });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const checks = await scm.getCIChecks(makePR());
    expect(checks).toEqual([]);
  });
});

describe("getReviews()", () => {
  it("returns code review votes as reviews", async () => {
    const fetchMock = mockFetchOk({
      _number: 12345,
      labels: {
        "Code-Review": {
          all: [
            { value: 2, date: "2025-01-15 10:00:00.000000000", _account_id: 1, username: "alice" },
            { value: -2, date: "2025-01-15 11:00:00.000000000", _account_id: 2, username: "bob" },
            { value: 1, date: "2025-01-15 12:00:00.000000000", _account_id: 3, username: "charlie" },
            { value: -1, date: "2025-01-15 12:00:00.000000000", _account_id: 4, username: "dave" },
            { value: 0, date: "2025-01-15 12:00:00.000000000", _account_id: 5, username: "eve" },
          ],
        },
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const reviews = await scm.getReviews(makePR());

    expect(reviews).toHaveLength(5);
    expect(reviews[0].state).toBe("approved");
    expect(reviews[1].state).toBe("changes_requested");
    expect(reviews[2].state).toBe("commented");
    expect(reviews[3].state).toBe("changes_requested");
    expect(reviews[4].state).toBe("pending");
  });
});

describe("getReviewDecision()", () => {
  it("returns 'approved' when Code-Review has approval", async () => {
    const fetchMock = mockFetchOk({
      _number: 12345,
      labels: {
        "Code-Review": {
          approved: { _account_id: 1 },
          all: [{ value: 2, date: "2025-01-15 10:00:00.000000000", _account_id: 1 }],
        },
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getReviewDecision(makePR())).toBe("approved");
  });

  it("returns 'changes_requested' when Code-Review has rejection", async () => {
    const fetchMock = mockFetchOk({
      _number: 12345,
      labels: {
        "Code-Review": {
          rejected: { _account_id: 2 },
          all: [{ value: -2, date: "2025-01-15 10:00:00.000000000", _account_id: 2 }],
        },
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getReviewDecision(makePR())).toBe("changes_requested");
  });

  it("returns 'none' when no Code-Review label", async () => {
    const fetchMock = mockFetchOk({ _number: 12345, labels: {} });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    expect(await scm.getReviewDecision(makePR())).toBe("none");
  });
});

describe("getPendingComments()", () => {
  it("returns unresolved non-robot comments", async () => {
    const fetchMock = mockFetchOk({
      "src/main.ts": [
        {
          id: "comment-1",
          author: { _account_id: 1, username: "alice" },
          message: "Fix this line",
          path: "src/main.ts",
          line: 42,
          updated: "2025-01-15 10:30:00.000000000",
          unresolved: true,
        },
        {
          id: "comment-2",
          author: { _account_id: 2, username: "bot" },
          message: "Resolved",
          path: "src/main.ts",
          line: 10,
          updated: "2025-01-15 10:30:00.000000000",
          unresolved: false,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    const comments = await scm.getPendingComments(makePR());

    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe("comment-1");
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
  it("throws when GERRIT_HOST is not set", async () => {
    vi.stubEnv("GERRIT_HOST", "");
    const scm = create();
    await expect(scm.getPRState(makePR())).rejects.toThrow(
      "GERRIT_HOST environment variable is required",
    );
  });

  it("throws when no auth is provided", async () => {
    vi.stubEnv("GERRIT_TOKEN", "");
    const scm = create();
    await expect(scm.getPRState(makePR())).rejects.toThrow(
      "Gerrit auth is required",
    );
  });

  it("uses Bearer auth when GERRIT_TOKEN is set", async () => {
    const fetchMock = mockFetchOk({ _number: 12345, status: "NEW" });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.getPRState(makePR());

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });

  it("uses Basic auth when username/password are set", async () => {
    vi.stubEnv("GERRIT_TOKEN", "");
    vi.stubEnv("GERRIT_USERNAME", "user");
    vi.stubEnv("GERRIT_PASSWORD", "pass");
    const fetchMock = mockFetchOk({ _number: 12345, status: "NEW" });
    vi.stubGlobal("fetch", fetchMock);

    const scm = create();
    await scm.getPRState(makePR());

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toMatch(/^Basic /);
  });
});
