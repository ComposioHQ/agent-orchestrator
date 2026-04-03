import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockReadFile, mockRealpath } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockRealpath: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
  realpath: mockRealpath,
  default: { readFile: mockReadFile, realpath: mockRealpath },
}));

vi.mock("@/lib/portfolio-services", () => ({
  getPortfolioServices: vi.fn(() => ({
    portfolio: [{ id: "proj-a", name: "Project A", repoPath: "/tmp/proj-a" }],
  })),
}));

vi.mock("@/lib/path-security", () => ({
  assertPathWithinHome: vi.fn(async (p: string) => p),
  isWithinDirectory: vi.fn((parent: string, child: string) => child.startsWith(parent)),
}));

import { GET } from "../route";

function makeContext(id: string) { return { params: Promise.resolve({ id }) }; }

beforeEach(async () => {
  vi.clearAllMocks();
  mockRealpath.mockImplementation(async (p: string) => String(p));
  const { isWithinDirectory } = await import("@/lib/path-security");
  (isWithinDirectory as ReturnType<typeof vi.fn>).mockImplementation(
    (parent: string, child: string) => child.startsWith(parent),
  );
});

describe("GET /api/projects/[id]/favicon", () => {
  it("returns 404 when project not found", async () => {
    const res = await GET(new Request("http://localhost/api/projects/unknown/favicon"), makeContext("unknown"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when assertPathWithinHome rejects", async () => {
    const { assertPathWithinHome } = await import("@/lib/path-security");
    (assertPathWithinHome as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("outside"));
    const res = await GET(new Request("http://localhost/api/projects/proj-a/favicon"), makeContext("proj-a"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when no favicon found", async () => {
    mockRealpath.mockImplementation(async () => { throw new Error("ENOENT"); });
    const res = await GET(new Request("http://localhost/api/projects/proj-a/favicon"), makeContext("proj-a"));
    expect(res.status).toBe(404);
  });

  it("skips symlink outside repo path", async () => {
    const { isWithinDirectory } = await import("@/lib/path-security");
    (isWithinDirectory as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mockRealpath.mockResolvedValue("/etc/evil/favicon.ico");
    mockReadFile.mockResolvedValue(Buffer.from("evil"));
    const res = await GET(new Request("http://localhost/api/projects/proj-a/favicon"), makeContext("proj-a"));
    expect(res.status).toBe(404);
  });

  it("returns favicon.ico with image/x-icon content type", async () => {
    mockRealpath.mockResolvedValue("/tmp/proj-a/public/favicon.ico");
    mockReadFile.mockResolvedValue(Buffer.from("icodata"));
    const res = await GET(new Request("http://localhost/api/projects/proj-a/favicon"), makeContext("proj-a"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/x-icon");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("returns favicon.png with image/png content type", async () => {
    // Make the first candidate (favicon.ico) fail, then succeed on favicon.png
    mockRealpath
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValue("/tmp/proj-a/public/favicon.png");
    mockReadFile.mockResolvedValue(Buffer.from("pngdata"));
    const res = await GET(new Request("http://localhost/api/projects/proj-a/favicon"), makeContext("proj-a"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("returns correct body from file read", async () => {
    const fileContent = Buffer.from("faviconbytes");
    mockRealpath.mockResolvedValue("/tmp/proj-a/public/favicon.ico");
    mockReadFile.mockResolvedValue(fileContent);
    const res = await GET(new Request("http://localhost/api/projects/proj-a/favicon"), makeContext("proj-a"));
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(Buffer.from(body).toString()).toBe("faviconbytes");
  });
});
