import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockExecFileAsync, mockExistsSync, mockWriteFile, mockReadFileSync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockExistsSync: vi.fn(() => false),
  mockWriteFile: vi.fn(async () => {}),
  mockReadFileSync: vi.fn(() => "yaml: content"),
}));

vi.mock("node:child_process", () => {
  const f = Object.assign(
    (...args: unknown[]) => { const cb = args[args.length - 1]; if (typeof cb === "function") { mockExecFileAsync(...args.slice(0, -1)).then((r: unknown) => (cb as (e: null, r: unknown) => void)(null, r)).catch((e: unknown) => (cb as (e: unknown) => void)(e)); } },
    { __promisify__: mockExecFileAsync },
  );
  return { execFile: f, default: { execFile: f } };
});

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync },
}));

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  readFile: vi.fn(async () => "yaml: content"),
  default: { writeFile: mockWriteFile, readFile: vi.fn(async () => "yaml: content") },
}));

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

  it("registers project when local config already exists", async () => {
    // existsSync: first call for hasLocalConfigFile("agent-orchestrator.yaml") -> true
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith("agent-orchestrator.yaml")) return true;
      return false;
    });

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/my-repo" }),
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project).toBeDefined();
    expect(data.project.id).toBe("my-repo");

    const { migrateLegacyConfigForPortfolioRegistration } = await import("@/lib/legacy-config-migration");
    expect(migrateLegacyConfigForPortfolioRegistration).toHaveBeenCalled();
  });

  it("registers project with legacy migration providing configProjectKey", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith("agent-orchestrator.yaml")) return true;
      return false;
    });

    const { migrateLegacyConfigForPortfolioRegistration } = await import("@/lib/legacy-config-migration");
    (migrateLegacyConfigForPortfolioRegistration as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      migrated: true,
      configProjectKey: "legacy-key",
    });

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/my-repo" }),
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project.id).toBe("my-repo");
  });

  it("auto-generates config for non-git directory (no .git)", async () => {
    // All existsSync calls return false (no config file, no .git dir)
    mockExistsSync.mockReturnValue(false);

    const { buildFlatLocalConfig } = await import("@/lib/local-project-config");
    const { configToYaml } = await import("@composio/ao-core");

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/new-project", name: "New Project" }),
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project).toBeDefined();

    // Should have called ensureGitRepo (git init)
    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["init", "-b", "main"], expect.objectContaining({ cwd: "/tmp/new-project" }));

    // Should have written config file
    expect(mockWriteFile).toHaveBeenCalled();
    expect(buildFlatLocalConfig).toHaveBeenCalled();
    expect(configToYaml).toHaveBeenCalled();
  });

  it("falls back to git init without -b flag when first attempt fails", async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileAsync.mockRejectedValueOnce(new Error("old git"));
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" }); // git init
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" }); // git branch -M main

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/old-git-project" }),
    }));

    expect(res.status).toBe(200);
    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["init"], expect.objectContaining({ cwd: "/tmp/old-git-project" }));
    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["branch", "-M", "main"], expect.objectContaining({ cwd: "/tmp/old-git-project" }));
  });

  it("auto-generates config for git repo without remote origin", async () => {
    // .git exists but no config file
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith(".git")) return true;
      return false;
    });

    const { readOriginRemoteUrl } = await import("@composio/ao-core");
    (readOriginRemoteUrl as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/local-repo", name: "Local Repo" }),
    }));

    expect(res.status).toBe(200);
    expect(mockWriteFile).toHaveBeenCalled();
    // Should NOT have called git init since .git exists
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("auto-generates config from git remote URL", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith(".git")) return true;
      return false;
    });

    const { readOriginRemoteUrl, parseRepoUrl, generateConfigFromUrl } = await import("@composio/ao-core");
    (readOriginRemoteUrl as ReturnType<typeof vi.fn>).mockReturnValueOnce("https://github.com/acme/my-repo.git");
    (parseRepoUrl as ReturnType<typeof vi.fn>).mockReturnValueOnce({ owner: "acme", repo: "my-repo", cloneUrl: "https://github.com/acme/my-repo.git" });
    (generateConfigFromUrl as ReturnType<typeof vi.fn>).mockReturnValueOnce({ projects: { "my-repo": {} } });

    const { extractFlatLocalConfig } = await import("@/lib/local-project-config");

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/remote-repo" }),
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project.id).toBe("my-repo");

    expect(extractFlatLocalConfig).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("returns 400 when parseRepoUrl fails", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith(".git")) return true;
      return false;
    });

    const { readOriginRemoteUrl, parseRepoUrl } = await import("@composio/ao-core");
    (readOriginRemoteUrl as ReturnType<typeof vi.fn>).mockReturnValueOnce("not-a-valid-url");
    (parseRepoUrl as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error("bad url"); });

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/bad-remote" }),
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Could not parse the git remote URL");
  });

  it("returns 500 when writeFile fails for remote-generated config", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith(".git")) return true;
      return false;
    });

    const { readOriginRemoteUrl, parseRepoUrl, generateConfigFromUrl } = await import("@composio/ao-core");
    (readOriginRemoteUrl as ReturnType<typeof vi.fn>).mockReturnValueOnce("https://github.com/acme/my-repo.git");
    (parseRepoUrl as ReturnType<typeof vi.fn>).mockReturnValueOnce({ owner: "acme", repo: "my-repo", cloneUrl: "https://github.com/acme/my-repo.git" });
    (generateConfigFromUrl as ReturnType<typeof vi.fn>).mockReturnValueOnce({ projects: { "my-repo": {} } });

    mockWriteFile.mockRejectedValueOnce(new Error("permission denied"));

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/no-write" }),
    }));

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain("Could not write config file");
  });

  it("spawns orchestrator when project config exists", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith("agent-orchestrator.yaml")) return true;
      return false;
    });

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/my-repo" }),
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.orchestrator).toBeDefined();
    expect(data.orchestrator.id).toBe("orch-1");
    expect(data.orchestrator.projectId).toBe("my-repo");
    expect(data.orchestrator.projectName).toBe("my-repo");

    const { getServices } = await import("@/lib/services");
    expect(getServices).toHaveBeenCalled();

    const { generateOrchestratorPrompt } = await import("@composio/ao-core");
    expect(generateOrchestratorPrompt).toHaveBeenCalled();
  });

  it("succeeds even when orchestrator spawn fails", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith("agent-orchestrator.yaml")) return true;
      return false;
    });

    const { getServices } = await import("@/lib/services");
    (getServices as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("spawn failed"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/my-repo" }),
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project).toBeDefined();
    expect(data.orchestrator).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("returns project without orchestrator when projectConfig is missing", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith("agent-orchestrator.yaml")) return true;
      return false;
    });

    const { getServices } = await import("@/lib/services");
    (getServices as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      config: { projects: {} },
      sessionManager: { spawnOrchestrator: vi.fn() },
    });

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/my-repo" }),
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project.id).toBe("my-repo");
    expect(data.orchestrator).toBeUndefined();
  });

  it("uses provided configProjectKey when given", async () => {
    mockExistsSync.mockReturnValue(false);

    const { registerAndResolveProject } = await import("@/lib/project-registration");

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/my-proj", configProjectKey: "custom-key" }),
    }));

    expect(res.status).toBe(200);
    expect(registerAndResolveProject).toHaveBeenCalledWith(
      "/tmp/my-proj",
      expect.objectContaining({ configProjectKey: "custom-key" }),
    );
  });

  it("passes displayName to registerAndResolveProject", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith("agent-orchestrator.yaml")) return true;
      return false;
    });

    const { registerAndResolveProject } = await import("@/lib/project-registration");

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/my-repo", name: "Custom Name" }),
    }));

    expect(res.status).toBe(200);
    expect(registerAndResolveProject).toHaveBeenCalledWith(
      "/tmp/my-repo",
      expect.objectContaining({ displayName: "Custom Name" }),
    );
  });

  it("ignores parent config and auto-generates when no local config", async () => {
    // No local config files, has .git directory
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.endsWith(".git")) return true;
      return false;
    });

    const { findConfigFile, readOriginRemoteUrl } = await import("@composio/ao-core");
    (findConfigFile as ReturnType<typeof vi.fn>).mockReturnValueOnce("/parent/agent-orchestrator.yaml");
    (readOriginRemoteUrl as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

    const res = await POST(makeRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/sub-project" }),
    }));

    expect(res.status).toBe(200);
    // Should auto-generate a flat local config, not use the parent config
    const { buildFlatLocalConfig } = await import("@/lib/local-project-config");
    expect(buildFlatLocalConfig).toHaveBeenCalled();
  });
});

