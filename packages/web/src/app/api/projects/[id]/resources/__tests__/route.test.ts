import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFileAsync } = vi.hoisted(() => ({ mockExecFileAsync: vi.fn() }));

vi.mock("node:child_process", () => {
  const fakeExecFile = Object.assign(
    (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        mockExecFileAsync(...args.slice(0, -1))
          .then((result: unknown) => (cb as (err: null, r: unknown) => void)(null, result))
          .catch((err: unknown) => (cb as (err: unknown) => void)(err));
      }
    },
    { __promisify__: mockExecFileAsync },
  );
  return { execFile: fakeExecFile, default: { execFile: fakeExecFile } };
});

vi.mock("@/lib/portfolio-services", () => ({
  getPortfolioServices: vi.fn(() => ({
    portfolio: [{ id: "proj-a", name: "Project A", repo: "acme/proj-a", repoPath: "/tmp/proj-a" }],
  })),
}));

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({ registry: { get: vi.fn(() => undefined) } })),
}));

vi.mock("@composio/ao-core", () => ({
  resolveProjectConfig: vi.fn((project: { id: string }) => {
    if (project.id === "proj-a") return { project: { name: "Project A", tracker: null } };
    return null;
  }),
}));

import { GET } from "../route";

function makeContext(id: string) { return { params: Promise.resolve({ id }) }; }
function makeRequest(id: string, query = ""): Request {
  const url = new URL(`http://localhost/api/projects/${id}/resources`);
  if (query) url.searchParams.set("q", query);
  return new Request(url.toString());
}

beforeEach(() => { vi.clearAllMocks(); mockExecFileAsync.mockResolvedValue({ stdout: "[]", stderr: "" }); });

