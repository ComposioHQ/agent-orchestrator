import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  getProjectDir,
  loadGlobalConfig,
  registerProjectInGlobalConfig,
} from "@aoagents/ao-core";

const invalidatePortfolioServicesCache = vi.fn();
const getServices = vi.fn();

vi.mock("@/lib/services", () => ({
  invalidatePortfolioServicesCache,
  getServices,
}));

function makeRequest(method: string, body?: Record<string, unknown>, projectId = "demo"): NextRequest {
  return new NextRequest(`http://localhost:3000/api/projects/${projectId}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { "Content-Type": "application/json" } : undefined,
  });
}

describe("/api/projects/[id]", () => {
  let oldGlobalConfig: string | undefined;
  let oldHome: string | undefined;
  let tempRoot: string;
  let configPath: string;

  beforeEach(() => {
    vi.resetModules();
    invalidatePortfolioServicesCache.mockReset();
    getServices.mockReset();
    getServices.mockResolvedValue({
      registry: {
        get: vi.fn().mockReturnValue(null),
      },
    });
    oldGlobalConfig = process.env["AO_GLOBAL_CONFIG"];
    oldHome = process.env["HOME"];
    tempRoot = mkdtempSync(path.join(tmpdir(), "ao-project-detail-route-"));
    configPath = path.join(tempRoot, "config.yaml");
    process.env["AO_GLOBAL_CONFIG"] = configPath;
    process.env["HOME"] = tempRoot;
  });

  afterEach(() => {
    if (oldGlobalConfig === undefined) {
      delete process.env["AO_GLOBAL_CONFIG"];
    } else {
      process.env["AO_GLOBAL_CONFIG"] = oldGlobalConfig;
    }
    if (oldHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = oldHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("PATCH writes behavior fields to the local YAML", async () => {
    const repoDir = path.join(tempRoot, "demo");
    mkdirSync(repoDir, { recursive: true });
    const effectiveId = registerProjectInGlobalConfig("demo", "Demo", repoDir);

    const { PATCH } = await import("@/app/api/projects/[id]/route");
    const response = await PATCH(makeRequest("PATCH", { agent: "codex", runtime: "tmux" }, effectiveId), {
      params: Promise.resolve({ id: effectiveId }),
    });

    expect(response.status).toBe(200);
    const localYaml = readFileSync(path.join(repoDir, "agent-orchestrator.yaml"), "utf-8");
    expect(localYaml).toContain("agent: codex");
    expect(localYaml).toContain("runtime: tmux");
    expect(invalidatePortfolioServicesCache).toHaveBeenCalledTimes(1);
  });

  it("PATCH preserves untouched nested tracker and scm config", async () => {
    const repoDir = path.join(tempRoot, "demo-nested");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      path.join(repoDir, "agent-orchestrator.yaml"),
      [
        "tracker:",
        '  plugin: "linear"',
        '  team: "growth"',
        "scm:",
        '  plugin: "github"',
        "  webhook:",
        "    enabled: true",
        '    path: "/hooks/github"',
        "",
      ].join("\n"),
    );
    const effectiveId = registerProjectInGlobalConfig("demo", "Demo", repoDir);

    const { PATCH } = await import("@/app/api/projects/[id]/route");
    const response = await PATCH(makeRequest("PATCH", { agent: "codex" }, effectiveId), {
      params: Promise.resolve({ id: effectiveId }),
    });

    expect(response.status).toBe(200);
    const localYaml = readFileSync(path.join(repoDir, "agent-orchestrator.yaml"), "utf-8");
    expect(localYaml).toContain("plugin: linear");
    expect(localYaml).toContain("team: growth");
    expect(localYaml).toContain("plugin: github");
    expect(localYaml).toContain("path: /hooks/github");
    expect(localYaml).toContain("agent: codex");
  });

  it("PATCH updates an existing .yml config in place", async () => {
    const repoDir = path.join(tempRoot, "demo-yml");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      path.join(repoDir, "agent-orchestrator.yml"),
      [
        'agent: "claude-code"',
        'runtime: "tmux"',
        "",
      ].join("\n"),
    );
    const effectiveId = registerProjectInGlobalConfig("demo", "Demo", repoDir);

    const { PATCH } = await import("@/app/api/projects/[id]/route");
    const response = await PATCH(makeRequest("PATCH", { runtime: "docker" }, effectiveId), {
      params: Promise.resolve({ id: effectiveId }),
    });

    expect(response.status).toBe(200);
    expect(readFileSync(path.join(repoDir, "agent-orchestrator.yml"), "utf-8")).toContain(
      "runtime: docker",
    );
    expect(existsSync(path.join(repoDir, "agent-orchestrator.yaml"))).toBe(false);
  });

  it("GET falls back to the repo-local config when no global registry exists yet", async () => {
    const repoDir = path.join(tempRoot, "demo-local");
    const localConfigPath = path.join(repoDir, "agent-orchestrator.yaml");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      localConfigPath,
      [
        "projects:",
        "  demo:",
        "    name: Demo",
        `    path: ${repoDir}`,
        "    defaultBranch: main",
        "    agent: codex",
        "    runtime: tmux",
        "",
      ].join("\n"),
    );
    process.env["AO_CONFIG_PATH"] = localConfigPath;

    const { GET } = await import("@/app/api/projects/[id]/route");
    const response = await GET(makeRequest("GET"), {
      params: Promise.resolve({ id: "demo" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      project: expect.objectContaining({
        id: "demo",
        name: "Demo",
        path: repoDir,
        agent: "codex",
        runtime: "tmux",
      }),
    });
  });

  it("PATCH rejects identity field updates with 400", async () => {
    const repoDir = path.join(tempRoot, "demo");
    mkdirSync(repoDir, { recursive: true });
    const effectiveId = registerProjectInGlobalConfig("demo", "Demo", repoDir);

    const { PATCH } = await import("@/app/api/projects/[id]/route");
    const response = await PATCH(makeRequest("PATCH", { path: "/x" }, effectiveId), {
      params: Promise.resolve({ id: effectiveId }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Identity fields are frozen: path",
    });
  });

  it("GET returns a degraded payload for degraded projects", async () => {
    const repoDir = path.join(tempRoot, "broken");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, "agent-orchestrator.yaml"), "agent: [broken\n");
    const effectiveId = registerProjectInGlobalConfig("broken", "Broken", repoDir);

    const { GET } = await import("@/app/api/projects/[id]/route");
    const response = await GET(makeRequest("GET", undefined, effectiveId), {
      params: Promise.resolve({ id: effectiveId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      error: expect.any(String),
      projectId: effectiveId,
      degraded: true,
      project: {
        id: effectiveId,
        name: expect.any(String),
        path: expect.stringContaining(path.sep + "broken"),
        resolveError: expect.any(String),
      },
    });
  });

  it("PATCH and PUT return useful degraded errors instead of 500s", async () => {
    const repoDir = path.join(tempRoot, "broken");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, "agent-orchestrator.yaml"), "agent: [broken\n");
    const effectiveId = registerProjectInGlobalConfig("broken", "Broken", repoDir);

    const { PATCH, PUT } = await import("@/app/api/projects/[id]/route");

    const patchResponse = await PATCH(makeRequest("PATCH", { agent: "codex" }, effectiveId), {
      params: Promise.resolve({ id: effectiveId }),
    });
    const putResponse = await PUT(makeRequest("PUT", { runtime: "tmux" }, effectiveId), {
      params: Promise.resolve({ id: effectiveId }),
    });

    expect(patchResponse.status).toBe(409);
    expect(putResponse.status).toBe(409);
    await expect(patchResponse.json()).resolves.toEqual({
      error: expect.any(String),
      projectId: effectiveId,
      degraded: true,
      project: expect.objectContaining({ id: effectiveId }),
    });
    await expect(putResponse.json()).resolves.toEqual({
      error: expect.any(String),
      projectId: effectiveId,
      degraded: true,
      project: expect.objectContaining({ id: effectiveId }),
    });
  });

  it("DELETE removes the registry entry and AO storage but preserves the repository path", async () => {
    const repoDir = path.join(tempRoot, "demo");
    mkdirSync(repoDir, { recursive: true });
    const effectiveId = registerProjectInGlobalConfig("demo", "Demo", repoDir);

     const destroy = vi.fn().mockResolvedValue(undefined);
     const list = vi.fn().mockResolvedValue([
       { path: path.join(tempRoot, "managed-worktrees", effectiveId, `${effectiveId}-orchestrator-1`) },
     ]);
     getServices.mockResolvedValue({
       registry: {
         get: vi.fn().mockReturnValue({ list, destroy }),
       },
     });

    const projectDir = getProjectDir(effectiveId);
    mkdirSync(projectDir, { recursive: true });

    const { DELETE } = await import("@/app/api/projects/[id]/route");
    const response = await DELETE(makeRequest("DELETE", undefined, effectiveId), {
      params: Promise.resolve({ id: effectiveId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      projectId: effectiveId,
      removedStorageDir: true,
    });
    expect(loadGlobalConfig(configPath)?.projects[effectiveId]).toBeUndefined();
    expect(existsSync(projectDir)).toBe(false);
    expect(existsSync(repoDir)).toBe(true);
    expect(list).toHaveBeenCalledWith(effectiveId);
    expect(destroy).toHaveBeenCalledWith(
      path.join(tempRoot, "managed-worktrees", effectiveId, `${effectiveId}-orchestrator-1`),
    );
  });

  it("POST repairs wrapped local configs for degraded projects", async () => {
    const repoDir = path.join(tempRoot, "broken");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      path.join(repoDir, "agent-orchestrator.yaml"),
      [
        "projects:",
        "  broken:",
        `    path: ${repoDir}`,
        "    agent: codex",
        "    runtime: tmux",
        "",
      ].join("\n"),
    );
    const effectiveId = registerProjectInGlobalConfig("broken", "Broken", repoDir);

    const { POST } = await import("@/app/api/projects/[id]/route");
    const response = await POST(makeRequest("POST", undefined, effectiveId), {
      params: Promise.resolve({ id: effectiveId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      repaired: true,
      projectId: effectiveId,
    });
    expect(readFileSync(path.join(repoDir, "agent-orchestrator.yaml"), "utf-8")).toContain("agent: codex");
  });

  it("POST repairs wrapped local .yml configs in place", async () => {
    const repoDir = path.join(tempRoot, "broken-yml");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      path.join(repoDir, "agent-orchestrator.yml"),
      [
        "projects:",
        "  broken:",
        `    path: ${repoDir}`,
        "    agent: codex",
        "    runtime: tmux",
        "",
      ].join("\n"),
    );
    const effectiveId = registerProjectInGlobalConfig("broken", "Broken", repoDir);

    const { POST } = await import("@/app/api/projects/[id]/route");
    const response = await POST(makeRequest("POST", undefined, effectiveId), {
      params: Promise.resolve({ id: effectiveId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      repaired: true,
      projectId: effectiveId,
    });
    expect(readFileSync(path.join(repoDir, "agent-orchestrator.yml"), "utf-8")).toContain("agent: codex");
    expect(existsSync(path.join(repoDir, "agent-orchestrator.yaml"))).toBe(false);
  });
});