describe("GET /api/projects — portfolio sanitization", () => {
  it("strips sensitive fields from portfolio projects", async () => {
    const res = await GET(makeRequest("/api/projects?scope=portfolio"));
    expect(res.status).toBe(200);
    const data = await res.json();
    const proj = data.projects[0];
    // Should include these fields
    expect(proj).toHaveProperty("id");
    expect(proj).toHaveProperty("name");
    expect(proj).toHaveProperty("repo");
    expect(proj).toHaveProperty("defaultBranch");
    expect(proj).toHaveProperty("sessionPrefix");
    expect(proj).toHaveProperty("source");
    expect(proj).toHaveProperty("enabled");
    expect(proj).toHaveProperty("pinned");
    expect(proj).toHaveProperty("lastSeenAt");
    expect(proj).toHaveProperty("degraded");
    expect(proj).toHaveProperty("degradedReason");
    // Should NOT include path or other sensitive data
    expect(proj).not.toHaveProperty("path");
    expect(proj).not.toHaveProperty("configPath");
  });

  it("returns 500 when getPortfolioServices throws", async () => {
    const portfolioMod = await import("@/lib/portfolio-services");
    (portfolioMod.getPortfolioServices as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error("portfolio broken"); });

    const res = await GET(makeRequest("/api/projects?scope=portfolio"));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("portfolio broken");
  });

  it("returns error message string when error is not an Error instance", async () => {
    mockGetAllProjects.mockImplementationOnce(() => { throw "string error"; });
    const res = await GET(makeRequest("/api/projects"));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Failed to load projects");
  });
});