describe("GET /api/projects/[id]/resources", () => {
  it("returns 404 when project not found", async () => {
    const res = await GET(makeRequest("nonexistent"), makeContext("nonexistent"));
    expect(res.status).toBe(404);
  });

  it("returns 422 when config cannot be resolved", async () => {
    const { resolveProjectConfig } = await import("@composio/ao-core");
    (resolveProjectConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    expect(res.status).toBe(422);
  });

  it("returns empty resources when no data available", async () => {
    mockExecFileAsync.mockImplementation(async (cmd: string) => {
      if (cmd === "gh") return { stdout: "[]", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pullRequests).toEqual([]);
    expect(data.branches).toEqual([]);
    expect(data.issues).toEqual([]);
  });

  it("returns pull requests from gh CLI", async () => {
    const prJson = JSON.stringify([{
      number: 42, title: "feat: add tests", author: { login: "dev" },
      headRefName: "feat/tests", url: "https://github.com/acme/proj-a/pull/42",
    }]);
    mockExecFileAsync.mockImplementation(async (cmd: string) => {
      if (cmd === "gh") return { stdout: prJson, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    const data = await res.json();
    expect(data.pullRequests).toHaveLength(1);
    expect(data.pullRequests[0].number).toBe(42);
  });

  it("gracefully handles gh CLI failure", async () => {
    mockExecFileAsync.mockImplementation(async (cmd: string) => {
      if (cmd === "gh") throw new Error("gh not installed");
      return { stdout: "", stderr: "" };
    });
    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pullRequests).toEqual([]);
  });

  it("returns 500 on unexpected error", async () => {
    const { resolveProjectConfig } = await import("@composio/ao-core");
    (resolveProjectConfig as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error("crash"); });
    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    expect(res.status).toBe(500);
  });

  it("filters pull requests by query string", async () => {
    const prJson = JSON.stringify([
      { number: 1, title: "feat: add search", author: { login: "alice" }, headRefName: "feat/search", url: "https://github.com/acme/proj-a/pull/1" },
      { number: 2, title: "fix: login bug", author: { login: "bob" }, headRefName: "fix/login", url: "https://github.com/acme/proj-a/pull/2" },
    ]);
    mockExecFileAsync.mockImplementation(async (cmd: string) => {
      if (cmd === "gh") return { stdout: prJson, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const res = await GET(makeRequest("proj-a", "search"), makeContext("proj-a"));
    const data = await res.json();
    expect(data.pullRequests).toHaveLength(1);
    expect(data.pullRequests[0].title).toBe("feat: add search");
  });

  it("skips invalid entries in gh CLI output", async () => {
    const prJson = JSON.stringify([
      { number: 1, title: "valid", author: { login: "dev" }, headRefName: "main", url: "https://github.com/acme/proj-a/pull/1" },
      { number: "not-a-number", title: "invalid" },
      null,
      "string",
    ]);
    mockExecFileAsync.mockImplementation(async (cmd: string) => {
      if (cmd === "gh") return { stdout: prJson, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    const data = await res.json();
    expect(data.pullRequests).toHaveLength(1);
    expect(data.pullRequests[0].number).toBe(1);
  });

  it("returns branches from git for-each-ref", async () => {
    const branchOutput = "main\x1fAlice\x1f2024-01-01T00:00:00+00:00\nfeat/test\x1fBob\x1f2024-02-01T00:00:00+00:00";
    mockExecFileAsync.mockImplementation(async (cmd: string) => {
      if (cmd === "gh") return { stdout: "[]", stderr: "" };
      if (cmd === "git") return { stdout: branchOutput, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    const data = await res.json();
    expect(data.branches).toHaveLength(2);
    const branchNames = data.branches.map((b: { name: string }) => b.name);
    expect(branchNames).toContain("main");
    expect(branchNames).toContain("feat/test");
  });

  it("filters branches by query string", async () => {
    const branchOutput = "main\x1fAlice\x1f2024-01-01\nfeat/search\x1fBob\x1f2024-02-01";
    mockExecFileAsync.mockImplementation(async (cmd: string) => {
      if (cmd === "gh") return { stdout: "[]", stderr: "" };
      if (cmd === "git") return { stdout: branchOutput, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const res = await GET(makeRequest("proj-a", "search"), makeContext("proj-a"));
    const data = await res.json();
    expect(data.branches).toHaveLength(1);
    expect(data.branches[0].name).toBe("feat/search");
  });

  it("skips malformed branch lines", async () => {
    const branchOutput = "main\x1fAlice\x1f2024-01-01\nbad\x1fextra\x1ffield\x1ftoomany";
    mockExecFileAsync.mockImplementation(async (cmd: string) => {
      if (cmd === "gh") return { stdout: "[]", stderr: "" };
      if (cmd === "git") return { stdout: branchOutput, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    const data = await res.json();
    expect(data.branches).toHaveLength(1);
    expect(data.branches[0].name).toBe("main");
  });

  it("gracefully handles git branch failure", async () => {
    mockExecFileAsync.mockImplementation(async (cmd: string) => {
      if (cmd === "gh") return { stdout: "[]", stderr: "" };
      if (cmd === "git") throw new Error("git not found");
      return { stdout: "", stderr: "" };
    });
    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.branches).toEqual([]);
  });

  it("returns issues from tracker when configured", async () => {
    const mockListIssues = vi.fn(async () => [
      { id: "ISS-1", title: "Fix bug", url: "https://github.com/acme/proj-a/issues/1", state: "open", assignee: "alice" },
      { id: "ISS-2", title: "Add feature", url: "https://github.com/acme/proj-a/issues/2", state: "open", assignee: undefined },
    ]);
    const { resolveProjectConfig } = await import("@composio/ao-core");
    (resolveProjectConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      project: { name: "Project A", tracker: { plugin: "github" } },
    });
    const { getServices } = await import("@/lib/services");
    (getServices as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      registry: { get: vi.fn(() => ({ listIssues: mockListIssues })) },
    });

    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    const data = await res.json();
    expect(data.issues).toHaveLength(2);
    expect(data.issues[0].id).toBe("ISS-1");
    expect(data.issues[0].assignee).toBe("alice");
  });

  it("filters issues by query string", async () => {
    const mockListIssues = vi.fn(async () => [
      { id: "ISS-1", title: "Fix login bug", url: "https://github.com/acme/proj-a/issues/1", state: "open" },
      { id: "ISS-2", title: "Add search feature", url: "https://github.com/acme/proj-a/issues/2", state: "open" },
    ]);
    const { resolveProjectConfig } = await import("@composio/ao-core");
    (resolveProjectConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      project: { name: "Project A", tracker: { plugin: "github" } },
    });
    const { getServices } = await import("@/lib/services");
    (getServices as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      registry: { get: vi.fn(() => ({ listIssues: mockListIssues })) },
    });

    const res = await GET(makeRequest("proj-a", "login"), makeContext("proj-a"));
    const data = await res.json();
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0].title).toBe("Fix login bug");
  });

  it("returns empty issues when tracker listIssues throws", async () => {
    const mockListIssues = vi.fn(async () => { throw new Error("tracker error"); });
    const { resolveProjectConfig } = await import("@composio/ao-core");
    (resolveProjectConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      project: { name: "Project A", tracker: { plugin: "github" } },
    });
    const { getServices } = await import("@/lib/services");
    (getServices as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      registry: { get: vi.fn(() => ({ listIssues: mockListIssues })) },
    });

    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.issues).toEqual([]);
  });

  it("returns empty issues when tracker has no listIssues method", async () => {
    const { resolveProjectConfig } = await import("@composio/ao-core");
    (resolveProjectConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      project: { name: "Project A", tracker: { plugin: "github" } },
    });
    const { getServices } = await import("@/lib/services");
    (getServices as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      registry: { get: vi.fn(() => ({ /* no listIssues */ })) },
    });

    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.issues).toEqual([]);
  });

  it("returns empty pull requests when repo is undefined", async () => {
    const { getPortfolioServices } = await import("@/lib/portfolio-services");
    (getPortfolioServices as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      portfolio: [{ id: "proj-a", name: "Project A", repo: undefined, repoPath: "/tmp/proj-a" }],
    });
    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pullRequests).toEqual([]);
  });

  it("returns 500 with generic message for non-Error throws", async () => {
    const { resolveProjectConfig } = await import("@composio/ao-core");
    (resolveProjectConfig as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw "string error"; });
    const res = await GET(makeRequest("proj-a"), makeContext("proj-a"));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Failed to load project resources");
  });
});
