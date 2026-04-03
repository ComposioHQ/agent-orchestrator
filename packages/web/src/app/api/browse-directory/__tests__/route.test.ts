import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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

beforeEach(() => {
  vi.clearAllMocks();
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

  it("returns 400 or 500 when path does not exist on disk", async () => {
    // stat throws ENOENT for non-existent paths -> .catch(() => null) -> 400
    const res = await GET(makeRequest("nonexistent-dir-that-does-not-exist"));
    expect([400, 500]).toContain(res.status);
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
});
