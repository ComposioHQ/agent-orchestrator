import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { existsSync } from "node:fs";

const { mockExecFileAsync } = vi.hoisted(() => ({ mockExecFileAsync: vi.fn() }));

vi.mock("node:child_process", () => {
  const f = Object.assign(
    (...args: unknown[]) => { const cb = args[args.length - 1]; if (typeof cb === "function") { mockExecFileAsync(...args.slice(0, -1)).then((r: unknown) => (cb as (e: null, r: unknown) => void)(null, r)).catch((e: unknown) => (cb as (e: unknown) => void)(e)); } },
    { __promisify__: mockExecFileAsync },
  );
  return { execFile: f, default: { execFile: f } };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, existsSync: vi.fn(() => false) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, writeFile: vi.fn(async () => {}) };
});

const mockGetAllProjects = vi.fn(() => [{ id: "proj-a", name: "Project A" }, { id: "proj-b", name: "Project B" }]);
vi.mock("@/lib/project-name", () => ({ getAllProjects: () => mockGetAllProjects() }));
vi.mock("@/lib/portfolio-services", () => ({ getPortfolioServices: vi.fn(() => ({ portfolio: [{ id: "proj-a", name: "Project A", repo: "acme/proj-a", defaultBranch: "main", sessionPrefix: "proj-a", source: "config", enabled: true, pinned: false, lastSeenAt: null, degraded: false, degradedReason: null }] })) }));
vi.mock("@composio/ao-core", () => ({ findConfigFile: vi.fn(() => null), readOriginRemoteUrl: vi.fn(() => null), parseRepoUrl: vi.fn(() => ({ owner: "acme", repo: "my-repo", cloneUrl: "https://github.com/acme/my-repo.git" })), generateConfigFromUrl: vi.fn(() => ({ projects: { "my-repo": {} } })), configToYaml: vi.fn(() => "yaml"), sanitizeProjectId: vi.fn((n: string) => n.toLowerCase().replace(/\s+/g, "-")), generateOrchestratorPrompt: vi.fn(() => "prompt") }));
vi.mock("@/lib/api-schemas", async () => { const { z } = await import("zod"); return { RegisterProjectSchema: z.object({ path: z.string().min(1), name: z.string().optional(), configProjectKey: z.string().optional() }) }; });
vi.mock("@/lib/local-project-config", () => ({ buildFlatLocalConfig: vi.fn(() => ({})), extractFlatLocalConfig: vi.fn(() => ({})) }));
vi.mock("@/lib/path-security", () => ({ assertPathWithinHome: vi.fn(async (p: string) => p) }));
vi.mock("@/lib/project-registration", () => ({ registerAndResolveProject: vi.fn((_d: string, opts?: { displayName?: string }) => ({ id: "my-repo", name: opts?.displayName ?? "my-repo" })) }));
vi.mock("@/lib/legacy-config-migration", () => ({ migrateLegacyConfigForPortfolioRegistration: vi.fn(() => ({ migrated: false })) }));
vi.mock("@/lib/services", () => ({ getServices: vi.fn(async () => ({ config: { projects: { "my-repo": { name: "my-repo", repo: "acme/my-repo", path: "/tmp/my-repo", defaultBranch: "main", sessionPrefix: "my-repo", scm: { plugin: "github" } } } }, sessionManager: { spawnOrchestrator: vi.fn(async () => ({ id: "orch-1", projectId: "my-repo" })) } })) }));

import { GET, POST } from "../route";
const mockExistsSync = vi.mocked(existsSync);
function makeRequest(url: string, init?: RequestInit): NextRequest { return new NextRequest(new URL(url, "http://localhost:3000"), init as ConstructorParameters<typeof NextRequest>[1]); }

beforeEach(() => { vi.clearAllMocks(); mockExistsSync.mockReturnValue(false); mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" }); });

describe("GET /api/projects", () => {
  it("returns projects for default scope", async () => {
    const res = await GET(makeRequest("/api/projects"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projects).toHaveLength(2);
  });

  it("returns portfolio-scoped data", async () => {
    const res = await GET(makeRequest("/api/projects?scope=portfolio"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projects[0].id).toBe("proj-a");
  });

  it("returns 500 on error", async () => {
    mockGetAllProjects.mockImplementationOnce(() => { throw new Error("broken"); });
    const res = await GET(makeRequest("/api/projects"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/projects", () => {
  it("returns 400 for missing path", async () => {
    const res = await POST(makeRequest("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }));
    expect(res.status).toBe(400);
  });

  it("returns 500 when path security fails", async () => {
    const { assertPathWithinHome } = await import("@/lib/path-security");
    (assertPathWithinHome as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("outside"));
    const res = await POST(makeRequest("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "/etc/passwd" }) }));
    expect(res.status).toBe(500);
  });

  it("returns 400 for empty path", async () => {
    const res = await POST(makeRequest("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "" }) }));
    expect(res.status).toBe(400);
  });
});
