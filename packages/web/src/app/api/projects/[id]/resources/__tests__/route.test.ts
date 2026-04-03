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
});
