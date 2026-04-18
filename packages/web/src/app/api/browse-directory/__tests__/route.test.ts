import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockReaddir,
  mockStat,
  mockResolveWorkspaceBrowsePath,
  mockIsPortfolioEnabled,
} = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockStat: vi.fn(),
  mockResolveWorkspaceBrowsePath: vi.fn(),
  mockIsPortfolioEnabled: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  stat: mockStat,
  default: { readdir: mockReaddir, stat: mockStat },
}));

vi.mock("@aoagents/ao-core", () => ({
  isPortfolioEnabled: mockIsPortfolioEnabled,
}));

vi.mock("@/lib/filesystem-access", () => ({
  resolveWorkspaceBrowsePath: mockResolveWorkspaceBrowsePath,
}));

import { GET } from "../route";

function makeRequest(path?: string): NextRequest {
  const url = new URL("http://localhost/api/browse-directory");
  if (path) url.searchParams.set("path", path);
  return new NextRequest(url);
}

function makeDirEntry(name: string, isDir = true) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: "",
    parentPath: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsPortfolioEnabled.mockReturnValue(true);
  mockResolveWorkspaceBrowsePath.mockImplementation((rawPath?: string | null) => ({
    rootPath: "/Users/test",
    resolvedPath: rawPath ? rawPath : "/Users/test",
  }));
  mockStat.mockResolvedValue({ isDirectory: () => true });
  mockReaddir.mockResolvedValue([]);
});

describe("GET /api/browse-directory", () => {
  it("returns 404 when portfolio mode is disabled", async () => {
    mockIsPortfolioEnabled.mockReturnValueOnce(false);

    const res = await GET(makeRequest());

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: "Portfolio mode is disabled",
    });
  });

  it("returns 403 when path is outside the allowed root", async () => {
    mockResolveWorkspaceBrowsePath.mockImplementationOnce(() => {
      throw new Error("Access denied: Directory must be inside an allowed workspace root");
    });

    const res = await GET(makeRequest("/tmp/outside"));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "Access denied: Directory must be inside an allowed workspace root",
    });
  });

  it("returns 400 when path is not a directory", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const res = await GET(makeRequest("/Users/test/file.txt"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Not a directory: /Users/test/file.txt",
    });
  });

  it("returns 400 when stat throws", async () => {
    mockStat.mockRejectedValueOnce(new Error("ENOENT"));

    const res = await GET(makeRequest("/Users/test/missing"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Not a directory: /Users/test/missing",
    });
  });

  it("returns 500 for unexpected browse-path resolution errors", async () => {
    mockResolveWorkspaceBrowsePath.mockImplementationOnce(() => {
      throw new Error("cannot resolve");
    });

    const res = await GET(makeRequest("bad"));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "cannot resolve" });
  });

  it("lists visible directories in sorted order", async () => {
    mockReaddir
      .mockResolvedValueOnce([
        makeDirEntry("projects"),
        makeDirEntry("readme.md", false),
        makeDirEntry(".hidden"),
        makeDirEntry("node_modules"),
        makeDirEntry("docs"),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await GET(makeRequest("/Users/test/code"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.directories.map((entry: { name: string }) => entry.name)).toEqual(["docs", "projects"]);
  });

  it("detects hasChildren when a visible subdirectory exists", async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry("parent")])
      .mockResolvedValueOnce([makeDirEntry("child")]);

    const res = await GET(makeRequest("/Users/test/code"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.directories[0]).toMatchObject({ name: "parent", hasChildren: true });
  });

  it("treats unreadable children as leaf directories", async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry("locked-dir")])
      .mockRejectedValueOnce(new Error("EACCES"));

    const res = await GET(makeRequest("/Users/test/code"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.directories[0]).toMatchObject({ name: "locked-dir", hasChildren: false });
  });

  it("detects git and config markers", async () => {
    mockReaddir
      .mockResolvedValueOnce([
        makeDirEntry(".git"),
        makeDirEntry("agent-orchestrator.yaml", false),
        makeDirEntry("src"),
      ])
      .mockResolvedValueOnce([]);

    const res = await GET(makeRequest("/Users/test/my-repo"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.isGitRepo).toBe(true);
    expect(data.hasConfig).toBe(true);
  });

  it("returns rootPath and null parent at the root", async () => {
    mockResolveWorkspaceBrowsePath.mockImplementationOnce(() => ({
      rootPath: "/Users/test",
      resolvedPath: "/Users/test",
    }));

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.path).toBe("/Users/test");
    expect(data.rootPath).toBe("/Users/test");
    expect(data.parent).toBeNull();
  });

  it("returns the root as parent for one-level-deep paths", async () => {
    mockResolveWorkspaceBrowsePath.mockImplementationOnce(() => ({
      rootPath: "/Users/test",
      resolvedPath: "/Users/test/code",
    }));

    const res = await GET(makeRequest("/Users/test/code"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.parent).toBe("/Users/test");
  });

  it("returns generic error message for non-Error throws", async () => {
    mockResolveWorkspaceBrowsePath.mockImplementationOnce(() => {
      throw "string error";
    });

    const res = await GET(makeRequest("bad"));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: "Failed to browse directory",
    });
  });
});
