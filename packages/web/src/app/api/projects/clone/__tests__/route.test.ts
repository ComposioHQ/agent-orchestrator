import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir, stat, writeFile } from "node:fs/promises";

const { mockExecFileAsync } = vi.hoisted(() => ({ mockExecFileAsync: vi.fn() }));

vi.mock("node:child_process", () => {
  const f = Object.assign(
    (...args: unknown[]) => { const cb = args[args.length - 1]; if (typeof cb === "function") { mockExecFileAsync(...args.slice(0, -1)).then((r: unknown) => (cb as (e: null, r: unknown) => void)(null, r)).catch((e: unknown) => (cb as (e: unknown) => void)(e)); } },
    { __promisify__: mockExecFileAsync },
  );
  return { execFile: f, default: { execFile: f } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, mkdir: vi.fn(), stat: vi.fn(), writeFile: vi.fn() };
});

vi.mock("@composio/ao-core", () => ({ configToYaml: vi.fn(() => "yaml"), findConfigFile: vi.fn(() => null), generateConfigFromUrl: vi.fn(() => ({ projects: { "my-repo": {} } })), loadConfig: vi.fn(() => ({ projects: { "existing-key": {} } })), parseRepoUrl: vi.fn(() => ({ owner: "acme", repo: "my-repo", cloneUrl: "https://github.com/acme/my-repo.git" })), sanitizeProjectId: vi.fn((n: string) => n.toLowerCase()) }));
vi.mock("@/lib/api-schemas", async () => { const { z } = await import("zod"); return { CloneProjectSchema: z.object({ url: z.string().url("A valid Git URL is required"), location: z.string().min(1, "Location is required") }) }; });
vi.mock("@/lib/local-project-config", () => ({ extractFlatLocalConfig: vi.fn(() => ({})) }));
vi.mock("@/lib/path-security", () => ({ assertPathWithinHome: vi.fn(async (p: string) => p) }));
vi.mock("@/lib/project-registration", () => ({ registerAndResolveProject: vi.fn(() => ({ id: "my-repo", name: "my-repo" })) }));

import { POST } from "../route";
const mockMkdir = vi.mocked(mkdir);
const mockStat = vi.mocked(stat);
const mockWriteFile = vi.mocked(writeFile);

beforeEach(() => {
  vi.clearAllMocks();
  mockStat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  mockMkdir.mockResolvedValue(undefined as never);
  mockWriteFile.mockResolvedValue(undefined);
  mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("POST /api/projects/clone", () => {
  it("returns 400 for missing url", async () => {
    const res = await POST(new Request("http://localhost/api/projects/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: "/tmp" }) }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid url", async () => {
    const res = await POST(new Request("http://localhost/api/projects/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "not-url", location: "/tmp" }) }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing location", async () => {
    const res = await POST(new Request("http://localhost/api/projects/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://github.com/a/b" }) }));
    expect(res.status).toBe(400);
  });

  it("returns 500 when clone fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("clone failed"));
    const res = await POST(new Request("http://localhost/api/projects/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://github.com/acme/my-repo", location: "/tmp/projects" }) }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain("clone failed");
  });

  it("returns 500 on path security failure", async () => {
    const { assertPathWithinHome } = await import("@/lib/path-security");
    (assertPathWithinHome as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("outside"));
    const res = await POST(new Request("http://localhost/api/projects/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://github.com/acme/my-repo", location: "/tmp" }) }));
    expect(res.status).toBe(500);
  });
});
