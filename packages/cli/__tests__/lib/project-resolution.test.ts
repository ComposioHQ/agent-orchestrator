import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockIsHumanCaller, mockPromptSelect } = vi.hoisted(() => ({
  mockIsHumanCaller: vi.fn().mockReturnValue(false),
  mockPromptSelect: vi.fn(),
}));

vi.mock("../../src/lib/caller-context.js", () => ({
  isHumanCaller: mockIsHumanCaller,
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptSelect: mockPromptSelect,
}));

import {
  findProjectForDirectory,
  resolveProject,
  resolveProjectByRepo,
} from "../../src/lib/project-resolution.js";
import type { OrchestratorConfig, ParsedRepoUrl } from "@aoagents/ao-core";

beforeEach(() => {
  mockIsHumanCaller.mockReset().mockReturnValue(false);
  mockPromptSelect.mockReset();
});

function cfg(projects: Record<string, { path: string; repo?: string; name?: string }>): OrchestratorConfig {
  return { configPath: "/x.yaml", projects } as unknown as OrchestratorConfig;
}

describe("findProjectForDirectory", () => {
  it("returns a project when cwd is inside a project subdirectory", () => {
    const projectId = findProjectForDirectory(
      {
        frontend: { path: "/repos/frontend" },
        backend: { path: "/repos/backend" },
      },
      "/repos/backend/packages/api",
    );

    expect(projectId).toBe("backend");
  });

  it("prefers the deepest matching project path", () => {
    const projectId = findProjectForDirectory(
      {
        monorepo: { path: "/repos/mono" },
        docs: { path: "/repos/mono/docs" },
      },
      "/repos/mono/docs/guides",
    );

    expect(projectId).toBe("docs");
  });

  it("returns null when cwd is outside every configured project", () => {
    const projectId = findProjectForDirectory(
      {
        frontend: { path: "/repos/frontend" },
      },
      "/repos/backend",
    );

    expect(projectId).toBeNull();
  });
});

describe("resolveProject", () => {
  it("throws when no projects are configured", async () => {
    await expect(resolveProject(cfg({}))).rejects.toThrow(/No projects configured/);
  });

  it("returns the explicitly requested project", async () => {
    const { projectId } = await resolveProject(
      cfg({ a: { path: "/a" }, b: { path: "/b" } }),
      "a",
    );
    expect(projectId).toBe("a");
  });

  it("errors with a helpful list when the requested project is missing", async () => {
    await expect(
      resolveProject(cfg({ a: { path: "/a" } }), "missing"),
    ).rejects.toThrow(/not found.*a/s);
  });

  it("auto-selects the single configured project when none is requested", async () => {
    const { projectId } = await resolveProject(cfg({ only: { path: "/only" } }));
    expect(projectId).toBe("only");
  });

  it("errors when multiple projects exist and the caller is non-human", async () => {
    mockIsHumanCaller.mockReturnValue(false);
    await expect(
      resolveProject(cfg({ a: { path: "/a" }, b: { path: "/b" } }), undefined, "stop"),
    ).rejects.toThrow(/Multiple projects configured.*ao stop a/s);
  });

  it("prompts the user when multiple projects exist and caller is human", async () => {
    mockIsHumanCaller.mockReturnValue(true);
    mockPromptSelect.mockResolvedValue("b");
    const { projectId } = await resolveProject(
      cfg({ a: { path: "/a" }, b: { path: "/b" } }),
    );
    expect(projectId).toBe("b");
    expect(mockPromptSelect).toHaveBeenCalled();
  });
});

describe("resolveProjectByRepo", () => {
  it("returns the project whose repo matches the parsed URL", async () => {
    const parsed = { ownerRepo: "foo/bar" } as ParsedRepoUrl;
    const { projectId } = await resolveProjectByRepo(
      cfg({ one: { path: "/one", repo: "foo/bar" }, two: { path: "/two", repo: "x/y" } }),
      parsed,
    );
    expect(projectId).toBe("one");
  });

  it("falls back to resolveProject when no repo field matches", async () => {
    const parsed = { ownerRepo: "nope/none" } as ParsedRepoUrl;
    const { projectId } = await resolveProjectByRepo(
      cfg({ only: { path: "/only" } }),
      parsed,
    );
    expect(projectId).toBe("only");
  });
});
