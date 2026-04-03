import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockReaddir, mockStat } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockStat: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  stat: mockStat,
  default: { readdir: mockReaddir, stat: mockStat },
}));

vi.mock("@/lib/path-security", () => ({
  resolveHomeScopedPath: vi.fn(async (rawPath?: string | null) => {
    const homePath = "/Users/test";
    const resolvedPath = rawPath ? `/Users/test/${rawPath.replace("~/", "")}` : homePath;
    return { homePath, resolvedPath };
  }),
  isWithinDirectory: vi.fn((parent: string, child: string) => child.startsWith(parent)),
}));

import { GET } from "../route";

function makeRequest(path?: string): NextRequest {
  const url = new URL("http://localhost/api/browse-directory");
  if (path) url.searchParams.set("path", path);
  return new NextRequest(url);
}

function makeDirEntry(name: string, isDir = true) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false, isSymbolicLink: () => false, path: "", parentPath: "" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStat.mockImplementation(async () => ({ isDirectory: () => true }));
  mockReaddir.mockResolvedValue([]);
});

describe("GET /api/browse-directory", () => {
  it("returns 403 when path is outside home", async () => {
    const { isWithinDirectory } = await import("@/lib/path-security");
    (isWithinDirectory as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

    const res = await GET(makeRequest("projects"));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("outside");
  });

  it("returns 400 when path is not a directory", async () => {
    mockStat.mockImplementation(async () => ({ isDirectory: () => false }));
    const res = await GET(makeRequest("some-file.txt"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Not a directory");
  });

  it("returns 400 when stat returns null (path does not exist)", async () => {
    mockStat.mockImplementation(async () => { throw new Error("ENOENT"); });
    const res = await GET(makeRequest("nonexistent"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Not a directory");
  });

  it("returns 500 when resolveHomeScopedPath throws", async () => {
    const { resolveHomeScopedPath } = await import("@/lib/path-security");
    (resolveHomeScopedPath as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("cannot resolve"),
    );

    const res = await GET(makeRequest("bad"));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("cannot resolve");
  });

  it("lists directories and skips files and hidden entries", async () => {
    mockReaddir
      .mockResolvedValueOnce([
        makeDirEntry("projects"),
        makeDirEntry("readme.md", false),
        makeDirEntry(".hidden"),
        makeDirEntry("node_modules"),
        makeDirEntry("docs"),
      ])
      // Children peek for "projects"
      .mockResolvedValueOnce([])
      // Children peek for "docs"
      .mockResolvedValueOnce([]);

    const res = await GET(makeRequest("code"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.directories).toHaveLength(2);
    expect(data.directories.map((d: { name: string }) => d.name)).toEqual(["docs", "projects"]);
  });

  it("detects hasChildren when sub-directory has visible directories", async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry("parent")])
      .mockResolvedValueOnce([makeDirEntry("child")]);

    const res = await GET(makeRequest("code"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.directories[0].hasChildren).toBe(true);
  });

  it("sets hasChildren false when sub-directory peek throws", async () => {
    mockReaddir
      .mockResolvedValueOnce([makeDirEntry("locked-dir")])
      .mockRejectedValueOnce(new Error("EACCES"));

    const res = await GET(makeRequest("code"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.directories[0].hasChildren).toBe(false);
  });

  it("detects .git and config markers", async () => {
    mockReaddir
      .mockResolvedValueOnce([
        makeDirEntry(".git"),
        makeDirEntry("agent-orchestrator.yaml", false),
        makeDirEntry("src"),
      ])
      // Children peek for "src"
      .mockResolvedValueOnce([]);

    const res = await GET(makeRequest("my-repo"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isGitRepo).toBe(true);
    expect(data.hasConfig).toBe(true);
  });

  it("returns parent as null when at home directory", async () => {
    const { resolveHomeScopedPath } = await import("@/lib/path-security");
    (resolveHomeScopedPath as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      homePath: "/Users/test",
      resolvedPath: "/Users/test",
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.parent).toBeNull();
    expect(data.path).toBe("/Users/test");
  });

  it("returns parent path when not at home directory", async () => {
    const res = await GET(makeRequest("code"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.parent).toBeTruthy();
  });

  it("returns generic error message for non-Error throws", async () => {
    const { resolveHomeScopedPath } = await import("@/lib/path-security");
    (resolveHomeScopedPath as ReturnType<typeof vi.fn>).mockRejectedValueOnce("string error");

    const res = await GET(makeRequest("bad"));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Failed to browse directory");
  });
});
