import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile, realpath } from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, readFile: vi.fn(), realpath: vi.fn() };
});

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

const mockReadFile = vi.mocked(readFile);
const mockRealpath = vi.mocked(realpath);

function makeContext(id: string) { return { params: Promise.resolve({ id }) }; }

beforeEach(() => { vi.clearAllMocks(); mockRealpath.mockImplementation(async (p) => String(p)); });

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
    mockRealpath.mockRejectedValue(new Error("ENOENT") as never);
    const res = await GET(new Request("http://localhost/api/projects/proj-a/favicon"), makeContext("proj-a"));
    expect(res.status).toBe(404);
  });

  it("skips symlink outside repo path", async () => {
    const { isWithinDirectory } = await import("@/lib/path-security");
    (isWithinDirectory as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mockRealpath.mockResolvedValue("/etc/evil/favicon.ico" as never);
    mockReadFile.mockResolvedValue(Buffer.from("evil") as never);
    const res = await GET(new Request("http://localhost/api/projects/proj-a/favicon"), makeContext("proj-a"));
    expect(res.status).toBe(404);
  });
});
