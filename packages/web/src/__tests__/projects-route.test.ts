import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { deriveStorageKey, loadGlobalConfig, registerProjectInGlobalConfig } from "@aoagents/ao-core";

const invalidatePortfolioServicesCache = vi.fn();

vi.mock("@/lib/services", () => ({
  invalidatePortfolioServicesCache,
}));

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/projects", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/projects", () => {
  let oldGlobalConfig: string | undefined;
  let tempRoot: string;
  let configPath: string;

  beforeEach(() => {
    vi.resetModules();
    invalidatePortfolioServicesCache.mockReset();
    oldGlobalConfig = process.env["AO_GLOBAL_CONFIG"];
    tempRoot = mkdtempSync(path.join(tmpdir(), "ao-projects-route-"));
    configPath = path.join(tempRoot, "config.yaml");
    process.env["AO_GLOBAL_CONFIG"] = configPath;
  });

  afterEach(() => {
    if (oldGlobalConfig === undefined) {
      delete process.env["AO_GLOBAL_CONFIG"];
    } else {
      process.env["AO_GLOBAL_CONFIG"] = oldGlobalConfig;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("returns projects as an array and includes degraded entries with resolveError", async () => {
    const healthyDir = path.join(tempRoot, "healthy");
    const brokenDir = path.join(tempRoot, "broken");
    mkdirSync(healthyDir, { recursive: true });
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "agent-orchestrator.yaml"), "agent: [broken\n");

    registerProjectInGlobalConfig("healthy", "Healthy", healthyDir);
    registerProjectInGlobalConfig("broken", "Broken", brokenDir);

    const { GET } = await import("@/app/api/projects/route");
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projects: expect.arrayContaining([
        expect.objectContaining({ id: "healthy", name: "Healthy" }),
        expect.objectContaining({
          id: "broken",
          name: "broken",
          resolveError: expect.any(String),
        }),
      ]),
    });
  });

  it("stores the Phase 1a-derived storage key and invalidates services cache", async () => {
    const repoDir = path.join(tempRoot, "demo");
    mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    writeFileSync(
      path.join(repoDir, ".git", "config"),
      '[remote "origin"]\n  url = git@github.com:acme/demo.git\n',
    );

    const { POST } = await import("@/app/api/projects/route");
    const response = await POST(
      makeRequest({ projectId: "demo", name: "Demo", path: repoDir }),
    );

    expect(response.status).toBe(201);
    expect(invalidatePortfolioServicesCache).toHaveBeenCalledTimes(1);

    expect(readFileSync(configPath, "utf-8").length).toBeGreaterThan(0);
    const saved = loadGlobalConfig(configPath);
    expect(saved?.projects.demo?.storageKey).toBe(
      deriveStorageKey({
        originUrl: "https://github.com/acme/demo",
        gitRoot: repoDir,
        projectPath: repoDir,
      }),
    );
  });

  it("returns 409 with collision metadata when another project owns the storage key", async () => {
    const repoDir = path.join(tempRoot, "demo");
    const aliasDir = path.join(tempRoot, "demo-alias");
    mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    writeFileSync(
      path.join(repoDir, ".git", "config"),
      '[remote "origin"]\n  url = git@github.com:acme/demo.git\n',
    );
    symlinkSync(repoDir, aliasDir);

    const { POST } = await import("@/app/api/projects/route");
    await POST(makeRequest({ projectId: "existing-app", name: "Existing", path: repoDir }));

    const response = await POST(
      makeRequest({ projectId: "second-app", name: "Second", path: aliasDir }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      existingProjectId: "existing-app",
      suggestion: "register-as-second",
    });
  });
});

describe("POST /api/projects/reload", () => {
  let oldGlobalConfig: string | undefined;
  let tempRoot: string;
  let configPath: string;

  beforeEach(() => {
    vi.resetModules();
    invalidatePortfolioServicesCache.mockReset();
    oldGlobalConfig = process.env["AO_GLOBAL_CONFIG"];
    tempRoot = mkdtempSync(path.join(tmpdir(), "ao-projects-reload-"));
    configPath = path.join(tempRoot, "config.yaml");
    process.env["AO_GLOBAL_CONFIG"] = configPath;
  });

  afterEach(() => {
    if (oldGlobalConfig === undefined) {
      delete process.env["AO_GLOBAL_CONFIG"];
    } else {
      process.env["AO_GLOBAL_CONFIG"] = oldGlobalConfig;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("returns project and degraded counts after reload", async () => {
    const healthyDir = path.join(tempRoot, "healthy");
    const brokenDir = path.join(tempRoot, "broken");
    mkdirSync(healthyDir, { recursive: true });
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "agent-orchestrator.yaml"), "agent: [broken\n");

    registerProjectInGlobalConfig("healthy", "Healthy", healthyDir);
    registerProjectInGlobalConfig("broken", "Broken", brokenDir);

    const { POST } = await import("@/app/api/projects/reload/route");
    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reloaded: true,
      projectCount: 1,
      degradedCount: 1,
    });
    expect(invalidatePortfolioServicesCache).toHaveBeenCalledTimes(1);
  });
});
